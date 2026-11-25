'use strict'
// 移植自 LinksTest.kt + PlatformTest.kt（同样的输入和断言）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Links = require('../src/core/links')
const P = require('../src/core/platform')
const Y = require('../src/core/ytdlp-support')
const { Platform } = P

test('Links.shareText', () => {
  const t = '7.43 复制打开抖音，看看【小轨的作品】过年啦！# 嘉桐摇 # 卡点舞 https://v.douyin.com/f-QpBB_oD9Y/ x@F.ub 01/20 vSl:/ '
  assert.equal(Links.findUrl(t), 'https://v.douyin.com/f-QpBB_oD9Y/')
  assert.ok(Links.looksLikeDouyin(t))
  assert.equal(Links.idFromUrl(Links.findUrl(t)), null)
})

test('Links.ids', () => {
  assert.equal(Links.idFromUrl('https://www.douyin.com/video/7578030072632839465'), '7578030072632839465')
  assert.equal(Links.idFromUrl('https://www.douyin.com/note/7643104807914401929?previous_page=app_code_link'), '7643104807914401929')
  assert.equal(Links.idFromUrl('https://www.iesdouyin.com/share/video/7578030072632839465/?region=CN&mid=1'), '7578030072632839465')
  assert.equal(Links.idFromUrl('https://www.douyin.com/user/MS4wLjAB?modal_id=7578030072632839465'), '7578030072632839465')
  assert.equal(Links.idFromUrl('https://www.douyin.com/discover?modal_id=7578030072632839465'), '7578030072632839465')
  assert.equal(Links.idFromUrl('https://m.douyin.com/share/video/7578030072632839465'), '7578030072632839465')
  assert.equal(Links.bareId(' 7578030072632839465 '), '7578030072632839465')
  assert.equal(Links.findUrl('没有链接'), null)
  assert.equal(Links.looksLikeDouyin('https://www.bilibili.com/video/BV1'), false)
  assert.ok(Links.isDouyin('https://www.iesdouyin.com/share/note/1/'))
})

test('Links.trailingPunct', () => {
  assert.equal(Links.findUrl('看看 https://v.douyin.com/abc/，复制此链接'), 'https://v.douyin.com/abc/')
  assert.equal(Links.findUrl('(https://v.douyin.com/abc).'), 'https://v.douyin.com/abc')
})

test('Links.fileName', () => {
  assert.equal(Links.fileBase('睦月', '黛玉良技能推测\n#边狱公司', '7578030072632839465'), '睦月-黛玉良技能推测-7578030072632839465')
  assert.equal(Links.fileBase('a/b', 'x:y?', '1'), 'a b-x y-1')
  assert.equal(Links.fileBase('', '#边狱公司', '1'), '抖音-边狱公司-1')
  assert.ok(Links.fileBase('作者', '很长'.repeat(100), '1').length < 100)
  // 电脑版额外：Windows 保留名
  assert.equal(Links.fileBase('CON', 't', '1'), '_CON-t-1')
})

const d = t => Links.detect(t)

test('Platform.detectShareTexts', () => {
  assert.equal(d('7.43 复制打开抖音，看看【小轨的作品】https://v.douyin.com/f-QpBB_oD9Y/ x@F.ub'), Platform.DOUYIN)
  assert.equal(d('7641191614632071546'), Platform.DOUYIN)
  assert.equal(d('https://v.kuaishou.com/fXqlD6 “谁说站在光里的才算英雄” 复制此消息，打开【快手】直接观看！'), Platform.KUAISHOU)
  assert.equal(d('https://www.kuaishou.com/short-video/3xqensd76nig6nw?authorId=3x'), Platform.KUAISHOU)
  assert.equal(d('90 麦香发布了一篇小红书笔记，快来看吧！ 😆 ZMvkU4FkbGqvkLq 😆 http://xhslink.com/a/7o7zKxL5B7GZ，复制本条信息，打开【小红书】App查看精彩内容！'), Platform.XIAOHONGSHU)
  assert.equal(d('xhslink.cn/o/AxnRePgIokn'), Platform.XIAOHONGSHU)
  assert.equal(d('【【官方MV】Never Gonna Give You Up - Rick Astley】 https://b23.tv/BV1GJ411x7h7'), Platform.BILIBILI)
  assert.equal(d('https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web'), Platform.BILIBILI)
  assert.equal(d('https://weibo.com/7827771738/N4xlMvjhI'), Platform.WEIBO)
  assert.equal(d('https://m.weibo.cn/status/4189191225395228'), Platform.WEIBO)
  assert.equal(d('https://www.ixigua.com/6996881461559165471'), Platform.XIGUA)
  assert.equal(d('https://www.toutiao.com/video/7505382061495176511/'), Platform.TOUTIAO)
  assert.equal(d('https://youtu.be/jNQXAC9IVRw?si=abc'), Platform.YOUTUBE)
  assert.equal(d('https://youtube.com/shorts/7Fc9Ry0V1OI?feature=share'), Platform.YOUTUBE)
  assert.equal(d('https://vt.tiktok.com/ZSabc123/'), Platform.TIKTOK)
  assert.equal(d('https://www.instagram.com/reel/Chunk8-jurw/?igsh=MWQ1'), Platform.INSTAGRAM)
  assert.equal(d('https://x.com/SpaceX/status/1732824684683784516?s=20'), Platform.X)
  assert.equal(d('https://twitter.com/SpaceX/status/1732824684683784516'), Platform.X)
  assert.equal(d('https://www.facebook.com/share/r/1Abc/'), Platform.FACEBOOK)
  assert.equal(d('https://fb.watch/abcd/'), Platform.FACEBOOK)
  assert.equal(d('https://vimeo.com/76979871'), Platform.VIMEO)
  assert.equal(d('https://www.dailymotion.com/video/x8abc'), Platform.OTHER)
  assert.equal(d('没有链接的文字'), null)
})

test('Platform.hostMatchingIsSuffixSafe', () => {
  assert.equal(P.ofHost('notyoutube.com'), Platform.OTHER)
  assert.equal(P.ofHost('myx.com'), Platform.OTHER)
  assert.equal(P.ofHost('mobile.x.com'), Platform.X)
  assert.equal(P.ofHost('m.bilibili.com'), Platform.BILIBILI)
})

test('Platform.prefersKnownPlatformUrl', () => {
  assert.equal(Links.findUrl('见 https://example.com/x 和 https://b23.tv/abcdefg'), 'https://b23.tv/abcdefg')
  assert.ok(Links.looksSupported('https://www.instagram.com/p/BQ0eAlwhDrw/'))
  assert.equal(Links.looksSupported('https://example.com/a'), false)
})

test('Platform.normalizeAndExpand', () => {
  assert.equal(Y.normalizeUrl('https://www.ixigua.com/6996881461559165471?logTag=1'), 'https://www.toutiao.com/video/6996881461559165471/')
  assert.equal(Y.normalizeUrl('https://youtube.com/shorts/7Fc9Ry0V1OI?feature=share'), 'https://www.youtube.com/watch?v=7Fc9Ry0V1OI')
  assert.equal(Y.normalizeUrl('https://www.toutiao.com/video/7505382061495176511/'), 'https://www.toutiao.com/video/7505382061495176511/')
  assert.ok(Y.needsExpand('https://b23.tv/BV1GJ411x7h7'))
  assert.ok(Y.needsExpand('https://t.cn/A6abc'))
  assert.equal(Y.needsExpand('https://www.bilibili.com/video/BV1GJ411x7h7'), false)
})

test('Platform.fileBaseForOtherPlatforms', () => {
  assert.equal(Links.fileBase('', '', 'BV1GJ411x7h7', '哔哩哔哩'), '哔哩哔哩-作品-BV1GJ411x7h7')
  assert.equal(Links.fileBase('a', 'b', 'BV1:2/x'), 'a-b-BV12x')
  assert.equal(Links.fileBase('a', 'b', '::'), 'a-b')
})
