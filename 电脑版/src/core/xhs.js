'use strict'
/**
 * 小红书原生解析（移植自 Xhs.kt）：xhslink 短链 → 笔记页（www.xiaohongshu.com/explore/{id}?xsec_token=…，token 必须有）
 * → window.__INITIAL_STATE__（电脑版 note.noteDetailMap[id].note，手机版 noteData.data.noteData）。
 * - 视频：sns-video-bd.xhscdn.com/{consumer.originVideoKey}（原始上传），然后 stream.h264/h265 masterUrl。
 * - 图片：从 urlDefault 取图片 token → sns-img-bd.xhscdn.com/{token} / ci.xiaohongshu.com/{token}（原图），
 *   页面的 urlDefault 兜底。实况图：imageList[].stream.h264[].masterUrl。
 */
const Links = require('./links')
const Net = require('./net')
const { makePost, UserError, PostUnavailable } = require('./post')
const { Platform } = require('./platform')

const NOTE_ID_RE = /\/(?:explore|discovery\/item|item|note)\/([0-9a-f]{24})/
const STATE_RE = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/
const REFERER = 'https://www.xiaohongshu.com/'

const str = v => (v == null ? '' : String(v))
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

/** 页面里没有笔记数据（调用方可以改用 yt-dlp） */
class XhsNoData extends Error { constructor(url, why) { super(why); this.name = 'XhsNoData'; this.url = url } }

function noteId(url) { const m = NOTE_ID_RE.exec(url || ''); return m ? m[1] : null }

function secMessage(u) {
  if (u.includes('300031')) return '小红书：当前笔记暂时无法浏览（可能已删除、仅自己可见，或分享链接已失效）'
  if (u.includes('rednote.com')) return '小红书拒绝了访问：当前网络被识别为海外 IP（会跳到 rednote 国际版）。请关闭 VPN 或换国内网络后重试，或先在「登录」里登录小红书'
  return '小红书拒绝访问（安全验证/需要登录或链接已失效）。请重新「分享 → 复制链接」，或先在「登录」里登录小红书'
}

/** → {type:'ok', post} | {type:'gone', msg} | {type:'nodata', why} */
function parsePage(html, id, pageUrl) {
  const m = STATE_RE.exec(html || '')
  if (!m) return { type: 'nodata', why: '页面中没有 __INITIAL_STATE__' }
  const js = m[1].replace(/(?<=[:[,])\s*undefined(?=\s*[,}\]])/g, 'null')
  let root
  try { root = JSON.parse(js) } catch { return { type: 'nodata', why: '__INITIAL_STATE__ 解析失败' } }
  let note = null
  const map = isObj(root.note) && isObj(root.note.noteDetailMap) ? root.note.noteDetailMap : null
  if (map) {
    const ent = isObj(map[id]) ? map[id] : Object.values(map).find(isObj)
    if (ent && isObj(ent.note) && Object.keys(ent.note).length) note = ent.note
  }
  if (!note && isObj(root.noteData)) note = (isObj(root.noteData.data) && isObj(root.noteData.data.noteData) && root.noteData.data.noteData) || (isObj(root.noteData.noteData) && root.noteData.noteData) || null
  if (!note || (!str(note.noteId) && !('imageList' in note) && !('video' in note))) {
    const err = (isObj(root.note) && root.note.serverRequestInfo != null ? str(root.note.serverRequestInfo) : null) ||
      (isObj(root.noteData) && root.noteData.errorMsg != null ? str(root.noteData.errorMsg) : null)
    if (err && err.trim() && /删除|不存在|违规/.test(err)) return { type: 'gone', msg: '小红书：' + err }
    return { type: 'nodata', why: '没有笔记对象' }
  }
  const p = fromNote(note, id, pageUrl)
  return p.isImages || p.videoUrls.length ? { type: 'ok', post: p } : { type: 'nodata', why: '笔记里没有图片或视频地址' }
}

/** "http://sns-webpic-qc.xhscdn.com/202411251530/<hash>/<token>!nd_dft_wlteh_webp_3" → "<token>" */
function imageToken(u) {
  const noQuery = u.split('?')[0].split('!')[0]
  const after = noQuery.includes('://') ? noQuery.slice(noQuery.indexOf('://') + 3) : noQuery
  const parts = after.split('/')
  if (parts.length < 2) return null
  const host = parts[0]
  const rest = host.startsWith('sns-webpic') && parts.length >= 4 ? parts.slice(3) : parts.slice(1)
  const t = rest.join('/')
  return t.trim() ? t : null
}

const strs = a => (Array.isArray(a) ? a.filter(s => typeof s === 'string' && s.startsWith('http')) : [])

/** 视频流地址（好的在前）及每个的高度（短边） */
function streamUrlsH(stream) {
  if (!isObj(stream)) return []
  const all = []
  for (const [key, hevc] of [['h264', false], ['h265', true], ['av1', true], ['h266', true]]) {
    const arr = Array.isArray(stream[key]) ? stream[key] : []
    for (const s of arr) {
      if (!isObj(s)) continue
      const urls = [str(s.masterUrl), ...strs(s.backupUrls)].filter(u => u.startsWith('http'))
      if (!urls.length) continue
      const mn = Math.min(num(s.width), num(s.height))
      all.push({ h: mn > 0 ? mn : num(s.height), hevc, urls })
    }
  }
  all.sort((a, b) => (b.h - a.h) || ((a.hevc ? 1 : 0) - (b.hevc ? 1 : 0)))
  return all.flatMap(s => s.urls.map(u => [u, s.h]))
}

function fromNote(note, id, pageUrl) {
  const nid = str(note.noteId) || id
  const video = isObj(note.video) ? note.video : null
  const isVideo = str(note.type) === 'video' || (video && isObj(video.media))
  const images = []
  if (Array.isArray(note.imageList)) for (const im of note.imageList) {
    if (!isObj(im)) continue
    const pageUrls = new Set()
    for (const k of ['urlDefault', 'url']) if (str(im[k]).startsWith('http')) pageUrls.add(str(im[k]))
    if (Array.isArray(im.infoList)) for (const i of im.infoList) if (isObj(i) && str(i.url).startsWith('http')) pageUrls.add(str(i.url))
    if (str(im.urlPre).startsWith('http')) pageUrls.add(str(im.urlPre))
    let token = null
    for (const u of pageUrls) { token = imageToken(u); if (token) break }
    const urls = new Set()
    if (token) { urls.add(`https://sns-img-bd.xhscdn.com/${token}`); urls.add(`https://ci.xiaohongshu.com/${token}?imageView2/2/w/format/jpg`) }
    for (const u of pageUrls) urls.add(u.replace(/^http:\/\//, 'https://'))
    if (!urls.size) continue
    const live = im.livePhoto === true || isObj(im.stream) ? streamUrlsH(im.stream).map(x => x[0]) : []
    images.push({ urls: [...urls], liveVideoUrls: live })
  }
  const vids = new Set(); const heights = {}
  if (isVideo && video) {
    const st = streamUrlsH(isObj(video.media) ? video.media.stream : null)
    // 原始上传至少和最好的转码一样大
    const originH = st.length ? Math.max(...st.map(x => x[1])) : 0
    const key = isObj(video.consumer) ? str(video.consumer.originVideoKey) : ''
    if (key.trim()) { const u = `https://sns-video-bd.xhscdn.com/${key}`; vids.add(u); if (originH > 0) heights[u] = originH }
    for (const [u, h] of st) { vids.add(u); if (h > 0 && heights[u] == null) heights[u] = h }
  }
  const asImages = !isVideo && images.length > 0
  const user = isObj(note.user) ? note.user : null
  const capaDur = video && isObj(video.capa) ? num(video.capa.duration) : 0
  const mediaDur = video && isObj(video.media) && isObj(video.media.video) ? num(video.media.video.duration) : 0
  const dur = capaDur > 0 ? capaDur * 1000 : (mediaDur > 0 ? mediaDur : 0)
  const lastCover = images.length ? images[0].urls[images[0].urls.length - 1] : null
  return makePost({
    id: nid, isImages: asImages,
    desc: [str(note.title), str(note.desc)].filter(s => s.trim()).join('\n'),
    author: user ? (str(user.nickname) || str(user.nickName)) : '',
    cover: lastCover,
    durationMs: asImages ? 0 : dur,
    videoUrls: asImages ? [] : [...vids],
    heights: asImages ? {} : heights,
    images: asImages ? images : [],
    source: '分享页', platform: Platform.XIAOHONGSHU, pageUrl,
    headers: { Referer: REFERER, 'User-Agent': Net.UA_DESKTOP },
  })
}

async function parse(text, log = () => {}) {
  const url = Links.findUrl(text)
  if (!url) throw new UserError('没有找到小红书链接')
  let target = url
  if (noteId(url) == null) {
    log('正在解析小红书短链接…')
    target = await Net.follow(url, Net.UA_IPHONE, u => noteId(u) != null || u.includes('/404') || u.includes('/login'))
  }
  if (target.includes('/404') || target.includes('xhs_sec_server') || (Links.host(target).endsWith('rednote.com') && noteId(target) == null)) {
    throw new UserError(secMessage(target))
  }
  const id = noteId(target)
  if (!id) throw new UserError('小红书链接没有指向笔记（可能是主页或已失效），请在小红书里点「分享 → 复制链接」')
  if (!target.includes('xsec_token')) log('链接里没有 xsec_token，小红书可能拒绝访问…')
  const pages = new Set([target.replace('://xiaohongshu.com', '://www.xiaohongshu.com'), target.replace(/\/discovery\/item\//, '/explore/')])
  let why = '页面中没有笔记数据', netErr = null, blocked = null, parsedAny = false
  for (const pageUrl of pages) for (const ua of [Net.UA_DESKTOP, Net.UA_IPHONE]) {
    log('正在读取小红书笔记…')
    let r
    try { r = await Net.fetchPage(pageUrl, ua, REFERER) } catch (e) { if (!Net.isNetError(e)) throw e; netErr = e; continue }
    if (r.finalUrl.includes('/404') || r.finalUrl.includes('xhs_sec_server') || r.finalUrl.includes('/website-login')) {
      blocked = secMessage(r.finalUrl); why = blocked; continue
    }
    parsedAny = true
    const p = parsePage(r.body, id, target)
    if (p.type === 'ok') return p.post
    if (p.type === 'gone') throw new PostUnavailable('xhs_gone', p.msg, true)
    why = p.why
  }
  if (netErr && why === '页面中没有笔记数据') throw new UserError(Net.netMessage(netErr))
  // 每次都被弹到安全页 / 404：yt-dlp 也一样，直接说明原因
  if (blocked && !parsedAny) throw new UserError(blocked)
  throw new XhsNoData(target, why)
}

module.exports = { noteId, secMessage, parsePage, imageToken, fromNote, parse, XhsNoData, REFERER }
