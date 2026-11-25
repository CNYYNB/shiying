'use strict'
/**
 * 可选的网页登录（移植自 BrowserActivity + Engine.Cookies）：
 *  - 登录窗口用独立的持久化 session（partition "persist:shiying-login"），cookies 只存在本机；
 *  - 解析前把该平台的 cookies 导出成 Netscape cookies.txt 交给 yt-dlp，并同步给原生解析用的 cookie jar；
 *  - YouTube 只在真正登录（LOGIN_INFO + SAPISID）时才导出，匿名 cookies 不传（同安卓 2.2）；
 *  - 也可以导入浏览器扩展导出的 cookies.txt（优先于网页登录）。
 */
const fs = require('fs')
const path = require('path')
const { BrowserWindow, session } = require('electron')
const P = require('../core/platform')
const Y = require('../core/ytdlp-support')
const Net = require('../core/net')

const PARTITION = 'persist:shiying-login'
/** 登录窗口用普通 Chrome 的 UA（去掉 Electron / 拾影 字样，Google 才肯让登录） */
const CHROME_UA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`

class Cookies {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'cookies')
    fs.mkdirSync(this.dir, { recursive: true })
  }
  get session() { return session.fromPartition(PARTITION) }
  importedFile(p) { return path.join(this.dir, `import-${p.name.toLowerCase()}.txt`) }
  workFile(p) { return path.join(this.dir, `work-${p.name.toLowerCase()}.txt`) }

  async cookiesFor(p, onlyYoutube = false) {
    const doms = onlyYoutube ? ['youtube.com'] : p.cookieDomains
    const all = []
    for (const d of doms) {
      const list = await this.session.cookies.get({ domain: d }).catch(() => [])
      for (const c of list) if (!all.some(x => x.name === c.name && x.domain === c.domain && x.path === c.path)) all.push(c)
    }
    return all
  }

  /** 导出给 yt-dlp 的 cookies.txt 路径（没有则 null） */
  async export(p) {
    if (!p.cookieDomains.length) return null
    const imp = this.importedFile(p)
    if (fs.existsSync(imp) && fs.statSync(imp).size > 0) {
      // yt-dlp 会把轮换后的 cookies 写回去：给它一份工作副本，导入文件保持原样
      const work = this.workFile(p)
      const stale = !fs.existsSync(work) || fs.statSync(work).mtimeMs < fs.statSync(imp).mtimeMs ||
        (p.name === 'YOUTUBE' && !Y.CookieText.youtubeAuth(Y.CookieText.youtubeNames(fs.readFileSync(work, 'utf8'))))
      if (stale) fs.copyFileSync(imp, work)
      return work
    }
    const yt = p.name === 'YOUTUBE'
    const list = await this.cookiesFor(p, yt)
    if (!list.length) return null
    if (yt && !Y.CookieText.youtubeAuth(list.map(c => c.name))) return null
    const lines = ['# Netscape HTTP Cookie File', '# 由拾影导出，只在本机使用']
    const far = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
    for (const c of list) {
      const exp = c.session || !c.expirationDate ? far : Math.floor(c.expirationDate)
      lines.push(Y.CookieText.line(c.domain, c.name, c.value, exp, { includeSub: !c.hostOnly, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly }))
    }
    const f = path.join(this.dir, `export-${p.name.toLowerCase()}.txt`)
    fs.writeFileSync(f, lines.join('\n') + '\n')
    return f
  }

  /** 把登录 cookies 放进原生解析用的 cookie jar（抖音 / 快手 / 小红书） */
  async syncToJar(p) {
    for (const c of await this.cookiesFor(p)) {
      Net.jar.set({ name: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), path: c.path || '/', hostOnly: !!c.hostOnly, expires: c.expirationDate ? c.expirationDate * 1000 : Infinity })
    }
    const imp = this.importedFile(p)
    if (fs.existsSync(imp)) for (const l of fs.readFileSync(imp, 'utf8').split('\n')) {
      const f = l.replace(/\r$/, '').split('\t')
      if (f.length < 7 || (l.startsWith('#') && !l.startsWith('#HttpOnly_'))) continue
      const dom = f[0].replace(/^#HttpOnly_/, '')
      Net.jar.set({ name: f[5], value: f[6], domain: dom.replace(/^\./, ''), path: f[2] || '/', hostOnly: f[1] !== 'TRUE', expires: Number(f[4]) > 0 ? Number(f[4]) * 1000 : Infinity })
    }
  }

  async isLoggedIn(p) {
    if (!p.sessionCookies.length || !p.cookieDomains.length) return false
    if (fs.existsSync(this.importedFile(p))) return true
    const list = await this.cookiesFor(p, p.name === 'YOUTUBE')
    if (p.name === 'YOUTUBE') return Y.CookieText.youtubeAuth(list.map(c => c.name))
    return list.some(c => p.sessionCookies.includes(c.name) && c.value)
  }

  async status() {
    const out = []
    for (const p of P.loginable()) out.push({ name: p.name, label: p.label, loggedIn: await this.isLoggedIn(p), imported: fs.existsSync(this.importedFile(p)) })
    return out
  }

  async logout(p) {
    for (const f of [this.importedFile(p), this.workFile(p), path.join(this.dir, `export-${p.name.toLowerCase()}.txt`)]) fs.rmSync(f, { force: true })
    for (const c of await this.cookiesFor(p)) {
      const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`
      await this.session.cookies.remove(url, c.name).catch(() => {})
    }
    await this.session.cookies.flushStore().catch(() => {})
  }

  async logoutAll() {
    for (const p of P.loginable()) for (const f of [this.importedFile(p), this.workFile(p)]) fs.rmSync(f, { force: true })
    await this.session.clearStorageData().catch(() => {})
  }

  /** 校验并保存 cookies.txt。成功返回 null，否则返回中文错误 */
  importNetscape(p, text) {
    const lines = String(text).split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
    const valid = lines.filter(l => l.split('\t').length >= 7)
    if (!valid.length) return '不是有效的 cookies.txt（需要 Netscape 格式，可用浏览器扩展「Get cookies.txt LOCALLY」导出）'
    const doms = p.cookieDomains.filter(d => d !== 'google.com')
    if (doms.length && !valid.some(l => doms.some(d => l.split('\t')[0].replace(/^#HttpOnly_/, '').replace(/^\.+/, '').endsWith(d))))
      return `文件里没有 ${doms.join(' / ')} 的 cookies，请在已登录 ${p.label} 的浏览器里导出`
    const body = '# Netscape HTTP Cookie File\n' + valid.join('\n') + '\n'
    if (p.name === 'YOUTUBE' && !Y.CookieText.youtubeAuth(Y.CookieText.youtubeNames(body)))
      return '文件里没有 YouTube 登录 cookies（缺少 LOGIN_INFO / SAPISID）。请在已登录 YouTube 的浏览器里打开 youtube.com 后再导出'
    fs.writeFileSync(this.importedFile(p), body)
    fs.rmSync(this.workFile(p), { force: true })
    return null
  }

  /** 打开登录窗口；关闭时 resolve(是否已登录) */
  openLogin(p, parent) {
    return new Promise(resolve => {
      const win = new BrowserWindow({
        width: 1000, height: 760, parent, title: `登录${p.label}（登录后直接关闭本窗口即可）`, icon: parent?.icon,
        autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
      })
      win.webContents.setUserAgent(CHROME_UA())
      // 只允许 http(s)：页面里的 App 唤起链接（snssdk1128:// 等）不要交给系统
      const guard = (e, url) => { if (!/^https?:/i.test(url || e.url || '')) e.preventDefault() }
      win.webContents.on('will-navigate', guard)
      win.webContents.on('will-frame-navigate', guard)
      win.webContents.on('will-redirect', guard)
      win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) win.loadURL(url); return { action: 'deny' } })
      win.on('page-title-updated', e => e.preventDefault())
      win.loadURL(p.loginUrl)
      win.on('closed', async () => {
        await this.session.cookies.flushStore().catch(() => {})
        resolve(await this.isLoggedIn(p))
      })
    })
  }
}

module.exports = { Cookies, PARTITION, CHROME_UA }
