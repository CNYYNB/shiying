'use strict'
/**
 * 下载画质（"该高度及以下最好的，没有就取最接近的更高的"），移植自 Quality.kt。
 * 取值："best" "1080"(默认) "720" "480" "360" "worst"，或具体高度。
 */
const DEFAULT = '1080'
const keys = ['best', '1080', '720', '480', '360', 'worst']

function label(q) { return q === 'best' ? '最高画质' : q === 'worst' ? '省流量（最低画质）' : `${q}p` }
function menuLabel(q) {
  return { best: '最高画质（可能是 2K / 4K，文件很大）', 1080: '1080p（推荐）', worst: '省流量（最低画质）' }[q] || `${q}p`
}
function normalize(q) { return q != null && (keys.includes(String(q)) || parseInt(q, 10) > 0) && /^(best|worst|\d+)$/.test(String(q)) ? String(q) : DEFAULT }

/** 从可用高度里挑一个（0 = 未知，忽略）。都未知返回 0 */
function pick(available, q) {
  const hs = [...new Set([...available].filter(h => h > 0))].sort((a, b) => a - b)
  if (!hs.length) return 0
  const k = normalize(q)
  if (k === 'best') return hs[hs.length - 1]
  if (k === 'worst') return hs[0]
  const cap = parseInt(k, 10)
  const below = hs.filter(h => h <= cap)
  return below.length ? below[below.length - 1] : hs[0]
}

/** 原生下载候选重排：选中画质的地址放前面（保持原顺序），其余作为失败时的备用 */
function order(urls, heights, q) {
  const h = pick(urls.map(u => heights[u]).filter(x => x != null), q)
  if (h === 0) return urls
  return [...urls.filter(u => heights[u] === h), ...urls.filter(u => heights[u] !== h)]
}

function shownHeight(p, q) { return pick(Object.values(p.heights || {}), q) || p.height }

/** yt-dlp 的 -S 参数 */
function sortArg(q) {
  const k = normalize(q)
  if (k === 'best') return 'res,vcodec:h264,acodec:aac,ext:mp4:m4a'
  if (k === 'worst') return '+res,+size,vcodec:h264,acodec:aac,ext:mp4:m4a'
  return `res:${k},vcodec:h264,acodec:aac,ext:mp4:m4a`
}

const num = v => (typeof v === 'number' && !Number.isNaN(v) ? v : (v != null && !Number.isNaN(Number(v)) && v !== '' ? Number(v) : 0))

/** yt-dlp info JSON 里能选的高度（短边）及大约大小（字节，0 = 未知），高到低 */
function ytdlpHeights(json) {
  let o
  try { o = typeof json === 'string' ? JSON.parse(json.substring(json.indexOf('{'), json.lastIndexOf('}') + 1)) : json } catch { return [] }
  if (!o) return []
  const target = o.entries ? (o.entries[0] || null) : o
  if (!target || !Array.isArray(target.formats)) return []
  const dur = num(target.duration)
  const size = f => num(f.filesize) > 0 ? num(f.filesize) : num(f.filesize_approx) > 0 ? num(f.filesize_approx)
    : (num(f.tbr) > 0 && dur > 0 ? Math.trunc(num(f.tbr) * 125 * dur) : 0)
  const all = target.formats.filter(f => f && typeof f === 'object')
  const audio = Math.max(0, ...all.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none').map(size))
  const best = new Map()
  for (const f of all) {
    const vc = f.vcodec || '', ac = f.acodec || ''
    if (vc === 'none' || String(f.format_note || '').includes('storyboard') || f.ext === 'mhtml') continue
    const w = num(f.width), hh = num(f.height)
    const h = w >= 1 && w < hh ? w : hh
    if (h <= 0) continue
    let sz = size(f); if (sz > 0 && ac === 'none') sz += audio
    const prev = best.get(h)
    if (prev == null || prev === 0 || (sz >= 1 && sz < prev)) best.set(h, sz)
  }
  return [...best.entries()].sort((a, b) => b[0] - a[0])
}

module.exports = { DEFAULT, keys, label, menuLabel, normalize, pick, order, shownHeight, sortArg, ytdlpHeights }
