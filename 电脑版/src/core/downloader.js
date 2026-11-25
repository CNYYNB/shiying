'use strict'
/**
 * 原生下载（移植自 Downloader.kt）：按顺序试候选地址，校验不是错误页 / MP4 头正确，写到 .part 再改名。取消 = AbortSignal。
 * 另含：图集 / 视频的保存位置与文件名（电脑版：直接存到「下载\拾影」，图集放在同名文件夹里）。
 */
const fs = require('fs')
const path = require('path')
const { fetch } = require('undici')
const Net = require('./net')
const Links = require('./links')
const Quality = require('./quality')
const { Platform } = require('./platform')
const { UserError, Cancelled } = require('./post')

const MP4_HEADS = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']
const EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/avif': '.avif', 'video/mp4': '.mp4' }

/** 不覆盖已有文件：a.mp4 → a (2).mp4 */
function uniquePath(p) {
  if (!fs.existsSync(p)) return p
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q }
}

/**
 * 下载一个文件。urls 按顺序尝试（每个最多 2 次）。destNoExt 不含扩展名，扩展名按内容决定（视频固定 .mp4）。
 * onProgress(done, total)。返回最终路径。
 */
async function fetchOne(urls, headers, isVideo, destNoExt, { signal, onProgress = () => {} } = {}) {
  if (!urls || !urls.length) throw new UserError(isVideo ? '没有找到可下载的视频地址' : '没有找到图片地址')
  let lastErr = '下载失败'
  for (const url of urls.slice(0, 8)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Cancelled()
      let part = null
      try {
        const r = await fetch(url, {
          dispatcher: await Net.getDispatcher(url), redirect: 'follow', signal,
          headers: { 'User-Agent': headers['User-Agent'] || Net.UA_IPHONE, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...(headers.Referer ? { Referer: headers.Referer } : {}) },
        })
        if (!r.ok) { lastErr = `服务器拒绝下载（HTTP ${r.status}）`; await r.body?.cancel().catch(() => {}); break }
        const ctype = (r.headers.get('content-type') || '').toLowerCase()
        if (ctype.includes('text/') || ctype.includes('json')) { lastErr = '下载地址返回的不是媒体文件'; await r.body?.cancel().catch(() => {}); break }
        const total = Number(r.headers.get('content-length')) || 0
        if (isVideo && total > 0 && total < 20_000) { lastErr = '视频文件过小，可能已失效'; await r.body?.cancel().catch(() => {}); break }
        const reader = r.body.getReader()
        let first = await reader.read()
        if (first.done || !first.value?.length) { lastErr = '下载内容为空'; break }
        const head = Buffer.from(first.value)
        if (isVideo && head.length >= 8 && !MP4_HEADS.includes(head.toString('latin1', 4, 8))) { lastErr = '下载地址返回的不是 MP4 视频'; await reader.cancel().catch(() => {}); break }
        const ext = isVideo ? '.mp4' : (EXT[ctype.split(';')[0].trim()] || sniffExt(head) || '.jpg')
        const dest = uniquePath(destNoExt + ext)
        part = dest + '.part'
        const ws = fs.createWriteStream(part)
        let done = 0, last = 0
        const write = b => new Promise((res, rej) => ws.write(b, e => (e ? rej(e) : res())))
        try {
          let chunk = first
          while (!chunk.done) {
            if (signal?.aborted) throw new Cancelled()
            await write(chunk.value); done += chunk.value.length
            const now = Date.now(); if (now - last > 200) { last = now; onProgress(done, total) }
            chunk = await reader.read()
          }
        } finally { await new Promise(res => ws.end(res)) }
        if (signal?.aborted) throw new Cancelled()
        onProgress(done, total || done)
        if (total > 0 && done !== total) throw Object.assign(new Error(`下载不完整（${done}/${total}）`), { retry: true })
        fs.renameSync(part, dest)
        return dest
      } catch (e) {
        if (part) fs.rmSync(part, { force: true })
        if (e instanceof Cancelled || signal?.aborted) throw new Cancelled()
        if (e instanceof UserError) throw e
        lastErr = /^下载/.test(e.message) ? e.message : Net.netMessage(e)
        await Net.sleep(800 * (attempt + 1))
      }
    }
  }
  throw new UserError(lastErr)
}

function sniffExt(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg'
  if (b.toString('latin1', 1, 4) === 'PNG') return '.png'
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  if (b.toString('latin1', 0, 3) === 'GIF') return '.gif'
  if (b.toString('latin1', 4, 12).startsWith('ftypheic') || b.toString('latin1', 4, 12).startsWith('ftypmif1')) return '.heic'
  return null
}

/** 作品的文件名主体："作者-标题-ID" */
function baseNameFor(post) {
  const pf = Platform[post.platform] || Platform.DOUYIN
  return Links.fileBase(post.author, post.desc || post.title, post.id, pf.label)
}

/**
 * 下载原生解析的作品到 saveDir。视频 → saveDir/名.mp4；图集 → saveDir/名/01.jpg（实况图另存 01-实况.mp4）。
 * onProgress({ pct, done, total, text })。返回保存的文件列表。
 */
async function downloadNative(post, saveDir, quality, { signal, onProgress = () => {} } = {}) {
  const base = baseNameFor(post)
  const written = []
  try {
    if (!post.isImages) {
      const q = post.qualityOverride || quality
      const urls = Quality.order(post.videoUrls, post.heights || {}, q)
      const f = await fetchOne(urls, post.headers || {}, true, path.join(saveDir, base), {
        signal, onProgress: (d, t) => onProgress({ pct: t ? d * 100 / t : 0, done: d, total: t, text: '正在下载视频' }),
      })
      written.push(f)
      return written
    }
    const dir = uniquePath(path.join(saveDir, base))
    fs.mkdirSync(dir, { recursive: true })
    written.push(dir)
    const n = post.images.length
    const lives = post.images.filter(i => i.liveVideoUrls?.length).length
    const steps = n + lives
    let step = 0
    for (let i = 0; i < n; i++) {
      const im = post.images[i]
      const no = String(i + 1).padStart(2, '0')
      const report = (what) => (d, t) => onProgress({ pct: ((step + (t ? d / t : 0)) / steps) * 100, done: d, total: t, text: `${what}（${Math.min(step + 1, steps)}/${steps}）` })
      written.push(await fetchOne(im.urls, post.headers || {}, false, path.join(dir, no), { signal, onProgress: report('正在下载图片') }))
      step++
      if (im.liveVideoUrls?.length) {
        try { written.push(await fetchOne(im.liveVideoUrls, post.headers || {}, true, path.join(dir, `${no}-实况`), { signal, onProgress: report('正在下载实况视频') })) } catch (e) { if (e instanceof Cancelled) throw e }
        step++
      }
    }
    return written
  } catch (e) {
    // 取消或失败：删掉这次写下的文件（和安卓版 JobCleanup.rollback 一样）
    if (e instanceof Cancelled) for (const f of written.reverse()) fs.rmSync(f, { recursive: true, force: true })
    throw e
  }
}

/** yt-dlp 下载完的临时文件 → 保存目录里的正式文件名 */
function moveYtdlpFiles(files, post, saveDir) {
  const base = baseNameFor(post)
  const out = []
  files.forEach((f, i) => {
    const ext = path.extname(f) || '.mp4'
    const dest = uniquePath(path.join(saveDir, files.length > 1 ? `${base}-${String(i + 1).padStart(2, '0')}${ext}` : base + ext))
    try { fs.renameSync(f, dest) } catch { fs.copyFileSync(f, dest); fs.rmSync(f, { force: true }) } // 跨盘
    out.push(dest)
  })
  return out
}

module.exports = { fetchOne, downloadNative, moveYtdlpFiles, uniquePath, baseNameFor, sniffExt }
