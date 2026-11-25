'use strict'
// 移植自 ParserTest.kt（抖音）+ KuaishouXhsTest.kt（快手 / 小红书），使用同一批 fixtures
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Douyin = require('../src/core/douyin')
const Kuaishou = require('../src/core/kuaishou')
const Xhs = require('../src/core/xhs')
const { Platform } = require('../src/core/platform')

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')

// ---------------------------------------------------------------- 抖音

test('Douyin.video', () => {
  const s = Douyin.parseSharePage(fx('video.html'))
  assert.equal(s.type, 'item')
  const p = Douyin.fromItem(s.item, '分享页')
  assert.equal(p.isImages, false)
  assert.equal(p.id, '7578030072632839465')
  assert.equal(p.author, '睦月')
  assert.ok(p.durationMs > 90_000)
  assert.ok(p.cover)
  assert.ok(p.videoUrls.length > 0)
  const first = p.videoUrls[0]
  assert.ok(first.includes('/aweme/v1/play/') && !first.includes('playwm') && first.includes('ratio=1080p'), first)
  assert.ok(p.videoUrls.some(u => u.includes('ratio=720p')))
  assert.ok(p.videoUrls.every(u => !u.includes('playwm')))
  assert.equal(Douyin.formatDuration(p.durationMs), '1:39')
})

test('Douyin.note', () => {
  const s = Douyin.parseSharePage(fx('note.html'))
  const p = Douyin.fromItem(s.item, '分享页')
  assert.ok(p.isImages)
  assert.equal(p.images.length, 3)
  assert.equal(p.videoUrls.length, 0)
  for (const im of p.images) {
    assert.ok(im.urls[0].includes('.jpeg'), im.urls[0])          // jpeg 优先
    assert.ok(im.urls.every(u => !u.includes('water')))          // 永远不用带水印的 download_url_list
  }
})

test('Douyin.filtered', () => {
  const a = Douyin.parseSharePage(fx('selfsee.html'))
  assert.equal(a.type, 'filtered'); assert.equal(a.reason, 'status_self_see')
  assert.ok(Douyin.unavailable(a.reason).final)
  const b = Douyin.parseSharePage(fx('secret.html'))
  const ub = Douyin.unavailable(b.reason, b.notice, b.detail)
  assert.ok(ub.final); assert.ok(ub.message.includes('私密'))
  const c = Douyin.parseSharePage(fx('notexist.html'))
  assert.ok(Douyin.unavailable(c.reason).message.includes('删除'))
  assert.equal(Douyin.unavailable('some_new_reason', '要登录').final, false)
})

test('Douyin.shellPageHasNoData', () => {
  assert.equal(Douyin.parseSharePage(fx('shell.html')).type, 'nodata')
  assert.equal(Douyin.parseSharePage('<html></html>').type, 'nodata')
})

test('Douyin.playUrl', () => {
  assert.equal(Douyin.playUrl('https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x&ratio=720p&line=0', '1080p'),
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=x&ratio=1080p&line=0')
  assert.equal(Douyin.playUrl('https://a/aweme/v1/playwm/?video_id=x', '1080p'), 'https://a/aweme/v1/play/?video_id=x&ratio=1080p')
})

test('Douyin.webDetail', () => {
  const j = `{"status_code":0,"aweme_detail":{"aweme_id":"123","desc":"标题 #话题","author":{"nickname":"作者"},
    "video":{"duration":15000,"cover":{"url_list":["https://p3/c.jpeg"]},
      "play_addr":{"uri":"v0200","url_list":["https://v3-web.douyinvod.com/low.mp4"]},
      "bit_rate":[
        {"gear_name":"normal_540_0","bit_rate":800000,"is_h265":0,"play_addr":{"height":1024,"width":576,"url_list":["https://v26-web.douyinvod.com/540.mp4"]}},
        {"gear_name":"normal_1080_0","bit_rate":2500000,"is_h265":0,"play_addr":{"height":1920,"width":1080,"url_list":["https://v26-web.douyinvod.com/1080.mp4","https://v3-web.douyinvod.com/1080b.mp4"]}},
        {"gear_name":"1080_h265","bit_rate":1800000,"is_h265":1,"play_addr":{"height":1920,"width":1080,"url_list":["https://v26-web.douyinvod.com/1080h265.mp4"]}}
      ]}}}`
  const p = Douyin.fromWebDetail(j, '123')
  assert.equal(p.videoUrls[0], 'https://v26-web.douyinvod.com/1080.mp4')
  assert.equal(p.videoUrls[2], 'https://v26-web.douyinvod.com/1080h265.mp4')
  assert.ok(p.videoUrls.indexOf('https://v26-web.douyinvod.com/540.mp4') > 2)
  assert.equal(p.source, '网页')
  assert.equal(Douyin.fromWebDetail(j, '999'), null)
  const live = `{"aweme_detail":{"aweme_id":"5","desc":"d","author":{"nickname":"a"},"images":[
    {"url_list":["https://p/1.webp","https://p/1.jpeg"],"download_url_list":["https://p/1~tplv-dy-water.jpeg"],
     "video":{"play_addr":{"url_list":["https://v3-web.douyinvod.com/live1.mp4"]}}},
    {"url_list":["https://p/2.jpeg"]}]}}`
  const q = Douyin.fromWebDetail(live, '5')
  assert.ok(q.isImages); assert.equal(q.images.length, 2); assert.equal(q.liveCount, 1)
  assert.equal(q.images[0].urls[0], 'https://p/1.jpeg')
  assert.equal(q.images[0].liveVideoUrls[0], 'https://v3-web.douyinvod.com/live1.mp4')
})

// ---------------------------------------------------------------- 快手（真实分享页，2026-11 保存）

test('Kuaishou.ids', () => {
  assert.equal(Kuaishou.idFromUrl('https://www.kuaishou.com/short-video/3xqensd76nig6nw?authorId=3x'), '3xqensd76nig6nw')
  assert.equal(Kuaishou.idFromUrl('https://v.m.chenzhongtech.com/fw/photo/3xbfgiys9bhs9em?cc=share_copylink&photoId=3xbfgiys9bhs9em'), '3xbfgiys9bhs9em')
  assert.equal(Kuaishou.idFromUrl('https://v.kuaishou.com/2DV5QWg'), null)
})

test('Kuaishou.videoPage', () => {
  const r = Kuaishou.parsePage(fx('ks_video.html'), '3xqensd76nig6nw')
  assert.equal(r.type, 'ok')
  const p = r.post
  assert.equal(p.platform, Platform.KUAISHOU.name)
  assert.equal(p.isImages, false)
  assert.equal(p.author, '丨狐说')
  assert.ok(p.title.startsWith('黑色导弹'))
  assert.equal(p.durationMs, 185100)
  assert.ok(p.videoUrls.length > 0)
  assert.ok(p.videoUrls.every(u => u.includes('.mp4')))        // 不要 HLS
  assert.ok(p.videoUrls[0].includes('kwimgs.com'))
  assert.equal(p.pageUrl, 'https://www.kuaishou.com/short-video/3xqensd76nig6nw')
  assert.ok(p.headers.Referer)
})

test('Kuaishou.underReview', () => {
  const r = Kuaishou.parsePage(fx('ks_review.html'), '3xbfgiys9bhs9em')
  assert.equal(r.type, 'error')
  assert.equal(Kuaishou.errorText(r.code, r.msg), '快手：作品在审核中，请稍后观看。')
})

test('Kuaishou.atlasShape', () => {
  const html = `<script>window.INIT_STATE = {"x":{"photo":{"photoId":"3xatlas","caption":"图集","userName":"u","photoType":"VERTICAL_ATLAS",
      "ext_params":{"atlas":{"cdn":["p2.a.yximgs.com"],"list":["/ufile/atlas/a_0.jpg","/ufile/atlas/a_1.jpg"],"music":"/m.m4a"}},
      "coverUrls":[{"cdn":"p2.a.yximgs.com","url":"https://p2.a.yximgs.com/c.jpg"}]}}}</script>`
  const p = Kuaishou.parsePage(html, '3xatlas').post
  assert.ok(p.isImages)
  assert.equal(p.images.length, 2)
  assert.equal(p.images[1].urls[0], 'https://p2.a.yximgs.com/ufile/atlas/a_1.jpg')
})

test('Kuaishou.noState', () => {
  assert.equal(Kuaishou.parsePage('<html>captcha</html>', null).type, 'nodata')
})

// ---------------------------------------------------------------- 小红书（按文档结构构造的 fixtures）

const videoNote = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a6310ee000000001003f430":{"note":{
  "noteId":"6a6310ee000000001003f430","type":"video","title":"标题","desc":"正文 #话题","user":{"nickname":"小红"},
  "imageList":[{"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/0123abcd/1040g2sg31abc!nd_dft_wlteh_webp_3"}],
  "video":{"consumer":{"originVideoKey":"pre_post/1040g2t031origin"},"capa":{"duration":12},
    "media":{"stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/stream/720.mp4","width":720,"height":1280,"backupUrls":[]},
                                {"masterUrl":"http://sns-video-bd.xhscdn.com/stream/1080.mp4","width":1080,"height":1920}],
                       "h265":[{"masterUrl":"http://sns-video-bd.xhscdn.com/stream/1080h265.mp4","width":1080,"height":1920}]}}}}}},
  "serverRequestInfo":undefined}}</script>`

test('Xhs.videoNote', () => {
  const r = Xhs.parsePage(videoNote, '6a6310ee000000001003f430', 'https://www.xiaohongshu.com/explore/6a6310ee000000001003f430?xsec_token=x')
  const p = r.post
  assert.equal(p.isImages, false)
  assert.equal(p.author, '小红')
  assert.equal(p.durationMs, 12000)
  assert.equal(p.videoUrls[0], 'https://sns-video-bd.xhscdn.com/pre_post/1040g2t031origin') // 原始上传优先
  assert.equal(p.videoUrls[1], 'http://sns-video-bd.xhscdn.com/stream/1080.mp4')            // 然后最好的 H.264
  assert.ok(p.videoUrls.indexOf('http://sns-video-bd.xhscdn.com/stream/1080h265.mp4') > p.videoUrls.indexOf('http://sns-video-bd.xhscdn.com/stream/1080.mp4'))
})

test('Xhs.imageNoteWithLivePhoto', () => {
  const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a9d0eb2000000002a024480":{"note":{
      "noteId":"6a9d0eb2000000002a024480","type":"normal","title":"图文","desc":"","user":{"nickname":"n"},
      "imageList":[{"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/hash1/notes_pre_post/1040g3k0tokenA!nd_dft_wlteh_webp_3","livePhoto":false},
                   {"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/hash2/1040g2sgtokenB!nd_dft_wlteh_webp_3","livePhoto":true,
                    "stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/live/b.mp4"}],"h265":[]}}]}}}}}</script>`
  const p = Xhs.parsePage(html, '6a9d0eb2000000002a024480', 'u').post
  assert.ok(p.isImages)
  assert.equal(p.images.length, 2)
  assert.equal(p.images[0].urls[0], 'https://sns-img-bd.xhscdn.com/notes_pre_post/1040g3k0tokenA')
  assert.equal(p.images[0].liveVideoUrls.length, 0)
  assert.deepEqual(p.images[1].liveVideoUrls, ['http://sns-video-bd.xhscdn.com/live/b.mp4'])
  assert.equal(p.liveCount, 1)
})

test('Xhs.mobileShape', () => {
  const html = `<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"6a9d0eb2000000002a024480","type":"normal",
      "title":"t","user":{"nickName":"m"},"imageList":[{"url":"https://sns-webpic-qc.xhscdn.com/202611251530/h/tokenC!nd_whgt34_webp_wm_1"}]}}}}</script>`
  const p = Xhs.parsePage(html, '6a9d0eb2000000002a024480', 'u').post
  assert.equal(p.author, 'm')
  assert.equal(p.images[0].urls[0], 'https://sns-img-bd.xhscdn.com/tokenC')
})

test('Xhs.tokenAndIds', () => {
  assert.equal(Xhs.imageToken('http://sns-webpic-qc.xhscdn.com/202611251530/0123abcd/1040g2sg31abc!nd_dft_wlteh_webp_3'), '1040g2sg31abc')
  assert.equal(Xhs.imageToken('https://sns-img-bd.xhscdn.com/spectrum/1040g0k0x?imageView2/2/w/1080'), 'spectrum/1040g0k0x')
  assert.equal(Xhs.noteId('https://www.xiaohongshu.com/discovery/item/6a6310ee000000001003f430?app_platform=android&xsec_token=CB'), '6a6310ee000000001003f430')
  assert.equal(Xhs.noteId('https://xhslink.cn/o/AxnRePgIokn'), null)
  assert.equal(Xhs.parsePage('<html></html>', 'x', 'u').type, 'nodata')
  assert.ok(Xhs.secMessage('https://www.rednote.com/404/sec_x?source=xhs_sec_server').includes('海外'))
})
