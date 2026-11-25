'use strict'
/**
 * 拾影电脑版主进程：窗口、IPC、解析 / 下载队列（一次一个，同安卓 DownloadService）、首次运行下载解析引擎。
 * 数据目录：%APPDATA%\拾影（bin\ 解析引擎，history.json，settings.json，thumbs\，cookies\，diag\）。
 */
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, session, Notification, Menu } = require('electron')

const Net = require('../core/net')
const Links = require('../core/links')
const P = require('../core/platform')
const Quality = require('../core/quality')
const Extractor = require('../core/extractor')
const Douyin = require('../core/douyin')
const { Tools } = require('../core/tools')
const { Engine } = require('../core/engine')
const { Settings, History } = require('../core/store')
const D = require('../core/downloader')
const { refererFor } = require('../core/thumbs')
const { makePost, UserError, PostUnavailable, NeedFallback, Cancelled } = require('../core/post')
const { Cookies } = require('./cookies')
const WebCapture = require('./webcapture')

const VERSION = app.getVersion()
const isDev = !app.isPackaged
if (process.env.SHIYING_USER_DATA) app.setPath('userData', process.env.SHIYING_USER_DATA)

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
app.setAppUserModelId('com.louis.shiying.pc')

let win = null
let dataDir, settings, history, tools, engine, cookies
const ICON = path.join(__dirname, '..', 'renderer', 'icon.png')

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload) }

// ------------------------------------------------------------------ system proxy

/** Chromium 解析的系统代理（含 PAC）："PROXY h:p" → http://h:p；DIRECT / SOCKS → null（SOCKS 只交给 yt-dlp） */
async function systemProxy(url, forYtdlp = false) {
  // 用户显式设置的 HTTPS_PROXY / HTTP_PROXY 环境变量优先（可带用户名密码）
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (env) return env
  try {
    const s = await session.defaultSession.resolveProxy(url)
    const first = s.split(';')[0].trim()
    let m = /^(PROXY|HTTPS)\s+(\S+)/i.exec(first)
    if (m) return (m[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + m[2]
    m = /^SOCKS5?\s+(\S+)/i.exec(first)
    if (m && forYtdlp) return 'socks5://' + m[1]
  } catch {}
  return null
}

// ------------------------------------------------------------------ init

function init() {
  dataDir = app.getPath('userData')
  fs.mkdirSync(dataDir, { recursive: true })
  settings = new Settings(path.join(dataDir, 'settings.json'), {
    quality: Quality.DEFAULT, saveDir: path.join(app.getPath('downloads'), '拾影'), autoClipboard: true, engineUpdateAt: 0,
  })
  history = new History(path.join(dataDir, 'history.json'), { onDrop: e => { try { fs.rmSync(thumbFile(e.key), { force: true }) } catch {} } })
  history.fixStale()
  tools = new Tools(path.join(dataDir, 'bin'), { log: s => console.log('[tools]', s) })
  engine = new Engine({
    tools, dataDir, systemProxy: url => systemProxy(url, true),
    state: { get: k => settings.get(k), set: (k, v) => settings.set(k, v) },
  })
  engine.appVersion = VERSION
  cookies = new Cookies(dataDir)
  Net.setProxyResolver(url => systemProxy(url))
  fs.rmSync(path.join(dataDir, 'tmp'), { recursive: true, force: true })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 780, minWidth: 780, minHeight: 600, title: '拾影', icon: ICON, backgroundColor: '#ffffff', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  })
  Menu.setApplicationMenu(null)
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.on('focus', () => send('focus'))
  if (process.env.SHIYING_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
  if (process.env.SHIYING_SCREENSHOT) screenshotMode()
}

/** 开发用：SHIYING_SCREENSHOT=out.png [SHIYING_SCREENSHOT_JS=脚本] [SHIYING_SCREENSHOT_WAIT=毫秒] → 截图后退出 */
function screenshotMode() {
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg))
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 1500))
    if (process.env.SHIYING_SCREENSHOT_JS) {
      try { console.log('[shot-js]', await win.webContents.executeJavaScript(fs.readFileSync(process.env.SHIYING_SCREENSHOT_JS, 'utf8'), true)) } catch (e) { console.log('[shot-js error]', e.message) }
    }
    await new Promise(r => setTimeout(r, Number(process.env.SHIYING_SCREENSHOT_WAIT || 1500)))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(process.env.SHIYING_SCREENSHOT, img.toPNG())
    console.log('[shot] saved', process.env.SHIYING_SCREENSHOT, img.getSize())
    app.exit(0)
  })
}

// 环境变量里的代理带用户名密码时，替 Chromium（网页登录 / 网页模式窗口）回答代理认证
app.on('login', (event, _wc, _details, authInfo, cb) => {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!authInfo.isProxy || !env) return
  try { const u = new URL(env); if (u.username) { event.preventDefault(); cb(decodeURIComponent(u.username), decodeURIComponent(u.password)) } } catch {}
})

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
app.on('window-all-closed', () => app.quit())
app.whenReady().then(() => { init(); createWindow() })

// ------------------------------------------------------------------ engine setup

let setupRunning = null
async function setupEngine(force = false) {
  if (setupRunning) return setupRunning
  setupRunning = (async () => {
    const ctrl = new AbortController()
    try {
      if (force) {
        send('setup', { phase: 'start' })
        const msg = await engine.update(p => send('setup', { phase: 'progress', ...p }), ctrl.signal)
        let deno = ''
        if (!tools.has('deno')) { try { deno = '\n' + await tools.installDeno(p => send('setup', { phase: 'progress', ...p }), ctrl.signal) } catch (e) { deno = '\n' + e.message } }
        let ff = ''
        if (!tools.has('ffmpeg')) { try { ff = '\n' + await tools.installFfmpeg(p => send('setup', { phase: 'progress', ...p }), ctrl.signal) } catch (e) { ff = '\n' + e.message } }
        send('setup', { phase: 'done', status: tools.status() })
        return { ok: !msg.startsWith('更新失败'), message: msg + ff + deno }
      }
      if (tools.ready() && tools.has('deno')) return { ok: true, message: '' }
      send('setup', { phase: 'start' })
      const r = await tools.ensure(p => send('setup', { phase: 'progress', ...p }), ctrl.signal)
      settings.set('engineUpdateAt', Date.now())
      send('setup', { phase: 'done', status: tools.status(), denoError: r.denoError || null })
      return { ok: true, message: r.denoError ? 'Deno 没有装好（只影响 YouTube）：' + r.denoError : '' }
    } catch (e) {
      send('setup', { phase: 'error', message: e.message, status: tools.status() })
      return { ok: false, message: e.message }
    } finally { setupRunning = null }
  })()
  return setupRunning
}

/** 每 3 天静默检查一次 yt-dlp 更新（同安卓 initAsync） */
async function autoUpdate() {
  if (!tools.has('ytdlp')) return
  if (Date.now() - Number(settings.get('engineUpdateAt') || 0) < 3 * 24 * 3600e3) return
  settings.set('engineUpdateAt', Date.now())
  try { await tools.installYtdlp(() => {}) } catch {}
}

// ------------------------------------------------------------------ parse

let parseCtrl = null
function errMessage(e) {
  if (e instanceof UserError || e instanceof PostUnavailable) return e.message
  if (e instanceof Cancelled) return '已取消'
  return '出错了：' + (e?.message || String(e)).slice(0, 200)
}

async function parse(text) {
  parseCtrl?.abort()
  const ctrl = parseCtrl = new AbortController()
  const log = s => { if (parseCtrl === ctrl) send('parse-log', s) }
  try {
    const platform = Links.detect(text)
    if (platform && platform.native) await cookies.syncToJar(platform).catch(() => {})
    let post
    try {
      // 开发用：SHIYING_FORCE_WEBCAPTURE=1 时抖音直接走网页模式（测试兜底路径）
      if (process.env.SHIYING_FORCE_WEBCAPTURE && platform === P.Platform.DOUYIN) { const t = await Douyin.resolve(text, log); throw new NeedFallback(t.id, t.likelyImages, 'forced', null) }
      const r = await Extractor.route(text, log)
      if (r.type === 'native') post = r.post
      else {
        if (!tools.ready()) {
          log('正在准备解析引擎（首次使用需要下载）…')
          const s = await setupEngine()
          if (!tools.ready()) throw new UserError('解析引擎没有装好：' + (s.message || '请检查网络后点「菜单 → 更新解析引擎」'))
        }
        const ck = await cookies.export(r.platform)
        post = await engine.info(r.url, r.platform, settings.get('quality'), ck, { log, jobId: 'parse', signal: ctrl.signal })
      }
    } catch (e) {
      if (!(e instanceof NeedFallback)) throw e
      log('分享页没有返回数据，改用网页模式…')
      post = await WebCapture.capture(e.id, e.likelyImages, { log, signal: ctrl.signal, parent: win, icon: ICON })
    }
    if (ctrl.signal.aborted) throw new Cancelled()
    return { ok: true, post: decorate(post) }
  } catch (e) {
    return { ok: false, error: errMessage(e), cancelled: e instanceof Cancelled }
  } finally { if (parseCtrl === ctrl) parseCtrl = null }
}

/** 给界面用的额外信息：画质选项、时长文字 */
function decorate(p) {
  const q = settings.get('quality')
  let qualities = []
  if (p.engine === 'ytdlp') qualities = (p.ytdlpHeights || []).map(([h, size]) => ({ h, size }))
  else if (!p.isImages) qualities = [...new Set(Object.values(p.heights || {}))].filter(h => h > 0).sort((a, b) => b - a).map(h => ({ h, size: 0 }))
  const shown = p.engine === 'ytdlp' ? (Quality.pick(qualities.map(x => x.h), q) || p.height) : Quality.shownHeight(p, q)
  return { ...p, qualities, shownHeight: shown, durationText: Douyin.formatDuration(p.durationMs), platformLabel: (P.Platform[p.platform] || P.Platform.OTHER).label }
}

// ------------------------------------------------------------------ images (covers / thumbnails)

const thumbFile = key => path.join(dataDir, 'thumbs', String(key).replace(/[^A-Za-z0-9._-]/g, '_') + '.jpg')

async function fetchImage(url, platform, postReferer) {
  const u = String(url || '').replace(/^http:\/\//, 'https://')
  if (!u.startsWith('https://')) return null
  const ref = refererFor(u, platform, postReferer)
  const pf = P.Platform[platform]
  const r = await Net.rawRequest(u, { ua: pf && pf.native ? Net.UA_IPHONE : Net.UA_DESKTOP, referer: ref, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', timeout: 20000 })
  if (r.status >= 300) { await r.body?.cancel().catch(() => {}); return null }
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > 8 * 1024 * 1024) return null
  return { buf, type: (r.headers.get('content-type') || 'image/jpeg').split(';')[0] }
}

async function coverData(url, platform, referer) {
  try {
    const img = await fetchImage(url, platform, referer)
    if (!img) return null
    return `data:${img.type};base64,${img.buf.toString('base64')}`
  } catch { return null }
}

async function saveThumb(key, post) {
  try {
    const img = await fetchImage(post.cover, post.platform, post.headers?.Referer)
    if (!img) return
    let ni = nativeImage.createFromBuffer(img.buf)
    if (ni.isEmpty()) return
    if (ni.getSize().width > 360) ni = ni.resize({ width: 360, quality: 'good' })
    fs.mkdirSync(path.dirname(thumbFile(key)), { recursive: true })
    fs.writeFileSync(thumbFile(key), ni.toJPEG(85))
    send('history-changed')
  } catch {}
}

function thumbData(key) {
  try { return 'data:image/jpeg;base64,' + fs.readFileSync(thumbFile(key)).toString('base64') } catch { return null }
}

// ------------------------------------------------------------------ download queue

const queue = []
let current = null // { key, ctrl }

function enqueue(post, qualityOverride) {
  const p = makePost({ ...post, qualityOverride: qualityOverride || post.qualityOverride || null })
  const key = `${p.platform}-${p.id}-${Date.now()}`
  history.put({
    key, id: p.id, title: p.title, author: p.author, isImages: p.isImages, time: Date.now(), status: 'running', message: '排队中',
    files: [], cover: p.cover || '', platform: p.platform, link: p.link,
  })
  saveThumb(key, p)
  queue.push({ key, post: p })
  send('history-changed')
  pump()
  return key
}

function pump() {
  if (current || !queue.length) return
  const job = queue.shift()
  current = { key: job.key, ctrl: new AbortController() }
  runJob(job, current.ctrl.signal).finally(() => { current = null; pump() })
}

async function runJob({ key, post }, signal) {
  const saveDir = settings.get('saveDir')
  const q = settings.get('quality')
  const progress = x => send('job', { key, status: 'running', ...x })
  const tmp = path.join(dataDir, 'tmp', key.replace(/[^A-Za-z0-9._-]/g, '_'))
  try {
    fs.mkdirSync(saveDir, { recursive: true })
    history.update(key, e => { e.message = '正在下载' })
    progress({ pct: 0, text: '开始下载…' })
    let files
    if (post.engine === 'ytdlp') {
      if (!tools.ready()) { progress({ pct: 0, text: '正在准备解析引擎…' }); await setupEngine(); if (!tools.ready()) throw new UserError('解析引擎没有装好，无法下载') }
      const ck = await cookies.export(P.Platform[post.platform] || P.Platform.OTHER)
      const raw = await engine.download(post, tmp, q, ck, {
        jobId: key, signal,
        onProgress: x => progress({ pct: x.pct, text: x.merging ? '正在合并音视频…' : `正在下载${post.entries > 1 ? `（共 ${post.entries} 个视频）` : ''}${x.speed ? ' · ' + x.speed : ''}${x.eta ? ' · 剩余 ' + x.eta : ''}`, done: x.done, total: x.total }),
      })
      files = D.moveYtdlpFiles(raw, post, saveDir)
    } else {
      files = await D.downloadNative(post, saveDir, q, { signal, onProgress: x => progress(x) })
    }
    history.update(key, e => { e.status = 'done'; e.message = ''; e.files = files })
    send('job', { key, status: 'done', files })
    notify('下载完成', post.title)
  } catch (e) {
    const cancelled = e instanceof Cancelled || signal.aborted
    history.update(key, h => { h.status = cancelled ? 'cancelled' : 'failed'; h.message = cancelled ? '已取消' : errMessage(e) })
    send('job', { key, status: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已取消' : errMessage(e) })
    if (!cancelled) notify('下载失败', errMessage(e))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    send('history-changed')
  }
}

function cancelJob(key) {
  const qi = queue.findIndex(j => j.key === key)
  if (qi >= 0) { queue.splice(qi, 1); history.update(key, e => { e.status = 'cancelled'; e.message = '已取消' }); send('history-changed'); return }
  if (current && current.key === key) { current.ctrl.abort(); engine.cancel(key) }
}

function notify(title, body) {
  if (win && win.isFocused()) return
  try { if (Notification.isSupported()) new Notification({ title: `拾影 · ${title}`, body: String(body || '').slice(0, 120), icon: ICON }).show() } catch {}
}

// ------------------------------------------------------------------ IPC

const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a))

h('init', async () => {
  setTimeout(() => setupEngine().then(() => autoUpdate()), 300)
  return {
    version: VERSION, settings: settings.all(), toolsStatus: tools.status(),
    qualities: Quality.keys.map(k => ({ key: k, label: Quality.menuLabel(k) })),
    current: current ? current.key : null,
  }
})
h('clipboard', async () => {
  const t = String((await clipboard.readText()) || '')
  return { text: t, supported: Links.looksSupported(t) || !!Links.bareId(t), platform: Links.detect(t)?.label || null }
})
h('detect', text => { const p = Links.detect(text); return p ? p.label : null })
h('parse', text => parse(text))
h('parse-cancel', () => { parseCtrl?.abort(); engine.cancel('parse') })
h('cover', (url, platform, referer) => coverData(url, platform, referer))
h('download', (post, q) => enqueue(post, q))
h('cancel', key => cancelJob(key))
h('history', () => history.all().map(e => ({ ...e, thumb: thumbData(e.key), platformLabel: (P.Platform[e.platform] || P.Platform.DOUYIN).label, exists: (e.files || []).some(f => fs.existsSync(f)) })))
h('history-remove', key => { history.remove(key); send('history-changed') })
h('history-clear', () => { history.clear(); send('history-changed') })
h('open-file', async f => { if (!f || !fs.existsSync(f)) return '文件不存在（可能已被移动或删除）'; const r = await shell.openPath(f); return r || null })
h('show-file', f => { if (!f || !fs.existsSync(f)) return '文件不存在（可能已被移动或删除）'; shell.showItemInFolder(f); return null })
h('open-save-dir', async () => { fs.mkdirSync(settings.get('saveDir'), { recursive: true }); return (await shell.openPath(settings.get('saveDir'))) || null })
h('choose-save-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择保存位置', defaultPath: settings.get('saveDir'), properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  settings.set('saveDir', r.filePaths[0]); return r.filePaths[0]
})
h('set-quality', q => { settings.set('quality', Quality.normalize(q)); return settings.get('quality') })
h('set-setting', (k, v) => { if (['autoClipboard'].includes(k)) settings.set(k, v); return settings.all() })
h('copy-text', async t => { await clipboard.writeText(String(t || '')); return true })
h('open-url', u => { if (/^https?:\/\//.test(u)) shell.openExternal(u) })
h('engine-setup', () => setupEngine(false))
h('engine-update', () => setupEngine(true))
h('engine-info', async () => ({
  ytdlp: await tools.version('ytdlp'), ffmpeg: await tools.version('ffmpeg'), deno: await tools.version('deno'),
  binDir: tools.binDir, dataDir, status: tools.status(),
}))
h('open-data-dir', () => shell.openPath(dataDir))
h('diag-copy', async () => {
  const d = engine.lastDiagRedacted()
  const head = `拾影电脑版 ${VERSION} / Windows 版本 ${require('os').release()} / yt-dlp ${await tools.version('ytdlp') || '未安装'} / ffmpeg ${await tools.version('ffmpeg') || '未安装'} / Deno ${await tools.version('deno') || '未安装'}\n`
  await clipboard.writeText(head + (d || '（还没有解析引擎的日志：用 yt-dlp 解析一次链接后再复制）'))
  return !!d
})
h('login-status', () => cookies.status())
h('login-open', async name => { const p = P.byName(name); if (!p) return false; const ok = await cookies.openLogin(p, win); return ok })
h('login-logout', async name => { const p = P.byName(name); if (p) await cookies.logout(p); return cookies.status() })
h('login-logout-all', async () => { await cookies.logoutAll(); Net.jar.clear(); return cookies.status() })
h('login-import', async name => {
  const p = P.byName(name); if (!p) return '未知平台'
  const r = await dialog.showOpenDialog(win, { title: `导入 ${p.label} 的 cookies.txt`, filters: [{ name: 'cookies.txt', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return cookies.importNetscape(p, fs.readFileSync(r.filePaths[0], 'utf8')) || 'ok'
})
h('notice', () => {
  for (const f of [path.join(process.resourcesPath || '', 'NOTICE.md'), path.join(__dirname, '..', '..', 'NOTICE.md')]) { try { return fs.readFileSync(f, 'utf8') } catch {} }
  return ''
})
