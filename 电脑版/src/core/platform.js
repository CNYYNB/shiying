'use strict'
/**
 * 支持的平台（移植自安卓版 Platform.kt）。hosts 按后缀匹配链接的域名。
 * engine: "douyin" / "kuaishou" / "xhs" = 原生解析，"ytdlp" = yt-dlp。
 * loginUrl: 可选的网页登录（cookies 导出给 yt-dlp / 原生解析）。
 */
const def = (name, label, hosts, engine, loginUrl = null, sessionCookies = [], cookieDomains = [], desktopLogin = true) =>
  ({ name, label, hosts, engine, loginUrl, sessionCookies, cookieDomains, desktopLogin, native: engine !== 'ytdlp' })

const LIST = [
  def('DOUYIN', '抖音', ['douyin.com', 'iesdouyin.com', 'douyinvod.com', 'snssdk.com', 'amemv.com'], 'douyin',
    'https://www.douyin.com/', ['sessionid', 'sessionid_ss', 'sid_tt'], ['douyin.com']),
  def('KUAISHOU', '快手', ['kuaishou.com', 'chenzhongtech.com', 'gifshow.com', 'kuaishouapp.com', 'kwai.com', 'kwai.net'], 'kuaishou',
    'https://www.kuaishou.com/', ['kuaishou.server.web_st', 'userId'], ['kuaishou.com']),
  def('XIAOHONGSHU', '小红书', ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'xhscdn.com', 'rednote.com'], 'xhs',
    'https://www.xiaohongshu.com/explore', ['web_session'], ['xiaohongshu.com']),
  def('BILIBILI', '哔哩哔哩', ['bilibili.com', 'b23.tv', 'bili2233.cn', 'bili22.cn', 'bili33.cn', 'bilibili.tv'], 'ytdlp',
    'https://passport.bilibili.com/login', ['SESSDATA'], ['bilibili.com']),
  def('WEIBO', '微博', ['weibo.com', 'weibo.cn', 't.cn'], 'ytdlp',
    'https://passport.weibo.com/sso/signin', ['SUB'], ['weibo.com', 'weibo.cn']),
  def('XIGUA', '西瓜视频', ['ixigua.com'], 'ytdlp', null, [], ['ixigua.com']),
  def('TOUTIAO', '今日头条', ['toutiao.com', 'toutiaocdn.com', 'snssdk.cn'], 'ytdlp', null, [], ['toutiao.com']),
  def('YOUTUBE', 'YouTube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], 'ytdlp',
    'https://accounts.google.com/ServiceLogin?service=youtube&hl=zh-CN&passive=true&continue=https%3A%2F%2Fwww.youtube.com%2F',
    ['SAPISID', '__Secure-3PSID', 'LOGIN_INFO'], ['youtube.com', 'google.com']),
  def('TIKTOK', 'TikTok', ['tiktok.com'], 'ytdlp', 'https://www.tiktok.com/login', ['sessionid'], ['tiktok.com']),
  def('INSTAGRAM', 'Instagram', ['instagram.com', 'instagr.am'], 'ytdlp',
    'https://www.instagram.com/accounts/login/', ['sessionid'], ['instagram.com']),
  def('X', 'X / Twitter', ['x.com', 'twitter.com', 't.co', 'fxtwitter.com', 'vxtwitter.com'], 'ytdlp',
    'https://x.com/i/flow/login', ['auth_token'], ['x.com', 'twitter.com']),
  def('FACEBOOK', 'Facebook', ['facebook.com', 'fb.watch', 'fb.com'], 'ytdlp',
    'https://www.facebook.com/login/', ['c_user'], ['facebook.com']),
  def('VIMEO', 'Vimeo', ['vimeo.com'], 'ytdlp', 'https://vimeo.com/log_in', ['vimeo'], ['vimeo.com']),
  /** 其他网站：原样交给 yt-dlp（支持约 1800 个网站） */
  def('OTHER', '其他网站', [], 'ytdlp'),
]

const Platform = {}
for (const p of LIST) Platform[p.name] = p
Object.defineProperty(Platform, 'entries', { value: LIST, enumerable: false })

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url || '')
  return m ? m[1].toLowerCase() : ''
}

function matchesHost(p, host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '')
  return p.hosts.some(it => h === it || h.endsWith('.' + it))
}

function ofHost(host) { return LIST.find(p => p !== Platform.OTHER && matchesHost(p, host)) || Platform.OTHER }
function ofUrl(url) { return ofHost(hostOf(url)) }
function byName(name) { return LIST.find(p => p.name === name) || null }
/** 可以在拾影里登录的平台（「登录」菜单） */
function loginable() { return LIST.filter(p => p.loginUrl) }

module.exports = { Platform, LIST, hostOf, matchesHost, ofHost, ofUrl, byName, loginable }
