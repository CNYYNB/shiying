'use strict'
/**
 * 网络工具（移植自 Net.kt + Resolve）：undici（可走代理）、简单 cookie jar、手动跟随跳转（每一跳都存 cookie）、中文网络错误。
 * 代理：Electron 主进程里用系统代理（session.resolveProxy）调用 setProxy；测试里读 HTTPS_PROXY。
 */
const { fetch, ProxyAgent, Agent } = require('undici')
const { UserError } = require('./post')

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.douyin.com/'

// ------------------------------------------------------------------ cookies

class CookieJar {
  constructor() { this.store = new Map() }
  /** Set-Cookie 头 → 保存 */
  setFromHeader(url, header) {
    const u = new URL(url)
    const parts = header.split(';').map(s => s.trim())
    const eq = parts[0].indexOf('=')
    if (eq <= 0) return
    const name = parts[0].slice(0, eq).trim(), value = parts[0].slice(eq + 1).trim()
    let domain = u.hostname, hostOnly = true, path = '/', expires = Infinity
    for (const a of parts.slice(1)) {
      const i = a.indexOf('='); const k = (i < 0 ? a : a.slice(0, i)).toLowerCase(); const v = i < 0 ? '' : a.slice(i + 1)
      if (k === 'domain' && v) { domain = v.replace(/^\./, '').toLowerCase(); hostOnly = false }
      else if (k === 'path' && v.startsWith('/')) path = v
      else if (k === 'max-age') expires = Date.now() + Number(v) * 1000
      else if (k === 'expires' && expires === Infinity) { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t }
    }
    this.set({ name, value, domain, path, hostOnly, expires })
  }
  set(c) {
    const key = `${c.domain}|${c.path}|${c.name}`
    if (c.expires <= Date.now()) this.store.delete(key); else this.store.set(key, { path: '/', hostOnly: false, expires: Infinity, ...c })
  }
  /** 给请求用的 Cookie 头 */
  header(url) {
    const u = new URL(url); const h = u.hostname.toLowerCase(); const now = Date.now()
    const out = []
    for (const [k, c] of this.store) {
      if (c.expires <= now) { this.store.delete(k); continue }
      const ok = c.hostOnly ? h === c.domain : (h === c.domain || h.endsWith('.' + c.domain))
      if (ok && u.pathname.startsWith(c.path)) out.push(`${c.name}=${c.value}`)
    }
    return out.join('; ')
  }
  names() { return [...this.store.values()].map(c => c.name) }
  clear() { this.store.clear() }
}

const jar = new CookieJar()

// ------------------------------------------------------------------ proxy / dispatcher

let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null
/** 可选：按网址解析代理（Electron 里用 session.resolveProxy，支持系统代理 / PAC）。返回 "http://host:port" 或 null */
let proxyResolver = null
const dispatchers = new Map()
function setProxy(url) { proxyUrl = url || null }
function setProxyResolver(fn) { proxyResolver = fn }
function getProxy() { return proxyUrl }
function dispatcherFor(proxy) {
  const k = proxy || 'DIRECT'
  if (!dispatchers.has(k)) {
    const opts = { connect: { timeout: 10_000 }, headersTimeout: 20_000, bodyTimeout: 30_000 }
    dispatchers.set(k, proxy ? new ProxyAgent({ uri: proxy, ...opts }) : new Agent(opts))
  }
  return dispatchers.get(k)
}
async function getDispatcher(url) {
  let proxy = proxyUrl
  if (proxyResolver && url) { try { proxy = await proxyResolver(url) } catch { proxy = proxyUrl } }
  return dispatcherFor(proxy)
}

// ------------------------------------------------------------------ requests

/**
 * 发一个请求（不自动跟随跳转），带上 / 保存 cookies。返回 undici Response。
 * opts: ua, referer, headers, signal, timeout(ms, 默认 40s)
 */
async function rawRequest(url, opts = {}) {
  const headers = {
    'User-Agent': opts.ua || UA_IPHONE,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...(opts.referer ? { Referer: opts.referer } : {}),
    ...(opts.headers || {}),
  }
  const ck = jar.header(url)
  if (ck && !headers.Cookie) headers.Cookie = ck
  const signals = []
  if (opts.signal) signals.push(opts.signal)
  if (opts.timeout !== 0) signals.push(AbortSignal.timeout(opts.timeout || 40_000))
  const r = await fetch(url, { headers, redirect: 'manual', dispatcher: await getDispatcher(url), signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] })
  for (const sc of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { try { jar.setFromHeader(url, sc) } catch {} }
  return r
}

const isRedirect = s => [301, 302, 303, 307, 308].includes(s)

/** GET 并跟随跳转。返回 { code, finalUrl, body }。网络错误 / HTTP ≥ 500 抛异常（同 Net.fetch） */
async function fetchPage(url, ua, referer, opts = {}) {
  let cur = url
  for (let hop = 0; hop < 10; hop++) {
    const r = await rawRequest(cur, { ...opts, ua, referer })
    const loc = r.headers.get('location')
    if (isRedirect(r.status) && loc) { await r.body?.cancel().catch(() => {}); cur = new URL(loc, cur).toString(); continue }
    if (r.status >= 500) { await r.body?.cancel().catch(() => {}); throw netErr(`HTTP ${r.status}`) }
    return { code: r.status, finalUrl: cur, body: await r.text() }
  }
  throw new UserError('跳转次数过多')
}

/** 同 Extractor.getText：非 2xx 抛异常 */
async function getText(url, ua = UA_IPHONE, referer = null) {
  const r = await fetchPage(url, ua, referer)
  if (r.code < 200 || r.code >= 300) throw netErr(`HTTP ${r.code}`)
  return r.body
}

function netErr(msg) { const e = new Error(msg); e.isNet = true; return e }

/** 网络错误 → 中文 */
function netMessage(e) {
  if (!e) return '网络错误'
  const code = e.code || e.cause?.code || ''
  const m = String(e.message || '') + ' ' + String(e.cause?.message || '')
  if (/ENOTFOUND|EAI_AGAIN/.test(code) || /getaddrinfo/.test(m)) return '无法连接网络（域名解析失败），请检查网络'
  if (e.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code) || /timed? ?out/i.test(m)) return '网络超时，请稍后重试'
  if (/CERT|TLS|SSL|ECONNRESET/i.test(code) || /ssl|tls|certificate/i.test(m)) return '安全连接失败，可能是网络或代理拦截'
  if (/ECONNREFUSED/.test(code)) return '连接被拒绝，请检查网络或代理设置'
  return '网络错误：' + (String(e.message || e.name || '').slice(0, 60))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 是否网络层异常（不是我们自己的 UserError） */
function isNetError(e) { return e && !(e instanceof UserError) && e.name !== 'PostUnavailable' && e.name !== 'Cancelled' }

/**
 * 手动跟随跳转（最多 10 跳），直到 done(url) 接受；返回最后到达的 URL（移植自 Resolve.follow）。
 * 也处理用页面 / meta refresh 跳转的短链接。
 */
async function follow(url0, ua, done = () => false) {
  const url = url0.startsWith('http://') ? 'https://' + url0.slice(7) : url0
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let cur = url
    try {
      for (let hop = 0; hop < 10; hop++) {
        const r = await rawRequest(cur, { ua })
        const loc = r.headers.get('location')
        if (isRedirect(r.status) && loc) {
          await r.body?.cancel().catch(() => {})
          cur = new URL(loc, cur).toString()
          if (done(cur)) return cur
          continue
        }
        if (r.status === 404) { await r.body?.cancel().catch(() => {}); throw new UserError('短链接无效或已过期（HTTP 404），请重新复制分享链接') }
        if (r.status >= 500) { await r.body?.cancel().catch(() => {}); throw netErr(`HTTP ${r.status}`) }
        const body = await r.text()
        const m = /(?:http-equiv=["']?refresh["']?[^>]*url=|location\.(?:href|replace)\(?\s*=?\s*["'])(https?:\/\/[^"'>\s)]+)/i.exec(body)
        if (m) { const n = m[1].replace(/&amp;/g, '&'); if (n !== cur) { cur = n; if (done(cur)) return cur; continue } }
        return cur
      }
      return cur
    } catch (e) {
      if (!isNetError(e)) throw e
      lastErr = e; await sleep(500 * (attempt + 1))
    }
  }
  throw new UserError(netMessage(lastErr))
}

module.exports = { UA_IPHONE, UA_DESKTOP, REFERER, CookieJar, jar, setProxy, setProxyResolver, getProxy, getDispatcher, rawRequest, fetchPage, getText, netMessage, netErr, isNetError, follow, sleep, isRedirect }
