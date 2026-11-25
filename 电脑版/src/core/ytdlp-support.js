'use strict'
/**
 * yt-dlp 集成的纯逻辑部分（移植自 YtdlpSupport.kt）：命令行参数、info JSON → 作品、yt-dlp 错误 → 中文。
 * 进程、cookies、更新在 engine.js。
 */
const Links = require('./links')
const Quality = require('./quality')
const { Platform } = require('./platform')
const { makePost, UserError } = require('./post')

const sortArg = q => Quality.sortArg(q)

/** 格式选择。TikTok：永远不选带水印的 download 格式 */
function formatArg(platform) {
  return platform.name === 'TIKTOK' ? 'bv*[format_note!*=atermark]+ba/b[format_note!*=atermark]/bv*+ba/b' : 'bv*+ba/b'
}

function common(cookieFile, verbose = false) {
  const a = [verbose ? '-v' : '--no-warnings', '--no-playlist', '--playlist-items', '1:30',
    '--socket-timeout', '20', '--retries', '3', '--extractor-retries', '2', '--no-mtime', '--no-colors']
  if (cookieFile) a.push('--cookies', cookieFile)
  return a
}

/** 解析步骤的参数（stdout = 一个 JSON）。URL 由调用方加 */
function infoOptions(platform, quality, cookieFile) {
  if (platform.name === 'YOUTUBE') return youtubeInfoOptions(quality, cookieFile)
  return [...common(cookieFile), '-f', formatArg(platform), '-S', sortArg(quality), '--dump-single-json']
}

/**
 * YouTube 第一次尝试 = YTDLnis 的默认做法：yt-dlp 默认客户端（不加 --extractor-args），cookies 只在真正登录时带，
 * --no-check-certificates，不加 --proxy。-v 保留完整日志给「复制诊断日志」。
 */
function youtubeInfoOptions(quality, cookieFile) {
  return [...common(cookieFile, true), '--no-check-certificates', '-f', formatArg(Platform.YOUTUBE), '-S', sortArg(quality), '--dump-single-json']
}

/** 下载步骤的参数：复用解析时写下的 info JSON */
function downloadOptions(platform, quality, cookieFile, infoJson, outDir, sep = '/') {
  return [...common(cookieFile), ...(platform.name === 'YOUTUBE' ? ['--no-check-certificates'] : []),
    '-f', formatArg(platform), '-S', sortArg(quality),
    '--load-info-json', infoJson,
    '-o', `${outDir}${sep}%(autonumber)03d-%(id).40B.%(ext)s`,
    '--merge-output-format', 'mp4',
    '--concurrent-fragments', '4',
    '--newline',
    '--progress-template', 'download:[shiying-progress] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
  ]
}

/** 把链接改成 yt-dlp 更好处理的形式 */
function normalizeUrl(url) {
  let m = /ixigua\.com\/(?:i|item\/)?(\d{15,21})/.exec(url)
  if (m) return `https://www.toutiao.com/video/${m[1]}/`
  m = /toutiao\.com\/(?:a|i|group\/|article\/|w\/)?(\d{15,21})/.exec(url)
  if (m && !url.includes('/video/')) return `https://www.toutiao.com/video/${m[1]}/`
  m = /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/.exec(url)
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`
  return url
}

/** 交给 yt-dlp 前要先展开的短链接 */
function needsExpand(url) {
  const h = Links.host(url)
  return h === 'b23.tv' || h.endsWith('.b23.tv') || h.startsWith('bili2233.') || h.startsWith('bili22.') || h.startsWith('bili33.') ||
    h === 't.cn' || h === 'v.ixigua.com' || (h === 'm.toutiao.com' && url.includes('/is/')) || h === 'vt.tiktok.com' || h === 'vm.tiktok.com'
}

// ------------------------------------------------------------------ info JSON

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
function bestHeight(o) {
  let h = num(o.height)
  if (Array.isArray(o.requested_formats)) for (const f of o.requested_formats) h = Math.max(h, num(f && f.height))
  const w = num(o.width)
  return w >= 1 && w < h ? w : h // 竖屏视频报短边（"1080p"）
}
const hasMedia = o => (Array.isArray(o.formats) && o.formats.length > 0) || String(o.url || '').startsWith('http') || Array.isArray(o.requested_formats)

/** `--dump-single-json` 输出 → 作品。没有可下载内容的合集抛 UserError */
function parseInfo(json, platform, pageUrl, infoPath) {
  const s = String(json || '')
  const start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new UserError('解析引擎没有返回作品信息')
  let o
  try { o = JSON.parse(s.substring(start, end + 1)) } catch { throw new UserError('解析引擎返回的信息无法读取') }
  const isList = o._type === 'playlist' || 'entries' in o
  const entries = isList ? (Array.isArray(o.entries) ? o.entries : []).filter(e => e && typeof e === 'object' && hasMedia(e)) : [o]
  if (!entries.length) throw new UserError('这条内容里没有可下载的视频（可能是纯图片、直播或需要登录）')
  const first = entries[0]
  const str = (...keys) => {
    for (const k of keys) {
      const v0 = o[k] != null && o[k] !== '' ? o[k] : first[k]
      const v = v0 == null ? '' : String(v0)
      if (v.trim() && v !== 'null') return v
    }
    return ''
  }
  let title = str('title', 'fulltitle')
  const desc = str('description')
  // TikTok / X / Instagram 的 title 常是通用文字，正文在 description
  if (desc.trim() && (!title.trim() || title.startsWith('Video by') || title.startsWith('Post by') || /^tiktok video #\d+$/i.test(title))) title = desc
  const author = str('uploader', 'channel', 'creator', 'uploader_id', 'artist')
  const dur = entries.reduce((a, e) => a + num(e.duration), 0)
  const id = str('id', 'display_id')
  let thumb = str('thumbnail')
  if (!thumb && Array.isArray(first.thumbnails)) {
    for (let i = first.thumbnails.length - 1; i >= 0; i--) { const u = String(first.thumbnails[i]?.url || ''); if (u.startsWith('http')) { thumb = u; break } }
  }
  return makePost({
    id, isImages: false,
    desc: desc.trim() && desc !== title ? `${title}\n${desc}` : title,
    author, cover: thumb.trim() ? thumb : null,
    durationMs: Math.trunc(dur * 1000),
    source: '解析引擎', platform,
    pageUrl: String(o.webpage_url || '').trim() ? o.webpage_url : pageUrl,
    engine: 'ytdlp', infoJson: infoPath, entries: entries.length,
    height: Math.max(...entries.map(bestHeight)),
  })
}

// ------------------------------------------------------------------ YouTube

/** 不需要 PO token 的客户端（yt-dlp 2026.11：tv*、ios_producer、visionos）+ web_embedded / android_vr */
const YT_ALT_CLIENTS = 'youtube:player_client=tv,tv_downgraded,ios_producer,visionos,web_embedded,android_vr'

function youtubeId(url) {
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{11})/.exec(url || '')
  return m ? m[1] : null
}

const lines = s => String(s || '').split(/\r?\n/).map(l => l.trim())

/** 只看 ERROR / WARNING 行：-v 时 [debug] 行里会出现 "PO Token"、"cookies"、"sign in"…，不能拿来归类 */
function problemLines(stderr) {
  const p = lines(stderr).filter(l => l.startsWith('ERROR') || l.startsWith('WARNING')).join('\n')
  if (p.trim()) return p
  return lines(stderr).filter(l => l && !l.startsWith('[')).slice(-3).join('\n')
}
function errorsOnly(stderr) {
  const e = lines(stderr).filter(l => l.startsWith('ERROR')).join('\n')
  return e.trim() ? e : problemLines(stderr)
}

/** YouTube 拒绝了请求，换客户端 / 更新引擎 / 登录可能绕过 */
function ytBlocked(stderr) {
  const all = problemLines(stderr).toLowerCase()
  const s = errorsOnly(stderr).toLowerCase()
  const hit = ['sign in to confirm', 'not a bot', 'failed to extract any player response', 'http error 403', 'http error 429',
    'too many requests', 'requested format is not available', 'only images are available', 'unable to download api page'].some(k => s.includes(k)) ||
    (jsProblem(stderr) && s.includes('format')) ||
    (['http error 403', 'http error 429'].some(k => all.includes(k)) && all.includes('unable to download api page'))
  return hit && !['private video', 'age-restricted', 'confirm your age', 'members-only', 'join this channel', 'has been removed',
    'account associated with this video has been terminated', 'copyright'].some(k => all.includes(k))
}

/** yt-dlp 没解开 YouTube 的 JS 挑战（n / 签名）→ 缺格式。不是 IP 问题 */
function jsProblem(stderr) {
  const s = problemLines(stderr).toLowerCase()
  return ['n challenge solving failed', 'signature solving failed', 'no supported javascript runtime', 'error running quickjs',
    'error running deno', 'js challenge', 'jsc', 'nsig extraction failed', 'signature extraction failed'].some(k => s.includes(k))
}

/** 网络失败（连接、DNS、TLS），不是 YouTube 拒绝 */
function netProblem(stderr) {
  const s = errorsOnly(stderr).toLowerCase()
  return ['timed out', 'connection refused', 'connection reset', 'network is unreachable', 'name or service not known',
    'temporary failure in name resolution', 'failed to resolve', 'errno 7', 'errno -2', 'errno -3', 'eof occurred', 'ssl:',
    'unable to connect', 'connectionerror', 'remote end closed', 'getaddrinfo failed', 'errno 11001', 'winerror 10060', 'winerror 10061']
    .some(k => s.includes(k)) && !s.includes('not a bot')
}

const YtAuth = { NONE: 'NONE', OK: 'OK', ROTATED: 'ROTATED' }
/** yt-dlp 自己对 cookies 的判断（需要 -v） */
function ytAuth(stderr) {
  const s = String(stderr || '')
  if (s.includes('account cookies are no longer valid')) return YtAuth.ROTATED
  if (s.includes('Found YouTube account cookies')) return YtAuth.OK
  return YtAuth.NONE
}

/** 一次失败的 YouTube 尝试的中文原因 */
function ytReason(stderr) {
  const s = errorsOnly(stderr).toLowerCase()
  if (s.includes('sign in to confirm') || s.includes('not a bot')) return '要求验证不是机器人'
  if (jsProblem(stderr) && (s.includes('format') || s.includes('only images'))) return 'YouTube 签名 / n 参数解算失败（JS 引擎），拿不到视频流'
  if (s.includes('http error 429') || s.includes('too many requests')) return '请求过多被限流（429）'
  if (s.includes('http error 403') || s.includes('failed to extract any player response')) return 'IP 被拒绝，拿不到播放信息（403）'
  if (s.includes('requested format is not available') || s.includes('only images')) return '没有拿到可下载的视频流'
  if (netProblem(stderr)) return '网络连接失败'
  return errorLine(stderr).slice(0, 60) || '未知原因'
}

/**
 * 所有 YouTube 尝试都失败后的提示。auth = yt-dlp 报告的登录状态；deno: true = 用了 Deno，false = 没装好，null = 不适用
 */
function youtubeSummary(steps, auth, js = false, deno = null) {
  let sb = 'YouTube 解析失败，已自动尝试：\n'
  steps.forEach((st, i) => { sb += `${i + 1}. ${st.name}：${st.result}\n` })
  sb += auth === YtAuth.OK ? '（已带上 YouTube 登录状态）\n' : auth === YtAuth.ROTATED ? '（YouTube 登录状态已失效：cookies 被浏览器轮换或已过期）\n' : '（未登录 YouTube）\n'
  if (js) sb += '解析引擎没能解开 YouTube 的签名校验：请点「菜单 → 更新解析引擎」后重试。\n'
  else sb += 'YouTube 拒绝了当前网络的请求。建议：\n• 换一个 VPN 节点后重试\n'
  sb += auth === YtAuth.OK ? '• 也可以在「登录 → YouTube」重新登录'
    : auth === YtAuth.ROTATED ? '• 在「登录 → YouTube」重新登录，或用无痕窗口重新导出 cookies.txt（导出后关闭该窗口）'
      : '• 或在「登录 → YouTube」登录账号 / 导入 cookies.txt'
  if (deno === false) sb += '\n• Deno 引擎没有装好：点「菜单 → 更新解析引擎」重新下载后重试'
  sb += '\n• 「菜单 → 复制诊断日志」可以复制完整日志'
  return sb
}

/** 复制诊断日志前去掉 cookie 值、令牌、visitor / sync id 和长串 */
function redact(log) {
  let s = String(log || '')
  s = s.replace(/(visitor_data|data_sync_id|po_token|token|pot|sig|lsig|n|SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)=([^;&\s'",\]]+)/g,
    (m, k, v) => (v.length < 12 ? m : `${k}=<已隐藏>`))
  s = s.replace(/(Authorization|Cookie|X-Goog-Visitor-Id)(['"]?\s*[:=]\s*['"]?)[^'"\n]+/gi, (m, k, sep) => k + sep + '<已隐藏>')
  s = s.replace(/[A-Za-z0-9_\-%+/=.]{60,}/g, m => (m.startsWith('http') || m.includes('/data/') || m.includes('\\') ? m : `<已隐藏 ${m.length} 字符>`))
  return s
}

// ------------------------------------------------------------------ errors

/** yt-dlp stderr 的最后一行 ERROR（去掉 "[extractor] id:" 前缀） */
function errorLine(stderr) {
  const ls = lines(stderr)
  let line = [...ls].reverse().find(l => l.startsWith('ERROR:'))
  if (line == null) { const t = String(stderr || '').trim().split(/\r?\n/); line = t[t.length - 1] || '' }
  return line.replace(/^ERROR:/, '').trim().replace(/^\[[^\]]+\]\s*[^:]{1,60}:\s*/, '')
    .split('; please report this issue')[0].split(' See  https://')[0].trim()
}

/** yt-dlp 错误输出 → 中文提示 */
function errorMessage(stderr, platform) {
  const line = errorLine(stderr)
  const errs = String(stderr || '').split(/\r?\n/).filter(l => l.includes('ERROR')).join('\n')
  const s = (line + '\n' + errs.slice(-1500)).toLowerCase()
  const name = platform.name === 'OTHER' ? '该网站' : platform.label
  const has = (...k) => k.some(x => s.includes(x))
  const loginHint = platform.loginUrl ? `请点右上角「登录」登录${name} 后重试` : '该平台暂不支持在拾影里登录'
  if (has('private video', 'this video is private', 'is private', 'private account', 'account is private', 'protected tweet', '私密')) return `这是私密内容，无法下载（${name}）`
  if (has('age-restricted', 'age restricted', 'confirm your age', 'inappropriate for some users')) return `内容有年龄限制，需要登录才能下载。${loginHint}`
  if (has('members-only', 'members only', 'join this channel', 'premium', 'requires payment', 'purchase', 'paid content', 'rental',
    '大会员', '付费', 'vip', 'only available to subscribers', 'subscriber-only', 'ppv')) return '付费 / 会员专享内容，不支持下载'
  if (has('tls fingerprint', 'impersonat')) return `${name} 拦截了解析引擎的连接（TLS 指纹校验）。可以先点「菜单 → 更新解析引擎」，或登录${name} 后再试；仍不行说明暂不支持`
  if (has('ip address is blocked', 'your ip address', 'ip is blocked')) return `${name} 封锁了当前网络的 IP（常见于 VPN / 机房节点），请换一个网络或节点后重试`
  if (has('available in your country', 'not available in your region', 'geo restrict', 'geo-restrict', 'georestrict', 'region',
    'blocked in your country', 'in your location', '地区')) return '地区限制：该内容在当前网络所在地区不可用（可尝试更换网络 / VPN 节点）'
  if (has('http error 429', 'too many requests', 'rate-limit', 'rate limit', 'ratelimit', 'http error 412', 'precondition failed', '风控', '频繁'))
    return `请求太频繁，被 ${name} 限流 / 风控了，请稍后再试（登录后通常更稳定）`
  if (has('sign in to confirm you', 'not a bot')) return `${name} 要求验证「不是机器人」（当前网络 IP 被限制）。请换个网络 / 节点，或登录后再试`
  if (has('login required', 'log in', 'login to', 'sign in', 'logged-in', 'logged in', '--cookies', 'cookies', 'authentication', 'requires login', 'need to log', '需要登录', '登录'))
    return `需要登录才能下载。${loginHint}`
  if (has('unsupported url')) return '暂不支持这个链接（请使用单个作品 / 视频页面的分享链接）'
  if (has('video unavailable', 'has been removed', 'been deleted', 'does not exist', "doesn't exist", 'no longer available', 'not found', 'http error 404',
    '啥都木有', '不存在', '已删除', "this content isn't available", 'content is not available', 'post is unavailable', 'status is unavailable')) return '内容不存在或已被删除'
  if (has('no video could be found', 'no video formats', 'no formats', 'requested format is not available', "there's no video", 'no media', 'has no video'))
    return '这条内容里没有可下载的视频（可能是纯图片、直播或需要登录）'
  if (has('live event', 'is live', 'premieres in', 'this live')) return '直播 / 首映内容不支持下载'
  if (has('timed out', 'timeout', 'connection reset', 'connection refused', 'network is unreachable', 'name or service not known', 'temporary failure in name resolution',
    'nodename nor servname', 'failed to resolve', 'errno 7', 'errno -2', 'errno -3', 'eof occurred', 'ssl', 'getaddrinfo failed', 'errno 11001', 'winerror 10060'))
    return `网络错误，无法连接 ${name}（在国内访问海外平台需要开启 VPN）`
  if (has('failed to extract', 'unable to extract', 'please report this issue', 'keyerror', 'typeerror', 'jsonerror', 'unable to download api page', 'http error 403', 'forbidden'))
    return `解析失败：${name} 可能改版了或拒绝了请求。请点「菜单 → 更新解析引擎」后重试${platform.loginUrl ? '，或登录后再试' : ''}`
  if (line.trim()) return '解析失败：' + line.slice(0, 140)
  return '解析失败（解析引擎没有返回原因）'
}

// ------------------------------------------------------------------ cookies.txt / Deno

const CookieText = {
  /** yt-dlp 认为有 YouTube 登录：LOGIN_INFO + 任一 SAPISID */
  youtubeAuth: names => { const n = new Set(names); return n.has('LOGIN_INFO') && ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'].some(k => n.has(k)) },
  /** Netscape 文件里 youtube.com 的 cookie 名（含 #HttpOnly_ 行） */
  youtubeNames: text => new Set(String(text || '').split('\n').map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
    .map(l => l.split('\t')).filter(p => p.length >= 7)
    .filter(p => { const d = p[0].replace(/^#HttpOnly_/, '').replace(/^\.+/, ''); return d === 'youtube.com' || d.endsWith('.youtube.com') })
    .map(p => p[5])),
  /** 一行 Netscape cookie */
  line: (domain, name, value, expires, { includeSub = true, path = '/', secure = true, httpOnly = false } = {}) =>
    `${httpOnly ? '#HttpOnly_' : ''}${includeSub ? '.' + domain.replace(/^\.+/, '') : domain.replace(/^\.+/, '')}\t${includeSub ? 'TRUE' : 'FALSE'}\t${path}\t${secure ? 'TRUE' : 'FALSE'}\t${expires}\t${name}\t${value}`,
  pairs: raw => String(raw || '').split(';').map(p => { const kv = p.trim(); const eq = kv.indexOf('='); return eq <= 0 ? null : [kv.slice(0, eq), kv.slice(eq + 1)] }).filter(Boolean),
}

/** yt-dlp 的 JS 运行时参数 */
const jsRuntimeArgs = denoExe => (denoExe ? ['--js-runtimes', `deno:${denoExe}`] : [])

module.exports = {
  sortArg, formatArg, infoOptions, youtubeInfoOptions, downloadOptions, normalizeUrl, needsExpand, parseInfo,
  YT_ALT_CLIENTS, youtubeId, problemLines, ytBlocked, jsProblem, netProblem, YtAuth, ytAuth, ytReason, youtubeSummary, redact,
  errorLine, errorMessage, CookieText, jsRuntimeArgs,
}
