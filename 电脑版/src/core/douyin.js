'use strict'
/**
 * 抖音原生解析（无水印），移植自 Parser.kt + Extractor.resolve/fromSharePage。
 * 链接 → 作品 ID → iesdouyin 分享页（iPhone UA）→ 页面里的 window._ROUTER_DATA。
 */
const Links = require('./links')
const Net = require('./net')
const { makePost, UserError, PostUnavailable, NeedFallback } = require('./post')
const { Platform } = require('./platform')

const ROUTER_RE = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/

/** 解析分享页 HTML → {type:'item', item} | {type:'filtered', reason, notice, detail} | {type:'nodata', why} */
function parseSharePage(html) {
  const m = ROUTER_RE.exec(html || '')
  if (!m) return { type: 'nodata', why: '页面中没有 _ROUTER_DATA' }
  let root
  try { root = JSON.parse(m[1]) } catch { return { type: 'nodata', why: '_ROUTER_DATA 解析失败' } }
  const ld = root && root.loaderData
  if (!ld || typeof ld !== 'object') return { type: 'nodata', why: '没有 loaderData' }
  for (const k of Object.keys(ld)) {
    const v = ld[k]
    if (!v || typeof v !== 'object') continue
    const res = v.videoInfoRes
    if (!res || typeof res !== 'object') continue
    const list = res.item_list
    if (Array.isArray(list) && list.length && list[0] && typeof list[0] === 'object') return { type: 'item', item: list[0] }
    const f = Array.isArray(res.filter_list) ? res.filter_list[0] : null
    if (f && typeof f === 'object') return { type: 'filtered', reason: str(f.filter_reason), notice: str(f.notice), detail: str(f.detail_msg) }
    return { type: 'nodata', why: 'item_list 为空' }
  }
  return { type: 'nodata', why: '没有 videoInfoRes' }
}

const str = v => (v == null ? '' : String(v))
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** 抖音的不可见原因 → 中文。final=true：换方式重试也没用 */
function unavailable(reason, notice = '', detail = '') {
  const r = String(reason || '').toLowerCase()
  if (r === 'author_secret') return new PostUnavailable(reason, '这是私密帐号的作品，无法下载（需要关注并被对方通过）', true)
  if (r === 'system_item_not_exist' || r.includes('delete')) return new PostUnavailable(reason, '作品不存在或已被删除', true)
  if (r.includes('friend')) return new PostUnavailable(reason, '这是仅好友可见的作品，无法下载', true)
  if (r.includes('self_see')) return new PostUnavailable(reason, '作品不见了：可能已被删除、设为私密或仅好友可见，无法下载', true)
  const extra = [notice, detail].find(s => s && s.trim())
  return new PostUnavailable(reason, '作品暂时无法查看' + (extra ? '：' + extra : '') + `（${reason}）`, false)
}

function strings(a) { return Array.isArray(a) ? a.filter(s => typeof s === 'string' && s.startsWith('http')) : [] }
const firstUrl = o => strings(o && o.url_list)[0] || null

/** 把 play / playwm 接口地址改成无水印的 play 地址（可指定 ratio） */
function playUrl(u, ratio) {
  let s = u.replace('/playwm/', '/play/').replace('playwm?', 'play?')
  if (ratio != null) {
    s = /[?&]ratio=/.test(s) ? s.replace(/([?&]ratio=)[^&]*/, `$1${ratio}`) : s + (s.includes('?') ? '&' : '?') + `ratio=${ratio}`
  }
  return s
}
const isPlayApi = u => u.includes('/aweme/v1/play')

/** 一个 video 对象里所有无水印候选（好的在前，去重）+ 已知的高度 */
function videoCandidatesWithHeights(video) {
  const out = new Set(); const hs = {}
  if (!video || typeof video !== 'object') return [[], {}]
  const ratioH = u => { const m = /[?&]ratio=(\d{3,4})p/.exec(u); return m ? parseInt(m[1], 10) : 0 }
  // 1) 网页详情 JSON：bit_rate 列表，每个清晰度都有 CDN 地址
  if (Array.isArray(video.bit_rate)) {
    const qs = video.bit_rate.map(b => {
      const pa = b && b.play_addr; if (!pa) return null
      const urls = strings(pa.url_list); if (!urls.length) return null
      const mn = Math.min(num(pa.height), num(pa.width))
      const h = mn > 0 ? mn : num(pa.height)
      return { h, rate: num(b.bit_rate), h265: num(b.is_h265) === 1 || num(b.is_bytevc1) === 1, urls }
    }).filter(Boolean).sort((a, b) => (b.h - a.h) || ((a.h265 ? 1 : 0) - (b.h265 ? 1 : 0)) || (b.rate - a.rate))
    for (const q of qs) for (const u of q.urls) { const x = isPlayApi(u) ? playUrl(u, null) : u; out.add(x); if (q.h > 0 && hs[x] == null) hs[x] = q.h }
  }
  // 2) play_addr（分享页：aweme.snssdk.com/aweme/v1/playwm/?video_id=…&ratio=720p）
  const pa = video.play_addr
  const paUrls = strings(pa && pa.url_list).filter(u => !u.includes('.mp3'))
  const api = paUrls.filter(isPlayApi)
  for (const r of ['1080p', '720p', '540p']) for (const u of api) out.add(playUrl(u, r))
  for (const u of paUrls) out.add(isPlayApi(u) ? playUrl(u, null) : u)
  const uri = str(pa && pa.uri)
  if (!api.length && uri.trim() && !uri.startsWith('http')) {
    for (const r of ['1080p', '720p', '540p']) out.add(`https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=${r}&line=0`)
  }
  // 3) h264 版本
  for (const u of strings(video.play_addr_h264 && video.play_addr_h264.url_list)) out.add(isPlayApi(u) ? playUrl(u, '1080p') : u)
  for (const u of out) if (hs[u] == null) { const h = ratioH(u); if (h > 0) hs[u] = h }
  return [[...out], hs]
}
const videoCandidates = v => videoCandidatesWithHeights(v)[0]

/** 分享页 item 或网页 aweme_detail（字段相同）→ 作品 */
function fromItem(item, source) {
  const id = str(item.aweme_id) || str(item.group_id_str)
  const video = item.video && typeof item.video === 'object' ? item.video : null
  const images = []
  if (Array.isArray(item.images)) for (const im of item.images) {
    if (!im || typeof im !== 'object') continue
    // url_list = 无水印；download_url_list = 带水印（不用）。jpeg 优先于 webp
    const urls = strings(im.url_list).map((u, i) => [u, i]).sort((a, b) => ((a[0].includes('.webp') ? 1 : 0) - (b[0].includes('.webp') ? 1 : 0)) || a[1] - b[1]).map(x => x[0])
    if (!urls.length) continue
    images.push({ urls, liveVideoUrls: videoCandidates(im.video) })
  }
  const isImages = images.length > 0
  let dur = num(video && video.duration)
  if (dur >= 1 && dur <= 999) dur *= 1000 // 有的数据给的是秒
  const cover = firstUrl(video && video.origin_cover) || firstUrl(video && video.cover) || (images[0] && images[0].urls[0]) || null
  const author = str(item.author && item.author.nickname)
  const [vids, vh] = isImages ? [[], {}] : videoCandidatesWithHeights(video)
  return makePost({
    id, isImages, desc: str(item.desc), author,
    cover: isImages ? images[0].urls[0] : cover,
    durationMs: isImages ? 0 : dur,
    videoUrls: vids, heights: vh, images, source, platform: Platform.DOUYIN,
    pageUrl: `https://www.douyin.com/${isImages ? 'note' : 'video'}/${id}`,
    // 网页模式拿到的 douyinvod 地址是桌面页面请求的；分享页地址是 iPhone UA 请求的
    headers: { Referer: 'https://www.douyin.com/', 'User-Agent': source === '网页' ? Net.UA_DESKTOP : Net.UA_IPHONE },
  })
}

/** 网页 API 包装：{"aweme_detail":{…}} / {"aweme_details":[…]} / aweme_list / item_list */
function fromWebDetail(json, wantId) {
  let o; try { o = typeof json === 'string' ? JSON.parse(json) : json } catch { return null }
  if (!o) return null
  const d = o.aweme_detail || (Array.isArray(o.aweme_details) && o.aweme_details[0])
    || (Array.isArray(o.aweme_list) && o.aweme_list.find(it => it && (wantId == null || str(it.aweme_id) === wantId)))
    || (Array.isArray(o.item_list) && o.item_list[0]) || null
  if (!d || typeof d !== 'object') return null
  if (wantId != null && str(d.aweme_id) && str(d.aweme_id) !== wantId) return null
  const p = fromItem(d, '网页')
  return p.isImages || p.videoUrls.length ? p : null
}

function formatDuration(ms) {
  if (ms <= 0) return ''
  const s = Math.floor((ms + 500) / 1000)
  const p2 = n => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`
}

const isImageUrl = u => u.includes('/note/') || u.includes('/slides/') || u.includes('/gallery/')

/** 粘贴的文字 → { id, likelyImages }（需要时跟随短链接跳转） */
async function resolve(text, log = () => {}) {
  const bid = Links.bareId(text)
  if (bid) return { id: bid, likelyImages: false }
  const all = Links.allUrls(text)
  const url = all.find(Links.isDouyin) || Links.findUrl(text)
  if (!url) throw new UserError('没有找到链接。请在抖音里点「分享 → 复制链接」，再粘贴到这里')
  if (!Links.isDouyin(url)) throw new UserError('这不是抖音链接：' + Links.host(url))
  const direct = Links.idFromUrl(url)
  if (direct) return { id: direct, likelyImages: isImageUrl(url) }
  log('正在解析短链接…')
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let cur = url
      for (let hop = 0; hop < 10; hop++) {
        const r = await Net.rawRequest(cur, { ua: Net.UA_IPHONE })
        const loc = r.headers.get('location')
        if (Net.isRedirect(r.status) && loc) {
          await r.body?.cancel().catch(() => {})
          cur = new URL(loc, cur).toString()
          const id = Links.idFromUrl(cur)
          if (id) return { id, likelyImages: isImageUrl(cur) }
          continue
        }
        if (r.status === 404 || r.status >= 500) { await r.body?.cancel().catch(() => {}); throw new UserError(`短链接无效或已过期（HTTP ${r.status}），请重新复制分享链接`) }
        const body = await r.text()
        const m = /(?:\/video\/|\/note\/|\/slides\/|aweme_id=|"aweme_id":")(\d{15,21})/.exec(body)
        if (m) return { id: m[1], likelyImages: body.includes('/note/') || body.includes('/slides/') }
        throw new UserError('短链接没有指向抖音作品（可能是主页、直播或合集链接）')
      }
      throw new UserError('短链接跳转次数过多')
    } catch (e) {
      if (!Net.isNetError(e)) throw e
      lastErr = e; await Net.sleep(600 * (attempt + 1))
    }
  }
  throw new UserError(Net.netMessage(lastErr))
}

/** 读分享页。抛 PostUnavailable（明确的不可见）、NeedFallback（试网页模式）或 UserError（网络） */
async function fromSharePage(t, log = () => {}) {
  const kinds = t.likelyImages ? ['note', 'video'] : ['video', 'note']
  let lastWhy = '', filtered = null, netErr = null
  // 第一次没有 ttwid cookie 时常只返回空壳页；响应会种 cookie，马上重试通常就好
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const kind of kinds) {
      log(attempt === 0 ? '正在读取作品信息…' : `正在重试（${attempt + 1}/3）…`)
      let html
      try { html = await Net.getText(`https://www.iesdouyin.com/share/${kind}/${t.id}/`) } catch (e) {
        if (!Net.isNetError(e)) throw e
        netErr = e; lastWhy = Net.netMessage(e); continue
      }
      const s = parseSharePage(html)
      if (s.type === 'item') {
        const p = fromItem(s.item, '分享页')
        if (p.isImages || p.videoUrls.length) return p
        lastWhy = '作品数据里没有视频地址'
      } else if (s.type === 'filtered') {
        const u = unavailable(s.reason, s.notice, s.detail)
        if (u.final) throw u
        filtered = u; lastWhy = u.message || s.reason
      } else lastWhy = s.why
    }
    if (filtered) break
    await Net.sleep(500 * (attempt + 1))
  }
  if (netErr && lastWhy === Net.netMessage(netErr)) throw new UserError(lastWhy)
  throw new NeedFallback(t.id, t.likelyImages, lastWhy, filtered)
}

module.exports = { parseSharePage, unavailable, playUrl, videoCandidates, videoCandidatesWithHeights, fromItem, fromWebDetail, formatDuration, resolve, fromSharePage }
