'use strict'
/** 从任意粘贴文字里找出受支持的链接 / 抖音作品 ID（移植自 Links.kt）。纯函数，可单测。 */
const P = require('./platform')

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
/** 不带 http 的链接（如 "b23.tv/xxxx"、"xhslink.cn/o/xxx"）：只认已知平台域名 */
const BARE_RE = /(?<![A-Za-z0-9@./])((?:[A-Za-z0-9-]+\.)+(?:com|cn|tv|be|am|co|net|watch)\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g
const ID_RES = [
  /\/(?:video|note|slides|gallery|share\/video|share\/note|share\/slides|shipin|lvdetail|vsdetail)\/(\d{8,21})/,
  /[?&#](?:modal_id|aweme_id|item_id|vid|group_id)=(\d{8,21})/,
  /item_ids=%5B(\d{8,21})/,
  /item_ids=(\d{8,21})/,
]
const DOUYIN_HOST = /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com|snssdk\.com|amemv\.com)$/i

/** 去掉分享文字里常粘在链接后面的标点 */
function trimTail(u) {
  let s = u
  while (s.length && ".,;:!?)]'*".includes(s[s.length - 1])) s = s.slice(0, -1)
  return s
}

/** 文字里所有链接（已知平台的无 scheme 链接会补上 https://） */
function allUrls(text) {
  const t = String(text || '')
  const withScheme = [...t.matchAll(URL_RE)].map(m => trimTail(m[0]))
  if (withScheme.length) return withScheme
  return [...t.matchAll(BARE_RE)].map(m => 'https://' + trimTail(m[1])).filter(u => P.ofUrl(u) !== P.Platform.OTHER)
}

const host = P.hostOf
const isDouyin = url => DOUYIN_HOST.test(host(url))

/** 文字中第一个已知平台的链接（都不是就取第一个链接） */
function findUrl(text) {
  const all = allUrls(text)
  return all.find(isDouyin) || all.find(u => P.ofUrl(u) !== P.Platform.OTHER) || all[0] || null
}

/** 纯数字作品 ID（15–21 位） */
function bareId(text) {
  const m = /^\s*(\d{15,21})\s*$/.exec(String(text || ''))
  return m ? m[1] : null
}

/** 粘贴的文字指向哪个平台（null = 没有链接）。单独的 19 位数字算抖音。 */
function detect(text) {
  if (bareId(text)) return P.Platform.DOUYIN
  const u = findUrl(text)
  return u ? P.ofUrl(u) : null
}

function looksLikeDouyin(text) {
  if (!text || !String(text).trim()) return false
  return [...String(text).matchAll(URL_RE)].some(m => isDouyin(trimTail(m[0])))
}

/** 文字里有受支持平台的链接（用于剪贴板自动识别） */
function looksSupported(text) {
  if (!text || !String(text).trim()) return false
  return allUrls(text).some(u => P.ofUrl(u) !== P.Platform.OTHER)
}

function idFromUrl(url) {
  for (const re of ID_RES) { const m = re.exec(url); if (m) return m[1] }
  return null
}

const needsResolve = url => idFromUrl(url) == null

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** "作者-标题-ID"，可用作 Windows 文件名（去掉路径字符，保留 emoji，≤ 120 字符） */
function fileBase(author, title, id, fallbackAuthor = '抖音') {
  const clean = (s, max) => {
    let t = String(s || '').replace(/#\S+/g, ' ').replace(/@\S+/g, ' ')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^[. -]+|[. -]+$/g, '')
    if (t.length > max) t = t.substring(0, max).trim()
    return t
  }
  let a = clean(author, 24) || fallbackAuthor
  if (WIN_RESERVED.test(a)) a = '_' + a
  const t = clean(title, 50) || clean(String(title || '').replace(/#/g, ' '), 50) || '作品'
  const i = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return i ? `${a}-${t}-${i}` : `${a}-${t}`
}

module.exports = { allUrls, findUrl, detect, bareId, looksLikeDouyin, looksSupported, idFromUrl, needsResolve, host, isDouyin, fileBase, trimTail }
