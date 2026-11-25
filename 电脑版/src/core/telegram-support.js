'use strict'
/**
 * Telegram 的纯函数部分（不联网、不依赖 GramJS / Electron，可单测）：
 *  - parseLink：t.me / telegram.me / telegram.dog / tg:// 消息链接 → { kind, username | channelId, msgId, … }
 *  - parseProxy：设置里的 SOCKS5 / MTProxy 文字 → GramJS 的 proxy 参数
 *  - errorMessage：GramJS / MTProto 错误 → 中文说明
 *  - mediaItems：消息 → 要下载的视频 / 图片（按 className 判断，测试可以用普通对象）
 *  - redact：诊断日志脱敏（session、api_hash、手机号、验证码、两步验证密码）
 */

const HOSTS = ['t.me', 'telegram.me', 'telegram.dog']
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{2,31}$/
/** t.me 下面不是频道 / 用户名的路径 */
const RESERVED = new Set(['addstickers', 'addemoji', 'addtheme', 'share', 'proxy', 'socks', 'setlanguage', 'iv', 'login', 'bg',
  'confirmphone', 'invoice', 'joinchat', 'contact', 'boost', 'giftcode', 'addlist', 'm', 'a', 'k', 'z', 'web', 'stickers', 'emoji', 'auth', 'nft', 'premium_offer'])

class TgLinkError extends Error {
  constructor(reason, msg) { super(msg); this.name = 'TgLinkError'; this.reason = reason }
}

const MSG = {
  invite: '这是 Telegram 的邀请链接，不是某条消息的链接。请先用这个链接在 Telegram 里加入，再在要下载的消息上右键 →「复制消息链接」',
  noMessage: '这是频道 / 用户主页的链接，不是某条消息的链接。请在要下载的消息上右键（手机长按）→「复制消息链接」',
  notMessage: '这不是 Telegram 消息链接。请在要下载的消息上右键（手机长按）→「复制消息链接」',
  bad: 'Telegram 链接格式不对。请在要下载的消息上右键（手机长按）→「复制消息链接」后重新粘贴',
}

const isTgHost = h => {
  const x = String(h || '').toLowerCase().replace(/^www\./, '')
  return HOSTS.includes(x) || HOSTS.some(d => x.endsWith('.' + d))
}

const posInt = s => (/^\d{1,12}$/.test(String(s || '')) && Number(s) > 0 ? Number(s) : null)

function queryFlags(sp) {
  return {
    single: sp.has('single'),
    commentId: posInt(sp.get('comment')),
    threadId: posInt(sp.get('thread')),
  }
}

/**
 * 解析 Telegram 消息链接。返回
 *   { kind: 'username', username, msgId, topicId, threadId, commentId, single, url }
 *   { kind: 'channel', channelId (字符串，不带 -100), msgId, … }
 * 不是消息链接时抛 TgLinkError（reason: invite / no_message / not_message / bad）。
 */
function parseLink(input) {
  let raw = String(input || '').trim()
  if (!raw) throw new TgLinkError('bad', MSG.bad)
  if (/^tg:\/\//i.test(raw)) return parseTgScheme(raw)
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw
  let u
  try { u = new URL(raw) } catch { throw new TgLinkError('bad', MSG.bad) }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (!isTgHost(host)) throw new TgLinkError('not_message', MSG.notMessage)
  let parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  // 用户名子域名：name.t.me/123
  const sub = HOSTS.map(d => host.endsWith('.' + d) ? host.slice(0, -(d.length + 1)) : null).find(Boolean)
  if (sub) parts = [sub, ...parts]
  const flags = queryFlags(u.searchParams)
  if (!parts.length) throw new TgLinkError('not_message', MSG.notMessage)
  const first = parts[0]
  if (first.startsWith('+') || first.toLowerCase() === 'joinchat') throw new TgLinkError('invite', MSG.invite)
  if (/^(proxy|socks)$/i.test(first)) throw new TgLinkError('not_message', '这是 Telegram 代理链接。请把它填到「登录 → Telegram → 代理」里，不是在这里解析')
  // 网页预览 t.me/s/name/123
  if (first.toLowerCase() === 's') parts = parts.slice(1)
  if (!parts.length) throw new TgLinkError('not_message', MSG.notMessage)

  if (parts[0].toLowerCase() === 'c') {
    const channelId = /^\d{1,16}$/.test(parts[1] || '') ? parts[1].replace(/^0+/, '') : null
    if (!channelId) throw new TgLinkError('bad', MSG.bad)
    const nums = parts.slice(2).map(posInt)
    if (!nums.length) throw new TgLinkError('no_message', MSG.noMessage)
    if (nums.some(n => n == null) || nums.length > 2) throw new TgLinkError('bad', MSG.bad)
    const msgId = nums[nums.length - 1]
    const topicId = nums.length === 2 ? nums[0] : null
    return finish({ kind: 'channel', channelId, msgId, topicId, ...flags })
  }

  const name = parts[0]
  if (RESERVED.has(name.toLowerCase())) throw new TgLinkError('not_message', MSG.notMessage)
  if (!USERNAME.test(name)) throw new TgLinkError('bad', MSG.bad)
  const nums = parts.slice(1).map(posInt)
  if (!nums.length) throw new TgLinkError('no_message', MSG.noMessage)
  if (nums.some(n => n == null) || nums.length > 2) throw new TgLinkError('bad', MSG.bad)
  const msgId = nums[nums.length - 1]
  const topicId = nums.length === 2 ? nums[0] : null
  return finish({ kind: 'username', username: name, msgId, topicId, ...flags })
}

function parseTgScheme(raw) {
  let u
  try { u = new URL(raw.replace(/^tg:\/\//i, 'https://tg.invalid/')) } catch { throw new TgLinkError('bad', MSG.bad) }
  const what = u.pathname.replace(/^\/+/, '').toLowerCase()
  const sp = u.searchParams
  const flags = queryFlags(sp)
  const msgId = posInt(sp.get('post'))
  if (what === 'resolve') {
    const name = sp.get('domain') || ''
    if (!USERNAME.test(name)) throw new TgLinkError('bad', MSG.bad)
    if (!msgId) throw new TgLinkError('no_message', MSG.noMessage)
    return finish({ kind: 'username', username: name, msgId, topicId: null, ...flags })
  }
  if (what === 'privatepost') {
    const ch = sp.get('channel') || ''
    if (!/^\d{1,16}$/.test(ch)) throw new TgLinkError('bad', MSG.bad)
    if (!msgId) throw new TgLinkError('no_message', MSG.noMessage)
    return finish({ kind: 'channel', channelId: ch.replace(/^0+/, ''), msgId, topicId: null, ...flags })
  }
  if (what === 'join') throw new TgLinkError('invite', MSG.invite)
  throw new TgLinkError('not_message', MSG.notMessage)
}

function finish(l) {
  const q = []
  if (l.single) q.push('single')
  if (l.commentId) q.push('comment=' + l.commentId)
  if (l.threadId) q.push('thread=' + l.threadId)
  const path = l.kind === 'channel' ? `c/${l.channelId}` : l.username
  l.url = `https://t.me/${path}/${l.topicId ? l.topicId + '/' : ''}${l.msgId}${q.length ? '?' + q.join('&') : ''}`
  /** 不登录时能不能交给 yt-dlp（只有公开频道的普通帖子） */
  l.publicFallback = l.kind === 'username' && !l.commentId
  return l
}

/** 文字里的 tg:// 消息链接 → https://t.me/… （让平台识别能认出来） */
function tgSchemeToHttps(text) {
  const m = /tg:\/\/(resolve|privatepost)\?[A-Za-z0-9_=&%.-]+/i.exec(String(text || ''))
  if (!m) return null
  try { return parseLink(m[0]).url } catch { return null }
}

// ------------------------------------------------------------------ proxy

/**
 * 设置里的代理 → GramJS proxy 参数。支持：
 *   socks5://[用户:密码@]主机:端口、主机:端口（当作 SOCKS5）、tg://socks?… / https://t.me/socks?…
 *   tg://proxy?server=…&port=…&secret=… / https://t.me/proxy?…（MTProxy；只支持普通 / dd 密钥，不支持 ee 开头的 FakeTLS）
 * 空 → null。格式不对抛 Error（中文）。
 */
function parseProxy(text) {
  const s = String(text || '').trim()
  if (!s) return null
  const T = 10
  if (/^(tg:\/\/|https?:\/\/(www\.)?(t\.me|telegram\.me)\/)(proxy|socks)\?/i.test(s)) {
    const u = new URL(s.replace(/^tg:\/\//i, 'https://tg.invalid/'))
    const kind = u.pathname.replace(/^\/+/, '').toLowerCase()
    const ip = u.searchParams.get('server'), port = Number(u.searchParams.get('port'))
    if (!ip || !(port > 0 && port < 65536)) throw new Error('代理链接里缺少服务器或端口')
    if (kind === 'socks') return { ip, port, socksType: 5, username: u.searchParams.get('user') || undefined, password: u.searchParams.get('pass') || undefined, timeout: T }
    return { ip, port, secret: mtSecret(u.searchParams.get('secret')), MTProxy: true, timeout: T }
  }
  if (/^https?:\/\//i.test(s)) throw new Error('Telegram 不支持 HTTP 代理，请填 SOCKS5 代理（Clash / v2rayN 的 SOCKS 或「混合」端口，例如 socks5://127.0.0.1:7890）或 MTProxy 链接')
  let rest = s
  const m = /^(socks5h?|socks):\/\//i.exec(s)
  if (m) rest = s.slice(m[0].length)
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error('只支持 socks5:// 开头的代理或 MTProxy 链接')
  let username, password
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    const cred = rest.slice(0, at); rest = rest.slice(at + 1)
    const c = cred.indexOf(':')
    username = decodeURIComponent(c >= 0 ? cred.slice(0, c) : cred)
    password = c >= 0 ? decodeURIComponent(cred.slice(c + 1)) : undefined
  }
  rest = rest.replace(/\/+$/, '')
  const hp = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(rest)
  if (!hp || !(Number(hp[2]) > 0 && Number(hp[2]) < 65536)) throw new Error('代理格式不对，应该像 socks5://127.0.0.1:7890')
  return { ip: hp[1], port: Number(hp[2]), socksType: 5, username, password, timeout: T }
}

function mtSecret(sec) {
  let s = String(sec || '').trim()
  if (!s) throw new Error('MTProxy 链接里缺少 secret')
  if (!/^[0-9a-f]+$/i.test(s)) {
    try { s = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex') } catch { throw new Error('MTProxy 的 secret 格式不对') }
  }
  s = s.toLowerCase()
  if (s.startsWith('ee')) throw new Error('这个 MTProxy 是 FakeTLS（secret 以 ee 开头），拾影用的 GramJS 不支持。请换普通 / dd 开头的 MTProxy，或用 SOCKS5 代理')
  if (!(s.length === 32 || (s.length === 34 && s.startsWith('dd')))) throw new Error('MTProxy 的 secret 应该是 32 位十六进制（或 dd 开头 34 位）')
  return s
}

/** 用于界面显示（不含密码） */
function describeProxy(p) {
  if (!p) return '直连'
  return p.MTProxy ? `MTProxy ${p.ip}:${p.port}` : `SOCKS5 ${p.ip}:${p.port}${p.username ? '（带用户名）' : ''}`
}

// ------------------------------------------------------------------ errors

const PROTECTED_MSG = '该频道/聊天禁止保存内容，拾影不下载这类内容'
const NET_HINT = '请检查网络。在国内需要代理：打开「登录 → Telegram」，在「代理」里填 SOCKS5（如 socks5://127.0.0.1:7890，Clash / v2rayN 的 SOCKS 或混合端口）或 MTProxy 链接，再试'

/** 错误里的 RPC 名（FLOOD_WAIT_30 / CHANNEL_PRIVATE …）和等待秒数 */
function rpcInfo(e) {
  const em = String(e?.errorMessage || '')
  let seconds = Number.isFinite(e?.seconds) ? e.seconds : null
  const text = em || String(e?.message || e || '')
  const m = /(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|TAKEOUT_INIT_DELAY)_(\d+)/.exec(text) || /wait of (\d+) seconds/i.exec(text)
  if (seconds == null && m) seconds = Number(m[1])
  return { name: em || (/\b([A-Z][A-Z0-9_]{4,})\b/.exec(text) || [])[1] || '', seconds, text }
}

/**
 * 错误 → { kind, message }。kind：protected / flood / no_access / deleted / not_found / invalid / net / auth_* / session / other。
 * stage: 'login' | 'parse' | 'download'（影响少数提示的说法）
 */
function classifyError(e, stage = 'parse') {
  if (e && e.name === 'TgLinkError') return { kind: 'invalid', message: e.message }
  if (e && e.tgKind && e.message) return { kind: e.tgKind, message: e.message }
  const { name, seconds, text } = rpcInfo(e)
  const n = name.toUpperCase()
  const k = (kind, message) => ({ kind, message })
  if (seconds != null && /FLOOD|SLOWMODE|wait of/i.test(n + text)) {
    return k('flood', `请求太频繁，Telegram 要求等待 ${seconds} 秒（约 ${fmtWait(seconds)}）后再试`)
  }
  if (/CHAT_FORWARDS_RESTRICTED|NOFORWARDS|FORWARDS_RESTRICTED/.test(n)) return k('protected', PROTECTED_MSG)
  if (/^(CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT|CHAT_RESTRICTED|USER_BANNED_IN_CHANNEL|CHANNEL_PUBLIC_GROUP_NA|PEER_ID_INVALID|CHAT_ID_INVALID|INVITE_HASH_EXPIRED)$/.test(n)) {
    return k('no_access', '没有权限看这条消息：你的账号不在这个频道 / 群组里，或已被移出 / 封禁。请先用这个账号在 Telegram 里加入，再复制消息链接')
  }
  if (/^(USERNAME_NOT_OCCUPIED|USERNAME_INVALID)$/.test(n) || /No user has .* as username|Cannot find any entity/i.test(text)) {
    return k('not_found', '链接里的频道 / 用户不存在（可能改了用户名或已被删除），请重新复制消息链接')
  }
  if (/^(MSG_ID_INVALID|MESSAGE_ID_INVALID|MESSAGE_IDS_EMPTY)$/.test(n)) return k('deleted', '这条消息不存在或已被删除')
  if (/^(FILE_REFERENCE_EXPIRED|FILE_REFERENCE_INVALID)$/.test(n)) return k('retry', '文件地址过期了，请重新解析这条链接再下载')
  // 登录相关
  if (/^(API_ID_INVALID|API_ID_PUBLISHED_FLOOD)$/.test(n)) return k('auth_api', 'api_id 或 api_hash 不对（或这个 api_id 被 Telegram 限制了）。请到 my.telegram.org → API development tools 重新复制')
  if (/^PHONE_NUMBER_INVALID$/.test(n)) return k('auth_phone', '手机号格式不对。请带国家区号，例如 +8613800138000')
  if (/^PHONE_NUMBER_BANNED$/.test(n)) return k('auth_phone', '这个手机号被 Telegram 封禁了')
  if (/^(PHONE_NUMBER_FLOOD|PHONE_PASSWORD_FLOOD|PHONE_NUMBER_UNOCCUPIED)$/.test(n)) {
    return n === 'PHONE_NUMBER_UNOCCUPIED' ? k('auth_phone', '这个手机号还没有注册 Telegram。请先在手机上注册') : k('flood', '尝试次数太多，Telegram 暂时不让登录，请过几个小时再试')
  }
  if (/^PHONE_CODE_INVALID$/.test(n)) return k('auth_code', '验证码不对，请再看一下 Telegram 发来的验证码')
  if (/^PHONE_CODE_EXPIRED$/.test(n)) return k('auth_code_expired', '验证码过期了，请点「重新发送验证码」')
  if (/^PHONE_CODE_EMPTY$/.test(n)) return k('auth_code', '请输入验证码')
  if (/^PASSWORD_HASH_INVALID$/.test(n)) return k('auth_password', '两步验证密码不对')
  if (/^(AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|AUTH_KEY_DUPLICATED)$/.test(n)) {
    return k('session', 'Telegram 登录已失效（可能在其他设备上退出了这个会话），请重新登录')
  }
  if (/^(SESSION_PASSWORD_NEEDED)$/.test(n)) return k('auth_need_password', '这个账号开了两步验证，请输入两步验证密码')
  // 网络
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed? ?out|Connection to telegram failed|Not connected|connection closed|Socket closed|socks|Proxy connection|disconnected/i.test(text)) {
    return k('net', (stage === 'login' ? '连不上 Telegram 服务器，无法登录。' : '连不上 Telegram 服务器。') + NET_HINT)
  }
  return k('other', 'Telegram 出错了：' + String(n || text).slice(0, 160))
}

function fmtWait(s) {
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟`
  return `${(s / 3600).toFixed(1)} 小时`
}

function errorMessage(e, stage) { return classifyError(e, stage).message }

// ------------------------------------------------------------------ media

const num = v => (v == null ? 0 : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v.toJSNumber === 'function' ? v.toJSNumber() : Number(String(v)) || 0)
const attr = (doc, cls) => (doc?.attributes || []).find(a => a && a.className === cls)

const MIME_EXT = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/x-msvideo': '.avi', 'video/3gpp': '.3gp', 'video/mpeg': '.mpg',
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/avif': '.avif', 'image/bmp': '.bmp',
}

function extFor(doc, fallback) {
  const mime = String(doc?.mimeType || '').toLowerCase()
  if (MIME_EXT[mime]) return MIME_EXT[mime]
  const fn = attr(doc, 'DocumentAttributeFilename')?.fileName || ''
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(fn)
  return m ? '.' + m[1].toLowerCase() : fallback
}

function isVideoDoc(d) {
  if (!d || d.className !== 'Document') return false
  if (attr(d, 'DocumentAttributeSticker')) return false
  return String(d.mimeType || '').toLowerCase().startsWith('video/') || !!attr(d, 'DocumentAttributeVideo')
}
function isImageDoc(d) {
  if (!d || d.className !== 'Document') return false
  if (attr(d, 'DocumentAttributeSticker')) return false
  return String(d.mimeType || '').toLowerCase().startsWith('image/')
}

function photoSize(photo) {
  let best = 0, w = 0, h = 0
  for (const s of photo?.sizes || []) {
    const sz = s.className === 'PhotoSizeProgressive' ? Math.max(...(s.sizes || [0])) : num(s.size)
    if ((s.w || 0) * (s.h || 0) >= w * h) { w = s.w || w; h = s.h || h }
    best = Math.max(best, sz)
  }
  return { size: best, w, h }
}

/**
 * 一条消息里要下载的东西（最多一个：Telegram 一条消息只带一个媒体；相册是多条消息）。
 * → [{ msgId, kind: 'video'|'gif'|'photo'|'image', alt: -1|下标, size, ext, w, h, duration, mime }]
 * 视频：主文件和 altDocuments（不同清晰度）里挑最大的。
 */
function mediaItems(msg) {
  const media = msg?.media
  if (!media) return []
  const msgId = msg.id
  if (media.className === 'MessageMediaPhoto') {
    if (!media.photo || media.photo.className !== 'Photo') return []
    const { size, w, h } = photoSize(media.photo)
    return [{ msgId, kind: 'photo', alt: -1, size, ext: '.jpg', w, h, duration: 0, mime: 'image/jpeg' }]
  }
  if (media.className === 'MessageMediaDocument') {
    const main = media.document
    const cands = [[-1, main], ...(media.altDocuments || []).map((d, i) => [i, d])].filter(([, d]) => isVideoDoc(d))
    if (cands.length) {
      cands.sort((a, b) => num(b[1].size) - num(a[1].size))
      const [alt, d] = cands[0]
      const va = attr(d, 'DocumentAttributeVideo') || attr(main, 'DocumentAttributeVideo') || {}
      const gif = !!attr(d, 'DocumentAttributeAnimated') || !!attr(main, 'DocumentAttributeAnimated')
      return [{ msgId, kind: gif ? 'gif' : 'video', alt, size: num(d.size), ext: extFor(d, '.mp4'), w: va.w || 0, h: va.h || 0, duration: Number(va.duration) || 0, mime: d.mimeType || 'video/mp4' }]
    }
    if (isImageDoc(main)) {
      const ia = attr(main, 'DocumentAttributeImageSize') || {}
      return [{ msgId, kind: 'image', alt: -1, size: num(main.size), ext: extFor(main, '.jpg'), w: ia.w || 0, h: ia.h || 0, duration: 0, mime: main.mimeType }]
    }
  }
  return []
}

/** 没有可下载媒体时，说明一下这条消息里是什么 */
function noMediaReason(msg) {
  const c = msg?.media?.className || ''
  if (!c) return '这条消息里没有视频或图片（只有文字）'
  if (c === 'MessageMediaPaidMedia') return '这是付费内容，拾影不下载'
  if (c === 'MessageMediaWebPage') return '这条消息只有网页预览，没有 Telegram 里的视频或图片。可以复制里面的网页链接到拾影解析'
  if (c === 'MessageMediaDocument') {
    const d = msg.media.document
    if (attr(d, 'DocumentAttributeSticker')) return '这是贴纸，拾影不下载'
    if (attr(d, 'DocumentAttributeAudio')) return '这是音频 / 语音，拾影只下载视频和图片'
    return '这条消息是普通文件（不是视频或图片），请在 Telegram 里直接保存'
  }
  return '这条消息里没有视频或图片'
}

/** 同一相册（grouped_id）的消息，按 id 排序 */
function albumOf(msg, around) {
  const g = msg?.groupedId
  if (g == null) return [msg]
  const key = String(g)
  const list = (around || []).filter(m => m && m.className !== 'MessageEmpty' && m.groupedId != null && String(m.groupedId) === key)
  if (!list.some(m => m.id === msg.id)) list.push(msg)
  return list.sort((a, b) => a.id - b.id)
}

/** 相册周围要取的消息 id（Telegram 相册最多 10 条） */
function albumWindow(msgId) {
  const ids = []
  for (let i = Math.max(1, msgId - 9); i <= msgId + 9; i++) ids.push(i)
  return ids
}

/** 消息或聊天禁止保存（noforwards） */
function isProtected(msg, chat) { return !!(msg?.noforwards || chat?.noforwards) }

// ------------------------------------------------------------------ redact

/**
 * 诊断日志脱敏。secrets：已知的敏感值（api_hash、手机号、验证码、密码、session）逐个替换；
 * 另外按格式隐藏：长 base64（StringSession）、32 位十六进制（api_hash）、手机号、5–6 位验证码、auth key。
 */
function redact(text, secrets = []) {
  let s = String(text == null ? '' : text)
  for (const v of secrets.filter(x => x != null && String(x).length >= 3).map(String).sort((a, b) => b.length - a.length)) {
    s = s.split(v).join('<已隐藏>')
    const digits = v.replace(/\D/g, '')
    if (digits.length >= 7 && digits !== v) s = s.split(digits).join('<已隐藏>')
  }
  s = s.replace(/\b1?[A-Za-z0-9+/_-]{120,}={0,2}/g, '<已隐藏 session>')
  s = s.replace(/\b[0-9a-f]{32}\b/gi, '<已隐藏 api_hash>')
  s = s.replace(/(api_?hash|apiHash|session|password|phone_?code|phoneCode|code|phone(?:_?number)?|phoneNumber)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, (m, k, sep) => k + sep + '<已隐藏>')
  s = s.replace(/\+\d[\d\s-]{6,16}\d/g, '<已隐藏手机号>')
  s = s.replace(/(?<![\d.])\d{11,15}(?![\d.])/g, m => (m.length >= 11 && m.length <= 15 ? '<已隐藏手机号>' : m))
  return s
}

module.exports = {
  HOSTS, TgLinkError, parseLink, tgSchemeToHttps, parseProxy, describeProxy, classifyError, errorMessage, rpcInfo,
  mediaItems, noMediaReason, albumOf, albumWindow, isProtected, redact, PROTECTED_MSG, num, isVideoDoc, extFor,
}
