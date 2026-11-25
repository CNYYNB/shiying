'use strict'
/** 作品（Post，移植自 Parser.kt 的 data class）与通用错误类型。Post 是普通对象，可以经 IPC 传给界面。 */
const { Platform } = require('./platform')

class UserError extends Error { constructor(msg) { super(msg); this.name = 'UserError' } }
/** 平台明确说作品看不了（删除 / 私密 / 仅好友…）。final = 换别的方式也没用 */
class PostUnavailable extends Error {
  constructor(reason, msg, final) { super(msg); this.name = 'PostUnavailable'; this.reason = reason; this.final = final }
}
/** 分享页没拿到作品，可以试网页模式（隐藏浏览器窗口） */
class NeedFallback extends Error {
  constructor(id, likelyImages, why, filtered) { super(why); this.name = 'NeedFallback'; this.id = id; this.likelyImages = likelyImages; this.filtered = filtered || null }
}
class Cancelled extends Error { constructor() { super('已取消'); this.name = 'Cancelled' } }

/**
 * 创建作品对象。字段同安卓版 Post：
 * id, isImages, desc, author, cover, durationMs, videoUrls(原始文件候选，好的在前), images[{urls, liveVideoUrls}],
 * source, platform(名字), pageUrl, engine("native"|"ytdlp"), infoJson, headers, entries, height, heights{url:h},
 * qualityOverride, ytdlpArgs。另外算好 title / liveCount / link。
 */
function makePost(f) {
  const p = {
    id: '', isImages: false, desc: '', author: '', cover: null, durationMs: 0, videoUrls: [], images: [], source: '',
    platform: Platform.DOUYIN.name, pageUrl: '', engine: 'native', infoJson: null, headers: {}, entries: 1, height: 0,
    heights: {}, qualityOverride: null, ytdlpArgs: [], ...f,
  }
  if (typeof p.platform === 'object' && p.platform) p.platform = p.platform.name
  const first = String(p.desc || '').split('\n').find(l => l.trim())
  p.title = first ? first.trim() : '（无标题）'
  p.liveCount = p.images.filter(i => i.liveVideoUrls && i.liveVideoUrls.length).length
  p.link = p.pageUrl || `https://www.douyin.com/${p.isImages ? 'note' : 'video'}/${p.id}`
  return p
}

module.exports = { makePost, UserError, PostUnavailable, NeedFallback, Cancelled }
