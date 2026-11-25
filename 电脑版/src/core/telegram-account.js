'use strict'
/**
 * Telegram 账号：登录（api_id / api_hash → 手机号 → 验证码 → 两步验证密码）、会话保存、连接（代理）、退出。
 * 不直接依赖 Electron：加密由调用方注入（主进程用 safeStorage：Windows 上是 DPAPI，macOS 上是钥匙串），GramJS 也是注入的（测试用假的）。
 *
 * 保存在 dir（%APPDATA%\拾影\telegram）：
 *   config.bin   加密的 { apiId, apiHash, proxy, name, username }（不存手机号）
 *   session.bin  加密的 GramJS StringSession
 * 加密不可用时：不写文件，只在本次运行期间保持登录。诊断日志只记脱敏后的内容。
 */
const fs = require('fs')
const path = require('path')
const TgS = require('./telegram-support')
const { TgError, wrap } = require('./telegram')

const CONNECT_TIMEOUT = 25000

function withTimeout(p, ms, onTimeout) {
  let t
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { try { onTimeout?.() } catch {} rej(new Error('Connection to telegram failed: timed out')) }, ms) })]).finally(() => clearTimeout(t))
}

/** 中国大陆手机号没写区号时补 +86；其余去掉空格和横线 */
function normalizePhone(s) {
  let p = String(s || '').replace(/[\s\-()（）]/g, '')
  if (/^1[3-9]\d{9}$/.test(p)) p = '+86' + p
  if (/^00\d/.test(p)) p = '+' + p.slice(2)
  if (!/^\+?\d{6,16}$/.test(p)) throw new TgError('auth_phone', '手机号格式不对。请带国家区号，例如 +8613800138000')
  return p.startsWith('+') ? p : '+' + p
}

function checkApi(apiId, apiHash) {
  const id = String(apiId || '').trim(), hash = String(apiHash || '').trim()
  if (!/^\d{3,12}$/.test(id)) throw new TgError('auth_api', 'api_id 应该是一串数字（在 my.telegram.org 的 App api_id 那一行）')
  if (!/^[0-9a-fA-F]{32}$/.test(hash)) throw new TgError('auth_api', 'api_hash 应该是 32 位字母和数字（在 my.telegram.org 的 App api_hash 那一行）')
  return { apiId: Number(id), apiHash: hash.toLowerCase() }
}

/** Chromium resolveProxy 的结果（"PROXY h:p; DIRECT" 之类）→ 要试的代理（按顺序）。HTTP 代理端口按 SOCKS5 试（Clash / v2rayN 的混合端口） */
function systemCandidates(resolved, env = {}) {
  const out = []
  const e = env.ALL_PROXY || env.all_proxy || env.HTTPS_PROXY || env.https_proxy || ''
  if (/^socks/i.test(e)) { try { out.push({ proxy: TgS.parseProxy(e), label: '环境变量代理 ' + TgS.describeProxy(TgS.parseProxy(e)) }) } catch {} }
  const first = String(resolved || '').split(';')[0].trim()
  let m = /^SOCKS5?\s+(\S+?):(\d+)$/i.exec(first)
  if (m) out.push({ proxy: { ip: m[1], port: Number(m[2]), socksType: 5, timeout: 10 }, label: `系统代理（SOCKS5 ${m[1]}:${m[2]}）` })
  m = /^(?:PROXY|HTTPS)\s+(\S+?):(\d+)$/i.exec(first)
  // 只是猜（纯 HTTP 代理端口不会回应 SOCKS5），超时短一点，失败了很快改试直连
  if (m) out.push({ proxy: { ip: m[1], port: Number(m[2]), socksType: 5, timeout: 6 }, label: `系统代理端口 ${m[1]}:${m[2]}（按 SOCKS5 / 混合端口试）` })
  out.push({ proxy: null, label: '直连' })
  return out
}

class TelegramAccount {
  /**
   * @param {object} o
   * @param {string} o.dir
   * @param {{available():boolean, encrypt(s:string):Buffer, decrypt(b:Buffer):string}} o.secure
   * @param {() => any} o.lib  返回 { TelegramClient, StringSession, Api, Logger }（懒加载 GramJS）
   * @param {() => Promise<string|null>} [o.systemProxy]  Chromium 解析的系统代理字符串
   * @param {string} [o.appVersion]
   */
  constructor({ dir, secure, lib, systemProxy, appVersion = '', systemVersion = 'Windows', env = process.env, connectTimeout = CONNECT_TIMEOUT }) {
    this.dir = dir
    this.secure = secure
    this.libFn = lib
    this.systemProxy = systemProxy || (async () => null)
    this.appVersion = appVersion
    this.systemVersion = systemVersion
    this.env = env
    this.connectTimeout = connectTimeout
    this.lines = []
    this.secretsSet = new Set()
    this.client = null
    this.clientPromise = null
    this.pending = null
    this.memSession = null
    this.via = ''
    this.cfg = this.readEnc('config.bin', {}) || {}
    if (this.cfg.apiHash) this.secretsSet.add(this.cfg.apiHash)
  }

  get lib() { return this._lib || (this._lib = this.libFn()) }

  // ---------------------------------------------------------------- storage

  file(n) { return path.join(this.dir, n) }
  readEnc(n, def = null) {
    try {
      if (!this.secure.available()) return def
      const s = this.secure.decrypt(fs.readFileSync(this.file(n)))
      return n.endsWith('.bin') && n !== 'session.bin' ? JSON.parse(s) : s
    } catch { return def }
  }
  writeEnc(n, v) {
    if (!this.secure.available()) return false
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file(n) + '.tmp'
    fs.writeFileSync(tmp, this.secure.encrypt(typeof v === 'string' ? v : JSON.stringify(v)))
    fs.renameSync(tmp, this.file(n))
    return true
  }
  saveCfg() { this.writeEnc('config.bin', this.cfg) }
  session() {
    const s = this.memSession || this.readEnc('session.bin', null)
    if (s) this.secretsSet.add(s)
    return s || null
  }
  saveSession(s) {
    this.secretsSet.add(s)
    this.memSession = s
    this.writeEnc('session.bin', s)
  }

  // ---------------------------------------------------------------- diag

  secrets() { return [...this.secretsSet] }
  log(s) {
    const line = `${new Date().toISOString().slice(11, 19)} ${TgS.redact(s, this.secrets())}`
    this.lines.push(line)
    if (this.env.SHIYING_DEBUG) console.log('[telegram]', line)
    if (this.lines.length > 300) this.lines.splice(0, this.lines.length - 300)
  }
  diagText() {
    const st = this.statusSync()
    return [`Telegram：${st.loggedIn ? '已登录' : '未登录'} · api_id ${st.apiIdSet ? '已填' : '未填'} · 代理设置 ${st.proxyDesc} · 上次连接方式 ${this.via || '（还没连过）'} · 加密保存 ${st.encryption ? '可用' : '不可用'}`,
      ...this.lines.map(l => TgS.redact(l, this.secrets()))].join('\n')
  }

  // ---------------------------------------------------------------- status

  loggedIn() { return !!this.session() }
  statusSync() {
    let proxyDesc = '跟随系统代理'
    try { if (this.cfg.proxy) proxyDesc = TgS.describeProxy(TgS.parseProxy(this.cfg.proxy)) } catch { proxyDesc = '格式不对' }
    return {
      loggedIn: this.loggedIn(), apiIdSet: !!this.cfg.apiId, apiId: this.cfg.apiId ? String(this.cfg.apiId) : '', hasApiHash: !!this.cfg.apiHash,
      name: this.cfg.name || '', username: this.cfg.username || '', proxy: this.cfg.proxy || '', proxyDesc,
      encryption: !!this.secure.available(), pending: this.pending ? this.pending.step : null, via: this.via,
    }
  }
  status() { return this.statusSync() }

  // ---------------------------------------------------------------- connect

  async candidates() {
    if (this.cfg.proxy) {
      let p
      try { p = TgS.parseProxy(this.cfg.proxy) } catch (e) { throw new TgError('net', 'Telegram 代理设置格式不对：' + e.message) }
      return [{ proxy: p, label: '拾影设置的 ' + TgS.describeProxy(p) }]
    }
    let sys = null
    try { sys = await this.systemProxy() } catch {}
    return systemCandidates(sys, this.env)
  }

  makeLogger() {
    const { Logger } = this.lib
    const self = this
    if (!Logger) return undefined
    // 只把 warn / error 记进（脱敏的）诊断日志；canSend 返回 false，GramJS 就不会再 console.error 整个错误对象
    class DiagLogger extends Logger {
      canSend() { return false }
      warn(m) { self.log(`[gramjs warn] ${m}`) }
      error(m) { self.log(`[gramjs error] ${m}`) }
      info() {}
      debug() {}
      log() {}
    }
    return new DiagLogger('warn')
  }

  /** 新建并连接客户端（按顺序试代理）。不检查是否登录 */
  async connectNew(sessionStr, apiId, apiHash) {
    const { TelegramClient, StringSession } = this.lib
    const cands = await this.candidates()
    let lastErr = null
    const tried = []
    for (const c of cands) {
      this.log(`连接 Telegram：${c.label}`)
      let client = null
      try {
        client = new TelegramClient(new StringSession(sessionStr || ''), apiId, apiHash, {
          connectionRetries: 2, retryDelay: 1000, autoReconnect: true, floodSleepThreshold: 15, useWSS: false,
          proxy: c.proxy || undefined, baseLogger: this.makeLogger(),
          deviceModel: '拾影 PC', systemVersion: this.systemVersion, appVersion: this.appVersion || '1.0', langCode: 'zh', systemLangCode: 'zh-CN',
        })
        let lastConnErr = null
        client.onError = async err => { lastConnErr = err; this.log(`连接错误：${err?.errorMessage || err?.message || err}`) }
        // GramJS 重试用完后 connect() 不抛错、只返回 false：以 client.connected 为准
        await withTimeout(client.connect(), this.connectTimeout)
        if (!client.connected) throw lastConnErr || new Error('Connection to telegram failed')
        this.via = c.label
        this.log('已连接：' + c.label)
        return client
      } catch (e) {
        lastErr = e
        tried.push(c.label)
        this.log(`连接失败（${c.label}）：${e?.errorMessage || e?.message || e}`)
        if (client) { try { await client.destroy() } catch {} }
      }
    }
    const c = TgS.classifyError(lastErr, 'login')
    if (c.kind !== 'net') throw new TgError(c.kind, c.message)
    throw new TgError('net', `连不上 Telegram 服务器（试过：${tried.join('、')}）。\n在国内需要代理：在「登录 → Telegram」的「代理」里填 SOCKS5（例如 socks5://127.0.0.1:7890，Clash / v2rayN 的 SOCKS 或混合端口）或 MTProxy 链接，再试。`)
  }

  /** 已连接、已登录的客户端（主进程解析 / 下载用） */
  async getClient() {
    if (this.client) return this.client
    if (this.clientPromise) return this.clientPromise
    this.clientPromise = (async () => {
      const s = this.session()
      if (!s || !this.cfg.apiId || !this.cfg.apiHash) throw new TgError('session', '还没有登录 Telegram：点右上角「登录」→「Telegram 账号登录」')
      const client = await this.connectNew(s, this.cfg.apiId, this.cfg.apiHash)
      let ok = false
      try { ok = await client.checkAuthorization() } catch (e) {
        const c = TgS.classifyError(e)
        if (c.kind !== 'session') { try { await client.destroy() } catch {} throw wrap(e) }
      }
      if (!ok) {
        try { await client.destroy() } catch {}
        this.log('会话已失效，清除本地登录')
        this.clearSession()
        throw new TgError('session', 'Telegram 登录已失效（可能在手机上的「设备」里结束了这个会话），请重新登录')
      }
      this.client = client
      return client
    })()
    try { return await this.clientPromise } finally { this.clientPromise = null }
  }

  async dropClient() {
    const c = this.client
    this.client = null
    if (c) { try { await c.destroy() } catch {} }
  }

  clearSession() {
    this.memSession = null
    fs.rmSync(this.file('session.bin'), { force: true })
  }

  // ---------------------------------------------------------------- login

  /** 第 1 步：保存 api_id / api_hash / 代理，发送验证码。→ { step:'code', viaApp } */
  async sendCode({ apiId, apiHash, phone, proxy }) {
    try {
      const api = checkApi(apiId, apiHash)
      const ph = normalizePhone(phone)
      this.secretsSet.add(api.apiHash); this.secretsSet.add(ph); this.secretsSet.add(ph.replace(/^\+/, ''))
      if (proxy !== undefined) this.setProxyText(proxy)
      this.cfg.apiId = api.apiId; this.cfg.apiHash = api.apiHash
      this.saveCfg()
      await this.cancelLogin()
      this.log('登录：发送验证码')
      const client = await this.connectNew('', api.apiId, api.apiHash)
      this.pending = { step: 'code', client, phone: ph, ...api }
      const r = await client.sendCode({ apiId: api.apiId, apiHash: api.apiHash }, ph)
      this.pending.phoneCodeHash = r.phoneCodeHash
      this.log(`验证码已发送（${r.isCodeViaApp ? 'Telegram App 内' : '短信'}）`)
      return { step: 'code', viaApp: !!r.isCodeViaApp }
    } catch (e) {
      this.log('发送验证码失败：' + (e?.errorMessage || e?.message))
      if (this.pending?.step !== 'code' || !this.pending.phoneCodeHash) await this.cancelLogin()
      throw wrap(e, 'login')
    }
  }

  /** 重新发送验证码（用同一套信息） */
  async resendCode() {
    const p = this.pending
    if (!p) throw new TgError('auth_state', '请重新填写手机号并发送验证码')
    return this.sendCode({ apiId: p.apiId, apiHash: p.apiHash, phone: p.phone })
  }

  /** 第 2 步：验证码。→ { step:'done', name } | { step:'password', hint } */
  async signIn(code) {
    const p = this.pending
    if (!p || !p.phoneCodeHash) throw new TgError('auth_state', '请先发送验证码')
    const c = String(code || '').replace(/\D/g, '')
    if (!c) throw new TgError('auth_code', '请输入验证码')
    this.secretsSet.add(c)
    const { Api } = this.lib
    try {
      this.log('登录：提交验证码')
      const r = await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: c }))
      if (r && r.className === 'auth.AuthorizationSignUpRequired') throw new TgError('auth_phone', '这个手机号还没有注册 Telegram。请先在手机上注册')
      return await this.finish()
    } catch (e) {
      const k = TgS.classifyError(e).kind
      if (k === 'auth_need_password') {
        let hint = ''
        try { const pw = await p.client.invoke(new Api.account.GetPassword()); hint = pw.hint || '' } catch {}
        p.step = 'password'
        this.log('需要两步验证密码')
        return { step: 'password', hint }
      }
      this.log('验证码登录失败：' + (e?.errorMessage || e?.message))
      throw wrap(e, 'login')
    }
  }

  /** 第 3 步：两步验证密码。→ { step:'done', name } */
  async password(pw) {
    const p = this.pending
    if (!p || p.step !== 'password') throw new TgError('auth_state', '请先输入验证码')
    if (!pw) throw new TgError('auth_password', '请输入两步验证密码')
    this.secretsSet.add(String(pw))
    try {
      this.log('登录：提交两步验证密码')
      await p.client.signInWithPassword({ apiId: p.apiId, apiHash: p.apiHash }, {
        password: async () => String(pw),
        onError: async err => { throw err },
      })
      return await this.finish()
    } catch (e) {
      this.log('两步验证失败：' + (e?.errorMessage || e?.message))
      throw wrap(e, 'login')
    }
  }

  async finish() {
    const p = this.pending
    const s = p.client.session.save()
    this.saveSession(s)
    let me = null
    try { me = await p.client.getMe() } catch {}
    this.cfg.name = me ? [me.firstName, me.lastName].filter(Boolean).join(' ') : ''
    this.cfg.username = me?.username || ''
    this.saveCfg()
    await this.dropClient()
    this.client = p.client
    this.pending = null
    this.log('登录成功')
    return { step: 'done', name: this.cfg.name, username: this.cfg.username, saved: !!this.secure.available() }
  }

  async cancelLogin() {
    const p = this.pending
    this.pending = null
    if (p && p.client && p.client !== this.client) { try { await p.client.destroy() } catch {} }
  }

  /** 退出：通知 Telegram 结束这个会话（尽力），删掉本地会话。api_id / api_hash / 代理保留，方便下次登录 */
  async logout({ forgetApi = false } = {}) {
    await this.cancelLogin()
    let remote = false
    if (this.session()) {
      try {
        const c = this.client || await withTimeout(this.getClient(), 15000)
        await withTimeout(c.invoke(new this.lib.Api.auth.LogOut()), 10000)
        remote = true
      } catch (e) { this.log('通知服务器退出失败（本地仍会删除会话）：' + (e?.errorMessage || e?.message)) }
    }
    await this.dropClient()
    this.clearSession()
    this.cfg.name = ''; this.cfg.username = ''
    if (forgetApi) { delete this.cfg.apiId; delete this.cfg.apiHash }
    this.saveCfg()
    this.log('已退出 Telegram 登录')
    return { remote }
  }

  setProxyText(text) {
    const t = String(text || '').trim()
    if (t) TgS.parseProxy(t) // 格式不对直接抛错
    this.cfg.proxy = t
  }

  /** 保存代理设置（空 = 跟随系统代理），之后重新连接 */
  async setProxy(text) {
    try { this.setProxyText(text) } catch (e) { throw new TgError('proxy', e.message) }
    this.saveCfg()
    await this.dropClient()
    return this.status()
  }

  /** 测试连接（不需要登录）：→ { ok, via } */
  async testConnection() {
    // 只连接、不调用 API：没填 api_id 时用占位值（GramJS 要求非空）
    const id = this.cfg.apiId || 1, hash = this.cfg.apiHash || '0'.repeat(32)
    const c = await this.connectNew(this.session() || '', id, hash)
    const via = this.via
    if (c !== this.client) { try { await c.destroy() } catch {} }
    return { ok: true, via }
  }

  async destroy() { await this.cancelLogin(); await this.dropClient() }
}

module.exports = { TelegramAccount, normalizePhone, checkApi, systemCandidates, withTimeout }
