'use strict'
/**
 * 解析引擎组件（yt-dlp、ffmpeg、Deno）：首次运行下载到 数据目录/bin（Windows：%APPDATA%\拾影\bin；
 * macOS：~/Library/Application Support/拾影/bin），多镜像、带进度、可取消、校验 sha256。
 * 不依赖 Electron（Linux 上也能跑，方便测试）。
 *
 * 来源（按顺序尝试）：
 *  - yt-dlp：GitHub nightly（同安卓 2.3，YTDLnis 默认）→ ghfast.top / gh-proxy.com 加速 → GitHub stable。校验同一来源的 SHA2-256SUMS。
 *  - ffmpeg：eugeneware/ffmpeg-static b6.1.1（单文件 gz，静态链接，只依赖系统库）→ npmmirror 镜像 → ghfast 加速。
 *    Windows：gyan.dev 的 GPL 版（约 30 MB）；macOS arm64：osxexperts.net 版（自带 ad-hoc 链接器签名，最低 macOS 12）；
 *    macOS x64：evermeet.cx 版（最低 10.13）。gz 文件的 sha256 固定在 FFMPEG_SHA256 里（2026-11-25 从 GitHub 下载并与 npmmirror 比对一致）。
 *    （yt-dlp/FFmpeg-Builds 的 win64 包有 200 MB，太大，不用。）
 *  - Deno：dl.deno.land → npmmirror → GitHub。校验 .sha256sum。macOS 版是 Deno 官方 Developer ID 签名的。
 *  - macOS：yt-dlp_macos 是 universal（x86_64 + arm64）。下载后 chmod 755，并去掉 com.apple.quarantine 扩展属性（如果有）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { pipeline } = require('stream/promises')
const { Readable, Transform } = require('stream')
const { execFile } = require('child_process')
const { fetch } = require('undici')
const Net = require('./net')
const { UserError, Cancelled } = require('./post')

const SP = require('./sysplat')

const GH = 'https://github.com/'
const PROXIES = ['', 'https://ghfast.top/', 'https://gh-proxy.com/']

/** 本机（或指定系统 / 架构）对应的下载文件名 */
function assetNames(platform = process.platform, arch = process.arch) {
  const arm = arch === 'arm64'
  if (platform === 'win32') return { ytdlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg-win32-x64.gz', deno: arm ? 'deno-aarch64-pc-windows-msvc.zip' : 'deno-x86_64-pc-windows-msvc.zip' }
  if (platform === 'darwin') return { ytdlp: 'yt-dlp_macos', ffmpeg: arm ? 'ffmpeg-darwin-arm64.gz' : 'ffmpeg-darwin-x64.gz', deno: arm ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip' }
  return { ytdlp: arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', ffmpeg: arm ? 'ffmpeg-linux-arm64.gz' : 'ffmpeg-linux-x64.gz', deno: arm ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip' }
}

/** yt-dlp 下载来源：[{ name, url, sums }] */
function ytdlpSources(channel = 'nightly', platform, arch) {
  const a = assetNames(platform, arch).ytdlp
  const repos = channel === 'stable' ? ['yt-dlp/yt-dlp'] : ['yt-dlp/yt-dlp-nightly-builds', 'yt-dlp/yt-dlp']
  const out = []
  for (const repo of repos) for (const px of PROXIES) {
    const base = `${px}${GH}${repo}/releases/latest/download/`
    out.push({ name: (repo.includes('nightly') ? 'nightly' : 'stable') + (px ? ' · ' + new URL(px).hostname : ' · GitHub'), url: base + a, sums: base + 'SHA2-256SUMS', asset: a })
  }
  return out
}

const FFMPEG_VER = 'b6.1.1'
/** ffmpeg-static b6.1.1 各个 gz 文件的 sha256（下载的原始字节，解压前） */
const FFMPEG_SHA256 = {
  'ffmpeg-win32-x64.gz': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  'ffmpeg-darwin-arm64.gz': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'ffmpeg-darwin-x64.gz': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'ffmpeg-linux-arm64.gz': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'ffmpeg-linux-x64.gz': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
}
function ffmpegSources(platform, arch) {
  const a = assetNames(platform, arch).ffmpeg
  const sha256 = FFMPEG_SHA256[a] || null
  const gh = `${GH}eugeneware/ffmpeg-static/releases/download/${FFMPEG_VER}/${a}`
  return [
    { name: 'GitHub', url: gh, sha256 },
    { name: 'npmmirror', url: `https://registry.npmmirror.com/-/binary/ffmpeg-static/${FFMPEG_VER}/${a}`, sha256 },
    { name: 'ghfast.top', url: 'https://ghfast.top/' + gh, sha256 },
  ]
}

function denoSources(version, platform, arch) {
  const a = assetNames(platform, arch).deno
  return [
    { name: 'dl.deno.land', url: `https://dl.deno.land/release/${version}/${a}`, sha: `https://dl.deno.land/release/${version}/${a}.sha256sum` },
    { name: 'npmmirror', url: `https://registry.npmmirror.com/-/binary/deno/${version}/${a}`, sha: `https://registry.npmmirror.com/-/binary/deno/${version}/${a}.sha256sum` },
    { name: 'GitHub', url: `${GH}denoland/deno/releases/download/${version}/${a}`, sha: `${GH}denoland/deno/releases/download/${version}/${a}.sha256sum` },
  ]
}

/** 管理 binDir 里的组件 */
class Tools {
  constructor(binDir, opts = {}) {
    this.binDir = binDir
    this.platform = opts.platform || process.platform // 测试时可以指定
    this.arch = opts.arch || process.arch
    this.log = opts.log || (() => {})
    this.channel = opts.channel || 'nightly'
    fs.mkdirSync(binDir, { recursive: true })
  }
  get ytdlpPath() { return path.join(this.binDir, SP.binFile('yt-dlp', this.platform)) }
  get ffmpegPath() { return path.join(this.binDir, SP.binFile('ffmpeg', this.platform)) }
  get denoPath() { return path.join(this.binDir, SP.binFile('deno', this.platform)) }
  assets() { return assetNames(this.platform, this.arch) }

  /** 下载完的组件：非 Windows 上 chmod 755；macOS 上再去掉隔离属性（com.apple.quarantine），否则 Gatekeeper 可能拦住命令行工具 */
  async makeRunnable(p) {
    if (this.platform === 'win32') return
    fs.chmodSync(p, 0o755)
    if (this.platform === 'darwin' && process.platform === 'darwin') await unquarantine(p)
  }
  has(name) { const p = this[name + 'Path']; try { return fs.statSync(p).size > 1000 } catch { return false } }
  /** 系统里已有的 ffmpeg（Linux 测试用；Windows 一般没有） */
  ffmpegLocation() { return this.has('ffmpeg') ? this.ffmpegPath : null }
  status() { return { ytdlp: this.has('ytdlp'), ffmpeg: this.has('ffmpeg'), deno: this.has('deno') } }
  ready() { return this.has('ytdlp') && this.has('ffmpeg') }

  async version(name) {
    const p = this[name + 'Path']
    if (!this.has(name)) return null
    const args = name === 'ffmpeg' ? ['-version'] : ['--version']
    return new Promise(res => execFile(p, args, { timeout: 60000, windowsHide: true }, (e, out) => {
      if (e) return res(null)
      const s = String(out).trim().split('\n')[0]
      res(name === 'ffmpeg' ? (s.match(/ffmpeg version (\S+)/) || [])[1] || s : name === 'deno' ? (s.match(/deno (\S+)/) || [])[1] || s : s)
    }))
  }

  /** 安装缺的组件。onProgress({ name, label, done, total, source, phase }) */
  async ensure(onProgress = () => {}, signal) {
    const res = {}
    if (!this.has('ytdlp')) res.ytdlp = await this.installYtdlp(onProgress, signal)
    if (!this.has('ffmpeg')) res.ffmpeg = await this.installFfmpeg(onProgress, signal)
    if (!this.has('deno')) {
      try { res.deno = await this.installDeno(onProgress, signal) } catch (e) {
        if (e instanceof Cancelled) throw e
        res.denoError = e.message // Deno 只有 YouTube 需要，失败不挡路
      }
    }
    return res
  }

  // ---------------------------------------------------------------- yt-dlp

  /** 下载 / 更新 yt-dlp。force=false 时与线上 sha256 相同就不下载。返回中文结果 */
  async installYtdlp(onProgress = () => {}, signal, force = false) {
    const label = '解析引擎 yt-dlp'
    const errs = []
    let localSha = null
    if (this.has('ytdlp') && !force) localSha = await sha256File(this.ytdlpPath)
    for (const src of ytdlpSources(this.channel, this.platform, this.arch)) {
      if (signal?.aborted) throw new Cancelled()
      try {
        onProgress({ name: 'ytdlp', label, phase: '检查版本', source: src.name, done: 0, total: 0 })
        let sha = null
        try { sha = parseSums(await smallText(src.sums, signal), src.asset) } catch (e) { if (e instanceof Cancelled) throw e }
        if (sha && localSha && sha === localSha) return `解析引擎已是最新（${await this.version('ytdlp') || '未知版本'}）`
        await downloadTo(src.url, this.ytdlpPath, { signal, sha256: sha, minSize: 5_000_000, onProgress: (d, t) => onProgress({ name: 'ytdlp', label, phase: '下载', source: src.name, done: d, total: t }) })
        await this.makeRunnable(this.ytdlpPath)
        const v = await this.version('ytdlp')
        if (!v) { fs.rmSync(this.ytdlpPath, { force: true }); throw new Error('下载的文件无法运行') }
        return (localSha ? '解析引擎已更新到 ' : '解析引擎已安装：') + v
      } catch (e) {
        if (e instanceof Cancelled) throw e
        errs.push(`${src.name}：${shortErr(e)}`)
        this.log(`yt-dlp ${src.name} 失败：${e.message}`)
      }
    }
    throw new UserError('下载解析引擎失败：\n' + errs.join('\n') + '\n（访问 GitHub 在国内通常需要开启 VPN）')
  }

  // ---------------------------------------------------------------- ffmpeg

  async installFfmpeg(onProgress = () => {}, signal) {
    const label = '音视频合并 ffmpeg'
    const errs = []
    for (const src of ffmpegSources(this.platform, this.arch)) {
      if (signal?.aborted) throw new Cancelled()
      try {
        await downloadTo(src.url, this.ffmpegPath, { signal, sha256: src.sha256, gunzip: src.url.endsWith('.gz'), minSize: 20_000_000, onProgress: (d, t) => onProgress({ name: 'ffmpeg', label, phase: '下载', source: src.name, done: d, total: t }) })
        await this.makeRunnable(this.ffmpegPath)
        const v = await this.version('ffmpeg')
        if (!v) { fs.rmSync(this.ffmpegPath, { force: true }); throw new Error('下载的文件无法运行') }
        return 'ffmpeg 已安装：' + v
      } catch (e) {
        if (e instanceof Cancelled) throw e
        errs.push(`${src.name}：${shortErr(e)}`)
      }
    }
    throw new UserError('下载 ffmpeg 失败：\n' + errs.join('\n'))
  }

  // ---------------------------------------------------------------- Deno

  async latestDeno(signal) {
    const tries = [
      async () => (await smallText('https://dl.deno.land/release-latest.txt', signal)).trim(),
      async () => {
        const list = JSON.parse(await smallText('https://registry.npmmirror.com/-/binary/deno/', signal))
        return list.map(x => x.name.replace(/\/$/, '')).filter(n => /^v2\.\d+\.\d+$/.test(n)).sort(cmpVer).pop()
      },
    ]
    for (const t of tries) { try { const v = await t(); if (/^v\d+\.\d+\.\d+$/.test(v)) return v } catch (e) { if (e instanceof Cancelled) throw e } }
    return 'v2.9.8' // 2026-11 的最新版，网络都不通时的兜底
  }

  async installDeno(onProgress = () => {}, signal) {
    const label = 'YouTube 用的 Deno'
    const version = await this.latestDeno(signal)
    const errs = []
    for (const src of denoSources(version, this.platform, this.arch)) {
      if (signal?.aborted) throw new Cancelled()
      const zipPath = path.join(this.binDir, 'deno-download.zip')
      try {
        let sha = null
        try { sha = (await smallText(src.sha, signal)).match(/\b[0-9a-f]{64}\b/i)?.[0]?.toLowerCase() || null } catch (e) { if (e instanceof Cancelled) throw e }
        await downloadTo(src.url, zipPath, { signal, sha256: sha, minSize: 10_000_000, onProgress: (d, t) => onProgress({ name: 'deno', label, phase: '下载', source: src.name, done: d, total: t }) })
        onProgress({ name: 'deno', label, phase: '解压', source: src.name, done: 1, total: 1 })
        await unzipEntry(zipPath, SP.binFile('deno', this.platform), this.denoPath)
        fs.rmSync(zipPath, { force: true })
        await this.makeRunnable(this.denoPath)
        const v = await this.version('deno')
        if (!v) { fs.rmSync(this.denoPath, { force: true }); throw new Error('下载的文件无法运行') }
        return 'Deno 已安装：' + v
      } catch (e) {
        fs.rmSync(zipPath, { force: true })
        if (e instanceof Cancelled) throw e
        errs.push(`${src.name}：${shortErr(e)}`)
      }
    }
    throw new UserError('下载 Deno 失败（只影响 YouTube）：\n' + errs.join('\n'))
  }
}

// ------------------------------------------------------------------ helpers

/** macOS：去掉隔离扩展属性（没有就什么也不做；xattr 失败不影响） */
function unquarantine(p) {
  return new Promise(res => execFile('/usr/bin/xattr', ['-d', 'com.apple.quarantine', p], { timeout: 10000 }, () => res()))
}

function cmpVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** SHA2-256SUMS 文件里某个文件的 sha256 */
function parseSums(text, asset) {
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (m && m[2] === asset) return m[1].toLowerCase()
  }
  return null
}

function shortErr(e) {
  if (e instanceof UserError) return e.message
  if (e && e.httpStatus) return `HTTP ${e.httpStatus}`
  return Net.netMessage(e).replace(/^网络错误：/, '')
}

async function sha256File(p) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(p), h)
  return h.digest('hex')
}

async function smallText(url, signal) {
  const sig = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
  const r = await fetch(url, { dispatcher: await Net.getDispatcher(url), signal: sig, headers: { 'User-Agent': Net.UA_DESKTOP } }).catch(e => { if (signal?.aborted) throw new Cancelled(); throw e })
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.httpStatus = r.status; throw e }
  return r.text()
}

/**
 * 下载到 dest（先写 .part，校验后改名）。gunzip: 边下边解压。卡住 30 秒没数据就放弃。
 * onProgress(done, total) total=0 表示未知。
 */
async function downloadTo(url, dest, { signal, sha256, gunzip = false, minSize = 0, onProgress = () => {} } = {}) {
  const part = dest + '.part'
  const stall = new AbortController()
  let timer = null
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error('下载卡住超过 30 秒')), 30_000) }
  const sig = AbortSignal.any([stall.signal, ...(signal ? [signal] : [])])
  kick()
  try {
    const r = await fetch(url, { dispatcher: await Net.getDispatcher(url), signal: sig, headers: { 'User-Agent': Net.UA_DESKTOP } })
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.httpStatus = r.status; throw e }
    const total = Number(r.headers.get('content-length')) || 0
    const ctype = r.headers.get('content-type') || ''
    if (/text\/html/.test(ctype)) throw new Error('服务器返回的是网页，不是文件')
    let done = 0, last = 0
    const h = crypto.createHash('sha256')
    const counter = new Transform({
      transform(chunk, _e, cb) {
        done += chunk.length; h.update(chunk); kick()
        const now = Date.now(); if (now - last > 150) { last = now; onProgress(done, total) }
        cb(null, chunk)
      },
    })
    const stages = [Readable.fromWeb(r.body), counter]
    if (gunzip) stages.push(zlib.createGunzip())
    stages.push(fs.createWriteStream(part))
    await pipeline(...stages, { signal: sig })
    onProgress(done, total || done)
    if (total && done !== total) throw new Error(`下载不完整（${done}/${total}）`)
    const digest = h.digest('hex')
    if (sha256 && digest !== sha256) throw new Error('文件校验失败（sha256 不一致）')
    if (fs.statSync(part).size < minSize) throw new Error('文件太小，可能不是正确的文件')
    fs.rmSync(dest, { force: true })
    fs.renameSync(part, dest)
  } catch (e) {
    fs.rmSync(part, { force: true })
    if (signal?.aborted) throw new Cancelled()
    if (stall.signal.aborted) throw new Error('下载卡住超过 30 秒')
    throw e
  } finally { clearTimeout(timer) }
}

/** 从 zip 里取出一个文件（按文件名，忽略目录） */
function unzipEntry(zipPath, name, dest) {
  const yauzl = require('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      let found = false
      zip.on('entry', entry => {
        if (path.posix.basename(entry.fileName) !== name) return zip.readEntry()
        found = true
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e)
          const tmp = dest + '.part'
          pipeline(rs, fs.createWriteStream(tmp)).then(() => { fs.rmSync(dest, { force: true }); fs.renameSync(tmp, dest); zip.close(); resolve() }, reject)
        })
      })
      zip.on('end', () => { if (!found) reject(new Error(`压缩包里没有 ${name}`)) })
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

module.exports = { Tools, assetNames, ytdlpSources, ffmpegSources, denoSources, FFMPEG_SHA256, parseSums, downloadTo, unzipEntry, sha256File, cmpVer }
