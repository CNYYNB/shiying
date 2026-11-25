'use strict'
/** 封面图 CDN 需要的 Referer（移植自 Thumbs.refererFor）。纯函数。 */
const Links = require('./links')
const { Platform } = require('./platform')

function refererFor(url, platform, postReferer) {
  const h = Links.host(url)
  if (h.endsWith('sinaimg.cn') || h.endsWith('weibocdn.com')) return 'https://weibo.com/'
  if (h.endsWith('hdslb.com') || h.endsWith('biliimg.com')) return 'https://www.bilibili.com/'
  if (h.includes('douyinpic') || h.endsWith('douyin.com') || h.endsWith('byteimg.com')) return 'https://www.douyin.com/'
  if (h.endsWith('xhscdn.com') || h.endsWith('xiaohongshu.com')) return 'https://www.xiaohongshu.com/'
  if (h.endsWith('yximgs.com') || h.endsWith('kwimgs.com') || h.endsWith('kuaishou.com')) return 'https://www.kuaishou.com/'
  if (postReferer) return postReferer
  const name = typeof platform === 'string' ? platform : platform?.name
  if (name === Platform.WEIBO.name) return 'https://weibo.com/'
  if (name === Platform.BILIBILI.name) return 'https://www.bilibili.com/'
  return null
}

module.exports = { refererFor }
