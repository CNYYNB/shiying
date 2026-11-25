'use strict'
/**
 * 快手原生解析（移植自 Kuaishou.kt）：分享链接 → 手机分享页 v.m.chenzhongtech.com/fw/photo/{id}（iPhone UA）→ window.INIT_STATE。
 * 顶层键名是混淆的，但值是普通 JSON：作品就是含 photo.mainMvUrls（无水印 mp4）或图集列表的那个对象。
 * 错误形如 {"result":N,"error_msg":"…"}。
 */
const Links = require('./links')
const Net = require('./net')
const { makePost, UserError, PostUnavailable } = require('./post')
const { Platform } = require('./platform')

const ID_RE = /\/(?:short-video|fw\/photo|photo|fw\/long-video|long-video)\/([A-Za-z0-9_-]{6,40})/
const ID_PARAM_RE = /[?&](?:photoId|shareObjectId)=([A-Za-z0-9_-]{6,40})/
const STATE_RE = /window\.INIT_STATE\s*=\s*(\{[\s\S]*?\})\s*<\/script>/
const REFERER = 'https://v.m.chenzhongtech.com/'

const str = v => (v == null ? '' : String(v))
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

function idFromUrl(url) { const m = ID_RE.exec(url) || ID_PARAM_RE.exec(url); return m ? m[1] : null }

function errorText(code, msg) {
  const m = str(msg).trim()
  return m ? `快手：${m}` : `快手作品无法查看（错误码 ${code}）：可能已删除、设为私密或仅好友可见`
}

/** 解析手机分享页 → {type:'ok', post} | {type:'error', code, msg} | {type:'nodata', why} */
function parsePage(html, wantId) {
  const m = STATE_RE.exec(html || '')
  if (!m) return { type: 'nodata', why: '页面中没有 INIT_STATE' }
  let root
  try { root = JSON.parse(m[1]) } catch { return { type: 'nodata', why: 'INIT_STATE 解析失败' } }
  const photos = []; let err = null
  const walk = (o, depth) => {
    if (depth > 8) return
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return }
    if (!isObj(o)) return
    const ph = o.photo
    if (isObj(ph) && ('mainMvUrls' in ph || 'ext_params' in ph || 'photoId' in ph)) photos.push(ph)
    const res = o.result
    if (Number.isInteger(res) && res !== 1 && 'error_msg' in o && !err) err = { type: 'error', code: res, msg: str(o.error_msg) }
    for (const k of Object.keys(o)) walk(o[k], depth + 1)
  }
  walk(root, 0)
  const ph = photos.find(p => wantId != null && str(p.photoId) === wantId) || photos[0]
  if (ph) {
    const p = fromPhoto(ph, wantId)
    if (p.isImages || p.videoUrls.length) return { type: 'ok', post: p }
  }
  if (err) return err
  return { type: 'nodata', why: ph ? '作品里没有视频或图片地址' : '没有 photo 对象' }
}

function urls(a) {
  if (!Array.isArray(a)) return []
  return a.map(v => (isObj(v) ? str(v.url) : typeof v === 'string' ? v : '')).filter(s => s.startsWith('http'))
}

function fromPhoto(ph, wantId) {
  // 链接里是分享 ID（3x…），对象里的 photoId 可能是数字 ID。链接用分享 ID
  const id = (wantId && wantId.trim()) ? wantId : str(ph.photoId)
  // 图集：ext_params.atlas = {cdn:[host…], list:[path…]}（也见过 photo.atlas）
  const atlas = (isObj(ph.ext_params) && isObj(ph.ext_params.atlas) && ph.ext_params.atlas) || (isObj(ph.atlas) && ph.atlas) || null
  const images = []
  if (atlas) {
    let cdns = (Array.isArray(atlas.cdn) ? atlas.cdn : []).map(str).filter(s => s.trim())
    if (!cdns.length) cdns = ['p1.a.yximgs.com', 'p2.a.yximgs.com']
    if (Array.isArray(atlas.list)) for (const p0 of atlas.list) {
      const path = str(p0); if (!path.trim()) continue
      const u = path.startsWith('http') ? [path] : cdns.map(c => `https://${c.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
      images.push({ urls: u, liveVideoUrls: [] })
    }
  }
  const isSingle = !images.length && (ph.singlePicture === true || /PICTURE/i.test(str(ph.photoType))) && !('mainMvUrls' in ph)
  if (isSingle) { const c = urls(ph.coverUrls); if (c.length) images.push({ urls: c, liveVideoUrls: [] }) }

  // 视频：manifest 里的 mp4（高的在前，H.264 优先于 HEVC），然后 mainMvUrls
  const cands = new Set(); const reps = []
  const sets = isObj(ph.manifest) && Array.isArray(ph.manifest.adaptationSet) ? ph.manifest.adaptationSet : []
  for (const set of sets) {
    const r = set && Array.isArray(set.representation) ? set.representation : []
    for (const rep of r) {
      if (!isObj(rep)) continue
      const all = [str(rep.url), ...urls(rep.backupUrl)]
      const mp4 = all.filter(u => u.startsWith('http') && !u.includes('.m3u8') && !u.includes('/hls'))
      if (!mp4.length) continue
      const mn = Math.min(num(rep.width), num(rep.height))
      reps.push({ h: mn > 0 ? mn : num(rep.height), hevc: /hevc/i.test(str(rep.videoCodec)), urls: mp4 })
    }
  }
  const heights = {}
  reps.sort((a, b) => (b.h - a.h) || ((a.hevc ? 1 : 0) - (b.hevc ? 1 : 0)))
  for (const r of reps) for (const u of r.urls) { cands.add(u); if (r.h > 0 && heights[u] == null) heights[u] = r.h }
  const photoH = Math.min(num(ph.width), num(ph.height))
  for (const u of urls(ph.mainMvUrls)) { cands.add(u); if (photoH > 0 && heights[u] == null) heights[u] = photoH }
  const isImages = images.length > 0
  const cover = urls(ph.coverUrls)[0] || urls(ph.webpCoverUrls)[0] || null
  return makePost({
    id, isImages, desc: str(ph.caption), author: str(ph.userName),
    cover: isImages ? images[0].urls[0] : cover,
    durationMs: isImages ? 0 : num(ph.duration),
    videoUrls: isImages ? [] : [...cands],
    heights: isImages ? {} : heights,
    images, source: '分享页', platform: Platform.KUAISHOU,
    pageUrl: `https://www.kuaishou.com/short-video/${id}`,
    headers: { Referer: REFERER, 'User-Agent': Net.UA_IPHONE },
    height: Math.max(0, Math.min(num(ph.width), num(ph.height))),
  })
}

async function parse(text, log = () => {}) {
  const url = Links.findUrl(text)
  if (!url) throw new UserError('没有找到快手链接')
  let target = url
  let id = idFromUrl(url)
  if (!id) {
    log('正在解析快手短链接…')
    target = await Net.follow(url, Net.UA_IPHONE, u => idFromUrl(u) != null)
    id = idFromUrl(target)
    if (!id) throw new UserError('快手短链接没有指向作品（可能是主页、直播或已失效），请重新复制分享链接')
  }
  const pages = new Set()
  if (target.includes('/fw/photo/')) pages.add(target)
  pages.add(`https://v.m.chenzhongtech.com/fw/photo/${id}`)
  let why = '页面中没有作品数据', netErr = null
  for (let attempt = 0; attempt < 2; attempt++) for (const pageUrl of pages) {
    log(attempt === 0 ? '正在读取快手作品…' : '正在重试…')
    let html
    try { html = await Net.getText(pageUrl, Net.UA_IPHONE, REFERER) } catch (e) { if (!Net.isNetError(e)) throw e; netErr = e; continue }
    const r = parsePage(html, id)
    if (r.type === 'ok') return r.post
    if (r.type === 'error') throw new PostUnavailable(`ks_${r.code}`, errorText(r.code, r.msg), true)
    why = r.why
  }
  if (netErr) throw new UserError(Net.netMessage(netErr))
  throw new UserError(`快手没有返回作品数据（${why}）。可能需要验证或作品不可见，请稍后重试`)
}

module.exports = { idFromUrl, errorText, parsePage, fromPhoto, parse, REFERER }
