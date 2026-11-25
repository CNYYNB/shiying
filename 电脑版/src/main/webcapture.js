'use strict'
/**
 * 抖音“网页模式”兜底（对应安卓 WebCapture / BrowserActivity capture 模式）：
 * 分享页直接请求拿不到数据时，用隐藏的浏览器窗口像普通浏览一样打开作品：
 *  1. iesdouyin 分享页（iPhone UA）读 window._ROUTER_DATA；
 *  2. 不行再打开 www.douyin.com/video|note/{id}，通过 DevTools 协议截获 /aweme/v1/web/aweme/detail/ 的返回。
 * 10 秒还没拿到就把窗口显示出来（可能需要完成验证码），最多等 60 秒。
 */
const { BrowserWindow } = require('electron')
const Douyin = require('../core/douyin')
const Net = require('../core/net')
const { PARTITION, CHROME_UA } = require('./cookies')
const { UserError, Cancelled } = require('../core/post')

/** 页面会尝试打开 snssdk1128:// 之类的 App 链接：只允许 http(s)，不要弹出“打开抖音 App” */
function blockExternal(wc) {
  const guard = (e, url) => { if (!/^https?:/i.test(url || e.url || '')) e.preventDefault() }
  wc.on('will-navigate', guard)
  wc.on('will-frame-navigate', guard)
  wc.on('will-redirect', guard)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function capture(id, likelyImages, { log = () => {}, signal, parent, icon } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false
    const win = new BrowserWindow({
      show: false, width: 420, height: 820, parent, icon, title: '网页模式解析：如出现验证码请在这里完成',
      autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    })
    win.on('page-title-updated', e => e.preventDefault())
    const wc = win.webContents
    blockExternal(wc)
    if (process.env.SHIYING_DEBUG) {
      wc.on('did-navigate', (_e, u, code) => console.log('[webcapture] navigate', code, u))
      wc.on('did-fail-load', (_e, code, desc, u) => console.log('[webcapture] fail', code, desc, u))
    }
    const end = (err, post) => {
      if (finished) return
      finished = true
      clearTimeout(showTimer); clearTimeout(killTimer); clearInterval(poll)
      try { wc.debugger.detach() } catch {}
      if (!win.isDestroyed()) win.destroy()
      err ? reject(err) : resolve(post)
    }
    signal?.addEventListener('abort', () => end(new Cancelled()), { once: true })
    win.on('closed', () => end(new UserError('网页模式已关闭，没有拿到作品。可以先在「登录 → 抖音」登录后再试')))

    // 截获网页版 API 的返回
    try {
      wc.debugger.attach('1.3')
      wc.debugger.sendCommand('Network.enable').catch(() => {})
      wc.debugger.on('message', async (_e, method, params) => {
        if (method !== 'Network.loadingFinished' && method !== 'Network.responseReceived') return
        if (method === 'Network.responseReceived') { if (/\/aweme\/v1\/web\/aweme\/detail|\/aweme\/v1\/web\/(?:aweme\/post|multi\/aweme\/detail)/.test(params.response?.url || '')) pending.add(params.requestId); return }
        if (!pending.has(params.requestId)) return
        pending.delete(params.requestId)
        try {
          const r = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
          const p = Douyin.fromWebDetail(body, id)
          if (p) end(null, p)
        } catch {}
      })
    } catch {}
    const pending = new Set()

    // 分享页：读 _ROUTER_DATA
    let stage = 1
    const poll = setInterval(async () => {
      if (finished || wc.isDestroyed()) return
      try {
        const json = await wc.executeJavaScript('window._ROUTER_DATA ? JSON.stringify(window._ROUTER_DATA) : ""', true)
        if (json) {
          const s = Douyin.parseSharePage(`<script>window._ROUTER_DATA = ${json}</script>`)
          if (s.type === 'item') { const p = Douyin.fromItem(s.item, '网页'); if (p.isImages || p.videoUrls.length) return end(null, { ...p, headers: { ...p.headers, 'User-Agent': Net.UA_IPHONE } }) }
          if (s.type === 'filtered') { const u = Douyin.unavailable(s.reason, s.notice, s.detail); if (u.final) return end(u) }
          if (stage === 1) { stage = 2; log('分享页没有数据，改用网页版…'); wc.setUserAgent(CHROME_UA()); win.setSize(1100, 800); win.center(); wc.loadURL(`https://www.douyin.com/${likelyImages ? 'note' : 'video'}/${id}`) }
        }
      } catch (e) { if (process.env.SHIYING_DEBUG) console.log('[webcapture] poll', e.message) }
    }, 1000)

    log('正在用网页模式打开作品…')
    wc.setUserAgent(Net.UA_IPHONE)
    if (process.env.SHIYING_DEBUG) console.log('[webcapture] start', id)
    wc.loadURL(`https://www.iesdouyin.com/share/${likelyImages ? 'note' : 'video'}/${id}/`).catch(e => { if (process.env.SHIYING_DEBUG) console.log('[webcapture] loadURL', e.message) })
    setTimeout(() => { if (!finished && stage === 1) { stage = 2; wc.setUserAgent(CHROME_UA()); win.setSize(1100, 800); win.center(); wc.loadURL(`https://www.douyin.com/${likelyImages ? 'note' : 'video'}/${id}`) } }, 8000)
    const showTimer = setTimeout(() => { if (!finished && !win.isDestroyed()) { log('如果弹出的窗口里有验证码，请完成验证…'); win.show() } }, 12000)
    const killTimer = setTimeout(() => end(new UserError('网页模式也没有拿到作品数据。可以先在「登录 → 抖音」登录后再试，或稍后重试')), 60000)
  })
}

module.exports = { capture, blockExternal }
