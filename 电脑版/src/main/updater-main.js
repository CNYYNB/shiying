'use strict'
/**
 * 内置更新的 Electron 部分（逻辑在 src/core/updater.js）：检查、下载（进度 / 取消）、安装并重启。
 * 界面事件：send('update', { phase: 'available' | 'progress' | 'installing' | 'manual-mac' | 'error', ... })
 * 设置：updateAuto（启动时自动检查，默认开）、updateCheckAt（上次自动检查时间，最多 6 小时一次）。
 * 更新文件放在系统临时文件夹的 shiying-update/ 里；装好后新版启动时读 数据目录/update-done.json 提示「已更新到 x」。
 */
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')
const U = require('../core/updater')

class AppUpdater {
  /**
   * opts: { app, shell, settings, send, version, pkg, isBusy(), log }
   * 测试用（Linux 上模拟 Windows / Mac 安装流程）：platform、execPath、pid、spawn
   */
  constructor(opts) {
    Object.assign(this, opts)
    this.platform = opts.platform || process.platform
    this.execPath = opts.execPath || process.execPath
    this.pid = opts.pid || process.pid
    this.spawn = opts.spawn || spawn
    this.log = opts.log || (() => {})
    this.info = null // 最近一次检查结果
    this.ctrl = null
    this.running = false
    this.lines = []
  }

  get urls() { return U.manifestUrls(this.pkg) }
  get workDir() { return path.join(this.app.getPath('temp'), 'shiying-update') }
  get markerFile() { return path.join(this.app.getPath('userData'), 'update-done.json') }
  diag(s) { this.lines.push(`${new Date().toISOString()} ${s}`); if (this.lines.length > 80) this.lines.shift(); this.log(s) }

  /** 怎么安装：win-silent（安装版静默升级）/ win-setup（便携版打开安装包）/ mac / manual（开发模式、Linux、没有对应文件、低于 minVersion） */
  mode(r = this.info) {
    if (!r || r.needManual) return 'manual'
    if (!this.app.isPackaged && !process.env.SHIYING_UPDATE_DEV_INSTALL) return 'manual'
    if (this.platform === 'win32') return U.winIsInstalled(this.execPath) ? 'win-silent' : 'win-setup'
    if (this.platform === 'darwin') return 'mac'
    return 'manual'
  }

  view(r) {
    const a = r.asset
    return {
      available: r.available, current: this.version, version: r.manifest.version, notes: r.manifest.notes, date: r.manifest.date,
      size: a ? a.size : 0, mode: this.mode(r), page: r.manifest.page, belowMin: r.belowMin, emulated: !!(a && a.emulated),
      busy: !!(this.isBusy && this.isBusy()), dev: !this.app.isPackaged,
    }
  }

  /** 检查更新。manual=true：界面要结果（错误也返回）；false：启动时静默检查，有新版本才通知界面 */
  async check({ manual = false } = {}) {
    if (!manual) {
      if (this.settings.get('updateAuto') === false) return null
      if (Date.now() - Number(this.settings.get('updateCheckAt') || 0) < U.CHECK_INTERVAL) return null
      this.settings.set('updateCheckAt', Date.now()) // 失败也算一次，避免没网时每次启动都试
    }
    try {
      const r = await U.checkForUpdate({ current: this.version, urls: this.urls, platform: this.platform, arch: this.arch || process.arch, allowHttp: !!(this.allowHttp || process.env.SHIYING_UPDATE_ALLOW_HTTP), log: s => this.diag(s) })
      this.info = r
      this.diag(`检查：当前 ${this.version}，最新 ${r.manifest.version}（${r.source}）`)
      const v = this.view(r)
      if (!manual && r.available) this.send('update', { phase: 'available', ...v })
      return { ok: true, ...v }
    } catch (e) {
      const ue = U.classify(e)
      this.diag(`检查失败：${ue.kind} ${ue.detail || ue.message}`)
      return { ok: false, error: ue.message, kind: ue.kind }
    }
  }

  cancel() { if (this.ctrl) { this.ctrl.abort(); this.diag('用户取消') } }

  /** 「立即更新」：下载 → 校验 → 安装。返回 { ok, ... }；成功时一般已经开始退出 */
  async start() {
    if (this.running) return { ok: false, error: '正在更新中' }
    const r = this.info
    if (!r || !r.available) return { ok: false, error: '没有可用的更新，请先检查更新' }
    const mode = this.mode(r)
    if (mode === 'manual') { this.shell.openExternal(r.manifest.page || U.DEFAULT_PAGE); return { ok: true, opened: true } }
    this.running = true
    const ctrl = this.ctrl = new AbortController()
    try {
      const { file } = await U.downloadAsset(r.asset, this.workDir, {
        signal: ctrl.signal, log: s => this.diag(s),
        onProgress: p => this.send('update', { phase: 'progress', ...p }),
      })
      if (ctrl.signal.aborted) throw new U.UpdateError('cancelled', '已取消')
      this.diag(`已下载并校验：${path.basename(file)}`)
      if (mode === 'mac') return await this.installMac(file, r.manifest.version, ctrl.signal)
      return await this.installWin(file, mode === 'win-silent', r.manifest.version)
    } catch (e) {
      const ue = U.classify(e)
      if (ue.kind !== 'cancelled') this.diag(`更新失败：${ue.kind} ${ue.detail || ue.message}`)
      return { ok: false, cancelled: ue.kind === 'cancelled', error: ue.message, kind: ue.kind }
    } finally { this.running = false; if (this.ctrl === ctrl) this.ctrl = null }
  }

  writeMarker(to) { try { fs.writeFileSync(this.markerFile, JSON.stringify({ from: this.version, to, at: Date.now() })) } catch {} }

  /** 新版第一次启动：返回「已更新到 x」并删除标记；同时清掉旧的更新文件 */
  consumeMarker() {
    let m = null
    try { m = JSON.parse(fs.readFileSync(this.markerFile, 'utf8')) } catch {}
    if (m) { try { fs.rmSync(this.markerFile, { force: true }) } catch {} }
    if (m && m.to === this.version) { try { fs.rmSync(this.workDir, { recursive: true, force: true }) } catch {} ; return m }
    return null
  }

  async installWin(file, silent, version) {
    const cmd = U.winInstallCommand(file, { installed: silent })
    this.send('update', { phase: 'installing', text: silent ? '正在安装，拾影会自动关闭并在安装完成后重新打开（约 10–30 秒）…' : '正在打开安装程序…' })
    this.writeMarker(version)
    await new Promise((resolve, reject) => {
      let child
      try { child = this.spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false }) } catch (e) { return reject(e) }
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    }).catch(async e => {
      // 例如需要管理员权限（EACCES / 740）：交给系统打开（会弹 UAC，安装界面可见）
      this.diag(`直接运行安装包失败（${e.code || e.message}），改用系统打开`)
      const err = await this.shell.openPath(file)
      if (err) throw new U.UpdateError('install', '无法运行安装程序：' + err + '\n安装包在：' + file)
    })
    setTimeout(() => this.app.quit(), 800)
    return { ok: true, quitting: true }
  }

  async installMac(zip, version, signal) {
    this.send('update', { phase: 'installing', text: '正在解压新版本…' })
    const ex = path.join(this.workDir, 'extract-' + version)
    fs.rmSync(ex, { recursive: true, force: true }); fs.mkdirSync(ex, { recursive: true })
    await run('ditto', ['-x', '-k', zip, ex], signal).catch(e => { throw new U.UpdateError('install', '解压更新包失败：' + (e.stderr || e.message).trim().slice(0, 200)) })
    const newApp = U.macFindAndCheckApp(ex, version)
    await run('xattr', ['-cr', newApp], signal).catch(e => this.diag('xattr：' + e.message))
    const bundle = U.macBundleFromExec(this.execPath)
    const can = U.macCanReplace(bundle)
    this.diag(`mac 替换 ${bundle}：${can.ok ? '可以' : can.reason}`)
    if (!can.ok) {
      // 放到「下载」里，在访达中显示，并给出手动步骤
      const destDir = path.join(this.app.getPath('downloads'), `拾影新版本-${version}`)
      fs.rmSync(destDir, { recursive: true, force: true }); fs.mkdirSync(destDir, { recursive: true })
      const dest = path.join(destDir, path.basename(newApp))
      await run('ditto', [newApp, dest], signal).catch(() => fs.renameSync(newApp, dest))
      this.shell.showItemInFolder(dest)
      return { ok: true, manual: true, message: U.macFallbackMessage(can.reason, dest) }
    }
    const script = path.join(this.workDir, 'swap.sh')
    fs.writeFileSync(script, U.macSwapScript({ pid: this.pid, target: bundle, newApp, log: path.join(this.workDir, 'swap.log') }), { mode: 0o755 })
    this.writeMarker(version)
    const child = this.spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
    child.unref()
    this.send('update', { phase: 'installing', text: '正在替换拾影并重新打开…' })
    setTimeout(() => this.app.quit(), 500)
    return { ok: true, quitting: true }
  }

  diagText() { return this.lines.join('\n') }
}

function run(cmd, args, signal) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 180_000, signal }, (e, stdout, stderr) => {
    if (e) { e.stderr = String(stderr || ''); reject(e) } else resolve(String(stdout || ''))
  }))
}

module.exports = { AppUpdater }
