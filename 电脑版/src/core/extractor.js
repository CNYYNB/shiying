'use strict'
/**
 * 路由（移植自 Extractor.route）：抖音 / 快手 / 小红书 用原生解析，其他交给 yt-dlp（先展开 yt-dlp 自己跟不了的短链接）。
 * 抖音分享页拿不到时抛 NeedFallback，由主进程用隐藏浏览器窗口（网页模式）再试。
 */
const Links = require('./links')
const Net = require('./net')
const P = require('./platform')
const Douyin = require('./douyin')
const Kuaishou = require('./kuaishou')
const Xhs = require('./xhs')
const Y = require('./ytdlp-support')
const TgS = require('./telegram-support')
const { UserError } = require('./post')

const TG_NEED_LOGIN = '这是私密频道 / 群组（或评论区）的消息链接，需要先登录 Telegram：点右上角「登录」→「Telegram 账号登录」'

/**
 * → { type:'native', post } | { type:'ytdlp', url, platform }
 * opts.telegram：{ loggedIn(): boolean|Promise, resolve(link, log): Promise<post> }（主进程提供；没有时 Telegram 只能走 yt-dlp）
 */
async function route(text, log = () => {}, opts = {}) {
  const platform = Links.detect(text)
  if (!platform) throw new UserError('没有找到链接。请在 App 里点「分享 → 复制链接」，再粘贴到这里')
  switch (platform.name) {
    case 'DOUYIN': return { type: 'native', post: await Douyin.fromSharePage(await Douyin.resolve(text, log), log) }
    case 'KUAISHOU': return { type: 'native', post: await Kuaishou.parse(text, log) }
    case 'XIAOHONGSHU':
      try { return { type: 'native', post: await Xhs.parse(text, log) } } catch (e) {
        if (e instanceof Xhs.XhsNoData) { log('页面没有笔记数据，改用解析引擎…'); return { type: 'ytdlp', url: e.url, platform } }
        throw e
      }
    case 'TELEGRAM': {
      let link
      try { link = TgS.parseLink(Links.findUrl(text)) } catch (e) { throw new UserError(e.message) }
      const tg = opts.telegram
      if (tg && await tg.loggedIn()) return { type: 'native', post: await tg.resolve(link, log) }
      if (!link.publicFallback) throw new UserError(TG_NEED_LOGIN)
      log('没有登录 Telegram，用解析引擎试公开频道…')
      return { type: 'ytdlp', url: telegramFallbackUrl(link), platform, telegramFallback: true }
    }
    default: {
      let url = Links.findUrl(text)
      if (Y.needsExpand(url)) {
        log('正在解析短链接…')
        url = await Net.follow(url, Net.UA_DESKTOP, u => P.ofUrl(u) !== P.Platform.OTHER && !Y.needsExpand(u))
      }
      if (/b23\.tv\/.+/.test(url) || url.includes('bilibili.com/404')) throw new UserError('B站短链接已失效（b23.tv 短链一般一年后过期），请重新复制分享链接')
      const p = P.ofUrl(url)
      return { type: 'ytdlp', url: Y.normalizeUrl(url), platform: p === P.Platform.OTHER ? platform : p }
    }
  }
}

/** 不登录时交给 yt-dlp 的公开频道链接（yt-dlp 只认 t.me/频道/消息号） */
function telegramFallbackUrl(link) {
  return `https://t.me/${link.username}/${link.msgId}${link.single ? '?single' : ''}`
}

module.exports = { route, telegramFallbackUrl, TG_NEED_LOGIN }
