'use strict'
/**
 * yt-dlp 进程（移植自 Engine.kt 的流程）：解析（--dump-single-json，存 info JSON）→ 下载（--load-info-json，不再解析一次）。
 * YouTube 自动兜底：默认（同 YTDLnis）→ 连不上时走系统代理 → 更新引擎后重试 → 备用客户端。
 * （安卓版第 4 步“WebView 生成 PO Token”电脑版没有做，见 HANDOFF.md）
 * 不依赖 Electron。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const Y = require('./ytdlp-support')
const Quality = require('./quality')
const { Platform } = require('./platform')
const { UserError, Cancelled } = require('./post')

const SP = require('./sysplat')
const FAIL_UPDATE_EVERY_MS = 6 * 3600 * 1000

/** 结束进程及其子进程（yt-dlp 会启动 ffmpeg）。Windows：taskkill /T /F；macOS / Linux：向进程组发 SIGKILL */
function killTree(child) {
  if (!child || child.exitCode != null) return
  try {
    const k = SP.killPlan(child.pid)
    if (k.type === 'exec') execFile(k.cmd, k.args, { windowsHide: true }, () => {})
    else process.kill(k.pid, k.signal)
  } catch { try { child.kill('SIGKILL') } catch {} }
}

class Engine {
  /**
   * opts: tools (Tools), dataDir（info JSON / 缓存 / 诊断日志），systemProxy: async (url) => "http://…" | null,
   *       state: { get(k), set(k,v) }（记住上次自动更新时间）
   */
  constructor(opts) {
    this.tools = opts.tools
    this.dataDir = opts.dataDir
    this.systemProxy = opts.systemProxy || (async () => null)
    this.state = opts.state || { _m: {}, get(k) { return this._m[k] }, set(k, v) { this._m[k] = v } }
    this.procs = new Map()
    for (const d of ['info', 'cache', 'diag']) fs.mkdirSync(path.join(this.dataDir, d), { recursive: true })
  }

  /** 每次都加的参数：ffmpeg 位置、缓存目录 */
  baseArgs() {
    const a = ['--cache-dir', path.join(this.dataDir, 'cache', 'yt-dlp')]
    const ff = this.tools.ffmpegLocation()
    if (ff) a.push('--ffmpeg-location', ff)
    return a
  }

  /**
   * 运行 yt-dlp。返回 { code, out, err }。jobId 用于取消；signal 取消时抛 Cancelled。
   * onLine(line, stream) 每一行输出。
   */
  run(args, { jobId, signal, onLine } = {}) {
    if (!this.tools.has('ytdlp')) return Promise.reject(new UserError('解析引擎还没有安装好，请稍等首次下载完成（或点「菜单 → 更新解析引擎」）'))
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Cancelled())
      const child = spawn(this.tools.ytdlpPath, [...this.baseArgs(), ...args], {
        windowsHide: true, detached: SP.spawnDetached(),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      if (jobId) this.procs.set(jobId, child)
      let out = '', err = '', buf = { stdout: '', stderr: '' }
      const feed = (name, d) => {
        const s = d.toString('utf8')
        if (name === 'stdout') out += s; else { err += s; if (err.length > 400_000) err = err.slice(-300_000) }
        if (!onLine) return
        buf[name] += s
        const parts = buf[name].split(/\r?\n|\r/)
        buf[name] = parts.pop()
        for (const l of parts) if (l.trim()) onLine(l, name)
      }
      child.stdout.on('data', d => feed('stdout', d))
      child.stderr.on('data', d => feed('stderr', d))
      const onAbort = () => killTree(child)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', e => { signal?.removeEventListener('abort', onAbort); this.procs.delete(jobId); reject(new UserError('无法启动解析引擎：' + e.message)) })
      child.on('close', code => {
        signal?.removeEventListener('abort', onAbort)
        if (jobId) this.procs.delete(jobId)
        if (signal?.aborted) return reject(new Cancelled())
        resolve({ code, out, err })
      })
    })
  }

  cancel(jobId) { killTree(this.procs.get(jobId)) }

  async version() { return (await this.tools.version('ytdlp')) || '未安装' }

  /** 手动 / 自动更新 yt-dlp。返回中文结果，失败也返回文字（以“更新失败”开头） */
  async update(onProgress, signal) {
    try {
      const r = await this.tools.installYtdlp(onProgress, signal)
      this.state.set('engineUpdateAt', Date.now())
      return r
    } catch (e) {
      if (e instanceof Cancelled) throw e
      this.state.set('engineUpdateAt', Date.now())
      return '更新失败：' + e.message.replace(/^下载解析引擎失败：\n?/, '')
    }
  }

  /** 解析：返回作品（engine=ytdlp）。cookieFile 可为 null。log(中文进度) */
  async info(url, platform, quality, cookieFile, { log = () => {}, jobId, signal } = {}) {
    log(`正在用解析引擎读取${platform.name === 'OTHER' ? '' : platform.label}作品…`)
    const base = Y.infoOptions(platform, quality, cookieFile)
    let res
    if (platform.name === 'YOUTUBE') res = await this.youtubeInfo(url, base, { log, jobId, signal })
    else {
      const diag = this.diag(url, platform, !!cookieFile)
      let r = await this.run([...base, url], { jobId, signal })
      diag.attempt('默认', base, r.err)
      if (!okJson(r.out) && Y.netProblem(r.err)) {
        const px = await this.systemProxy(url)
        if (px) {
          log('连接失败，改用系统代理重试…')
          r = await this.run([...base, '--proxy', px, url], { jobId, signal })
          diag.attempt('系统代理 ' + px, base, r.err)
          if (okJson(r.out)) { diag.finish('成功'); res = { json: r.out, args: ['--proxy', px] } }
        }
      }
      if (!res) {
        if (!okJson(r.out)) { diag.finish('失败'); throw new UserError(Y.errorMessage(r.err, platform)) }
        diag.finish('成功'); res = { json: r.out, args: [] }
      }
    }
    const dir = path.join(this.dataDir, 'info')
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) fs.rmSync(p) } catch {} }
    const f = path.join(dir, crypto.createHash('sha1').update(url + process.hrtime.bigint()).digest('hex').slice(0, 16) + '.json')
    fs.writeFileSync(f, res.json)
    const post = Y.parseInfo(res.json, platform, url, f)
    post.ytdlpArgs = res.args
    post.ytdlpHeights = Quality.ytdlpHeights(res.json)
    return post
  }

  /** YouTube 自动兜底（每一步只在 YouTube 拒绝了上一步时才做） */
  async youtubeInfo(url, base0, { log, jobId, signal }) {
    const steps = []
    let auth = Y.YtAuth.NONE, js = false
    const diag = this.diag(url, Platform.YOUTUBE, base0.includes('--cookies'))
    const deno = this.tools.has('deno') ? this.tools.denoPath : null
    diag.line('JS 引擎：' + (deno ? 'Deno ' + deno : '没有 Deno（yt-dlp 只能用自带方式，YouTube 可能失败）'))
    const base = [...base0, ...Y.jsRuntimeArgs(deno)]
    let netArgs = []
    const ok = r => okJson(r.out)
    const attempt = async (name, extra) => {
      const opts = [...base, ...netArgs, ...extra]
      const r = await this.run([...opts, url], { jobId, signal })
      diag.attempt(name, opts, r.err)
      const a = Y.ytAuth(r.err); if (a !== Y.YtAuth.NONE) auth = a
      if (Y.jsProblem(r.err)) js = true
      return r
    }
    const fail = r => { diag.finish('失败'); throw new UserError(Y.errorMessage(r.err, Platform.YOUTUBE)) }
    const done = r => { diag.finish('成功'); return { json: r.out, args: netArgs } }

    // 1. 和 YTDLnis 默认一样（yt-dlp 自己会读系统代理设置：Windows 注册表 / macOS SystemConfiguration）
    let r = await attempt('默认（同 YTDLnis）', [])
    if (ok(r)) return done(r)
    if (Y.netProblem(r.err)) {
      const px = await this.systemProxy(url)
      if (px) {
        log('连接失败，改用系统代理重试…')
        netArgs = ['--proxy', px]
        r = await attempt('系统代理 ' + px, [])
        if (ok(r)) return done(r)
        if (Y.netProblem(r.err)) netArgs = []
      }
    }
    if (!Y.ytBlocked(r.err)) fail(r)
    steps.push({ name: '解析引擎 ' + await this.version(), result: Y.ytReason(r.err) })

    // 2. 更新引擎（nightly），6 小时内试过就不再试
    const last = Number(this.state.get('engineUpdateAt') || 0)
    if (Date.now() - last > FAIL_UPDATE_EVERY_MS) {
      log('YouTube 拒绝了请求，正在更新解析引擎后重试…')
      const msg = await this.update(() => {}, signal)
      diag.line('自动更新引擎：' + msg)
      if (msg.startsWith('解析引擎已更新')) {
        r = await attempt('更新后的引擎 ' + await this.version(), [])
        if (ok(r)) return done(r)
        if (!Y.ytBlocked(r.err)) fail(r)
        steps.push({ name: '更新后的引擎 ' + await this.version(), result: Y.ytReason(r.err) })
      } else steps.push({ name: '自动更新引擎', result: msg.replace(/^更新失败：/, '').slice(0, 40) })
    }

    // 3. 备用客户端
    log('YouTube 拒绝了请求，正在换用备用客户端重试…')
    r = await attempt('备用客户端', ['--extractor-args', Y.YT_ALT_CLIENTS])
    if (ok(r)) return done(r)
    if (!Y.ytBlocked(r.err)) fail(r)
    steps.push({ name: '备用客户端（tv / ios / visionos 等）', result: Y.ytReason(r.err) })

    diag.finish('全部失败')
    throw new UserError(Y.youtubeSummary(steps, auth, js, deno ? true : false))
  }

  /**
   * 下载到 outDir，返回产出的媒体文件（按顺序）。onProgress({ pct, speed, eta, done, total, line })
   */
  async download(post, outDir, quality, cookieFile, { onProgress = () => {}, jobId, signal } = {}) {
    if (!post.infoJson || !fs.existsSync(post.infoJson)) throw new UserError('作品信息已过期，请重新解析')
    fs.mkdirSync(outDir, { recursive: true })
    const platform = Platform[post.platform] || Platform.OTHER
    const q = post.qualityOverride || quality
    const js = platform.name === 'YOUTUBE' ? Y.jsRuntimeArgs(this.tools.has('deno') ? this.tools.denoPath : null) : []
    const opts = [...Y.downloadOptions(platform, q, cookieFile, post.infoJson, outDir, path.sep), ...(post.ytdlpArgs || []), ...js]
    let lastErr = ''
    const r = await this.run(opts, {
      jobId, signal,
      onLine: (l, stream) => {
        const p = parseProgress(l)
        if (p) onProgress(p)
        else if (/\[Merger\]|\[ffmpeg\]|\[VideoConvertor\]|\[FixupM3u8\]/.test(l)) onProgress({ pct: 100, merging: true, line: l })
        if (stream === 'stderr' && l.startsWith('ERROR')) lastErr = l
      },
    })
    if (r.code !== 0) throw new UserError(Y.errorMessage(r.err || lastErr, platform).replace('解析失败', '下载失败'))
    const files = fs.readdirSync(outDir).map(n => path.join(outDir, n)).filter(f => {
      const n = path.basename(f)
      try { if (!fs.statSync(f).isFile() || fs.statSync(f).size <= 0) return false } catch { return false }
      return !n.endsWith('.part') && !n.endsWith('.ytdl') && !n.endsWith('.json') && !n.includes('.temp.') && !/\.f\d+\./.test(n)
    }).sort()
    if (!files.length) throw new UserError('下载失败：没有得到视频文件')
    return files
  }

  // ---------------------------------------------------------------- 诊断日志

  diagFile() { return path.join(this.dataDir, 'diag', 'last.txt') }

  diag(url, platform, cookies) {
    const file = this.diagFile()
    let sb = ''
    const flush = () => { try { fs.writeFileSync(file, sb) } catch {} }
    const d = {
      line: s => { sb += s + '\n'; flush() },
      attempt: (name, options, stderr) => {
        sb += `\n===== 尝试：${name} =====\n`
        sb += '选项：' + options.map(o => (o.includes(' ') ? `"${o}"` : o)).join(' ') + '\n'
        if (platform.name === 'YOUTUBE') {
          const a = Y.ytAuth(stderr)
          sb += 'yt-dlp 判断的登录状态：' + (a === 'OK' ? '已登录（Found YouTube account cookies）' : a === 'ROTATED' ? 'cookies 已失效（no longer valid）' : '未登录') + '\n'
          sb += '结论：' + (stderr.trim() ? Y.ytReason(stderr) : '无输出') + '\n'
        } else sb += '结论：' + (Y.errorLine(stderr) || '无错误') + '\n'
        sb += '----- yt-dlp 输出 -----\n' + stderr.slice(-60_000) + '\n'
        flush()
      },
      finish: res => d.line(`\n===== 结果：${res} =====`),
    }
    sb += `拾影电脑版 ${this.appVersion || ''} 诊断日志\n时间：${new Date().toISOString()}\n系统：${process.platform} ${process.arch} ${require('os').release()}\n`
    sb += `链接：${url}\n平台：${platform.label}\n解析引擎：yt-dlp ${this.tools.has('ytdlp') ? '' : '（未安装）'}\n登录 cookies：${cookies ? '有（会传给 yt-dlp）' : '无'}\n`
    flush()
    return d
  }

  lastDiagRedacted() {
    try { const s = fs.readFileSync(this.diagFile(), 'utf8'); return s.trim() ? Y.redact(s) : null } catch { return null }
  }
}

const okJson = out => !!out && out.trim().length > 0 && out.includes('{')

/** "[shiying-progress]  45.3%|  2.10MiB/s|00:12|1234|5678|NA" → { pct, speed, eta, done, total } */
function parseProgress(line) {
  const m = /^\[shiying-progress\]\s*([\d.]+)%?\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*)$/.exec(line.trim())
  if (m) {
    const n = v => (/^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : 0)
    return { pct: Number(m[1]) || 0, speed: m[2].trim().replace(/^NA$|Unknown.*/, ''), eta: m[3].trim().replace(/^NA$|Unknown.*/, ''), done: n(m[4]), total: n(m[5]) || n(m[6]) }
  }
  const d = /^\[download\]\s+([\d.]+)%/.exec(line.trim())
  if (d) return { pct: Number(d[1]), speed: '', eta: '', done: 0, total: 0 }
  return null
}

module.exports = { Engine, parseProgress, killTree }
