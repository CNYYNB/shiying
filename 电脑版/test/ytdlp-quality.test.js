'use strict'
// 移植自 YtdlpSupportTest.kt + V21Test.kt + V22Test.kt 中与电脑版相关的部分（同样的真实 yt-dlp 输出 / 错误行）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Y = require('../src/core/ytdlp-support')
const Q = require('../src/core/quality')
const Douyin = require('../src/core/douyin')
const { Platform } = require('../src/core/platform')
const { UserError } = require('../src/core/post')

const res = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')

// ---------------------------------------------------------------- YtdlpSupportTest

test('parseInfo tiktok', () => {
  const p = Y.parseInfo(res('yt_tiktok.json'), Platform.TIKTOK, 'https://www.tiktok.com/@zachking/video/6768504823336815877', '/x/info.json')
  assert.equal(p.engine, 'ytdlp')
  assert.equal(p.author, 'zachking')
  assert.ok(p.title.startsWith('They rejected my application'))
  assert.equal(p.height, 1080)
  assert.equal(p.infoJson, '/x/info.json')
  assert.equal(p.entries, 1)
  assert.ok(p.durationMs > 0)
  assert.ok(p.cover)
})

test('parseInfo weibo and X', () => {
  const w = Y.parseInfo(res('yt_weibo.json'), Platform.WEIBO, 'u', null)
  assert.equal(w.height, 1080); assert.equal(w.author, '睡前视频基地')
  const x = Y.parseInfo(res('yt_x.json'), Platform.X, 'u', null)
  assert.equal(x.author, 'SpaceX'); assert.equal(x.height, 1080); assert.equal(x.platform, 'X')
})

test('parseInfo playlist carousel', () => {
  const json = `{"_type":"playlist","id":"BQ0eAlwhDrw","title":"Post by instagram","description":"caption text","uploader":"instagram",
      "webpage_url":"https://www.instagram.com/p/BQ0eAlwhDrw/","entries":[
      {"id":"a","formats":[{"url":"https://x/1.mp4","height":1280,"width":720}],"height":1280,"width":720,"duration":5.0,"thumbnail":"https://x/t1.jpg"},
      {"id":"b","formats":[],"duration":0},
      {"id":"c","formats":[{"url":"https://x/2.mp4"}],"height":640,"width":640,"duration":3.5}]}`
  const p = Y.parseInfo(json, Platform.INSTAGRAM, 'u', null)
  assert.equal(p.entries, 2)
  assert.equal(p.title, 'caption text')
  assert.equal(p.durationMs, 8500)
  assert.equal(p.height, 720)
  assert.equal(p.cover, 'https://x/t1.jpg')
})

test('parseInfo empty playlist throws', () => {
  assert.throws(() => Y.parseInfo('{"_type":"playlist","entries":[]}', Platform.INSTAGRAM, 'u', null), UserError)
})

test('options', () => {
  const o = Y.infoOptions(Platform.TIKTOK, '1080', '/c/cookies.txt')
  for (const k of ['--dump-single-json', '--no-playlist', '--cookies', '/c/cookies.txt']) assert.ok(o.includes(k), k)
  assert.equal(o[o.indexOf('-S') + 1], 'res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a')
  assert.ok(o[o.indexOf('-f') + 1].includes('format_note!*=atermark'))
  const d = Y.downloadOptions(Platform.BILIBILI, 'best', null, '/i.json', '/out')
  assert.equal(d[d.indexOf('--load-info-json') + 1], '/i.json')
  assert.equal(d[d.indexOf('--merge-output-format') + 1], 'mp4')
  assert.ok(d[d.indexOf('-o') + 1].startsWith('/out/'))
  assert.equal(d[d.indexOf('-S') + 1], 'res,vcodec:h264,acodec:aac,ext:mp4:m4a')
  assert.ok(!d.includes('--cookies'))
  assert.equal(d[d.indexOf('-f') + 1], 'bv*+ba/b')
  // 电脑版：Windows 路径分隔符
  const w = Y.downloadOptions(Platform.BILIBILI, '720', null, 'C:\\i.json', 'C:\\tmp\\job', '\\')
  assert.ok(w[w.indexOf('-o') + 1].startsWith('C:\\tmp\\job\\'))
})

test('errorMessages', () => {
  const m = (s, p = Platform.YOUTUBE) => Y.errorMessage(s, p)
  assert.ok(m('ERROR: [BiliBili] 13x41117TL: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)', Platform.BILIBILI).includes('限流'))
  assert.ok(m('ERROR: [TikTok] 7202950113931234606: Your IP address is blocked from accessing this post', Platform.TIKTOK).includes('IP'))
  assert.ok(m('ERROR: [facebook] 1388064706077874: This video is age-restricted and requires authentication. Use --cookies-from-browser', Platform.FACEBOOK).includes('年龄'))
  assert.ok(m('ERROR: [twitter] 643211948184596480: No video could be found in this tweet', Platform.X).includes('没有可下载的视频'))
  assert.ok(m('ERROR: [Instagram] BQ0eAlwhDrw: The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously. Use --cookies', Platform.INSTAGRAM).includes('限流'))
  assert.ok(m('ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser', Platform.VIMEO).includes('需要登录'))
  assert.ok(m('ERROR: [youtube] jNQXAC9IVRw: Failed to extract any player response; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= ').includes('更新解析引擎'))
  assert.ok(m('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser').includes('机器人'))
  assert.ok(m("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video").includes('私密'))
  assert.ok(m('ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader').includes('已被删除'))
  assert.ok(m('ERROR: [youtube] abc: The uploader has not made this video available in your country').includes('地区限制'))
  assert.ok(m('ERROR: [youtube] abc: Join this channel to get access to members-only content like this video').includes('会员'))
  assert.ok(m('ERROR: [BiliBili] BV1x: This video is for premium members only', Platform.BILIBILI).includes('会员'))
  assert.ok(m('ERROR: Unsupported URL: https://example.com/', Platform.OTHER).includes('不支持'))
  assert.ok(m('ERROR: [generic] x: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>', Platform.OTHER).includes('网络错误'))
  assert.ok(m('ERROR: [vimeo] 54469442: This request has been blocked due to its TLS fingerprint. Install a required impersonation dependency if possible', Platform.VIMEO).includes('TLS'))
  assert.equal(Y.errorLine('WARNING: x\nERROR: [twitter] 643211948184596480: No video could be found in this tweet\n'), 'No video could be found in this tweet')
  // 电脑版：Windows 上的网络错误
  assert.ok(m('ERROR: [generic] x: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', Platform.OTHER).includes('网络错误'))
  assert.ok(Y.netProblem('ERROR: [youtube] x: Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed>'))
})

// ---------------------------------------------------------------- V21Test：画质

test('quality pick at or below else nearest', () => {
  const hs = [1080, 720, 540, 360]
  assert.equal(Q.pick(hs, 'best'), 1080)
  assert.equal(Q.pick(hs, '1080'), 1080)
  assert.equal(Q.pick(hs, '720'), 720)
  assert.equal(Q.pick(hs, '480'), 360)
  assert.equal(Q.pick(hs, '360'), 360)
  assert.equal(Q.pick(hs, 'worst'), 360)
  assert.equal(Q.pick([720, 1080], '360'), 720)
  assert.equal(Q.pick([2160, 1080], 'best'), 2160)
  assert.equal(Q.pick([0, 0], '720'), 0)
  assert.equal(Q.pick([2160, 1440, 1080], '1440'), 1440)
})

test('quality normalize keeps old values', () => {
  assert.equal(Q.normalize(null), '1080')
  assert.equal(Q.normalize('best'), 'best')
  assert.equal(Q.normalize('1080'), '1080')
  assert.equal(Q.normalize('garbage'), '1080')
  assert.equal(Q.normalize('1440'), '1440')
})

test('quality sortArgs', () => {
  assert.equal(Q.sortArg('1080'), 'res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a')
  assert.equal(Q.sortArg('480'), 'res:480,vcodec:h264,acodec:aac,ext:mp4:m4a')
  assert.equal(Q.sortArg('best'), 'res,vcodec:h264,acodec:aac,ext:mp4:m4a')
  assert.ok(Q.sortArg('worst').startsWith('+res'))
  assert.equal(Y.sortArg('720'), Q.sortArg('720'))
})

test('quality order puts picked rendition first', () => {
  const urls = ['a1080', 'b720', 'c540', 'dunknown']
  const hs = { a1080: 1080, b720: 720, c540: 540 }
  assert.deepEqual(Q.order(urls, hs, '1080'), urls)
  assert.deepEqual(Q.order(urls, hs, '720'), ['b720', 'a1080', 'c540', 'dunknown'])
  assert.deepEqual(Q.order(urls, hs, 'worst'), ['c540', 'a1080', 'b720', 'dunknown'])
  assert.deepEqual(Q.order(urls, hs, '360'), ['c540', 'a1080', 'b720', 'dunknown'])
  assert.deepEqual(Q.order(urls, {}, '360'), urls)
})

test('douyin candidates carry heights', () => {
  const video = JSON.parse(`{"play_addr":{"uri":"v0200fg10000abc","url_list":["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200fg10000abc&ratio=720p&line=0"]},
      "bit_rate":[{"bit_rate":2000000,"is_h265":0,"play_addr":{"width":1080,"height":1920,"url_list":["https://v3.douyinvod.com/1080.mp4"]}},
                  {"bit_rate":900000,"is_h265":0,"play_addr":{"width":720,"height":1280,"url_list":["https://v3.douyinvod.com/720.mp4"]}}]}`)
  const [urls, hs] = Douyin.videoCandidatesWithHeights(video)
  assert.equal(urls[0], 'https://v3.douyinvod.com/1080.mp4')
  assert.equal(hs['https://v3.douyinvod.com/1080.mp4'], 1080)
  assert.equal(hs['https://v3.douyinvod.com/720.mp4'], 720)
  assert.ok(urls.some(u => u.includes('/play/') && u.includes('ratio=540p')))
  assert.equal(hs[urls.find(u => u.includes('ratio=540p'))], 540)
  assert.ok(urls.every(u => !u.includes('playwm')))
  assert.equal(Q.order(urls, hs, '720')[0], 'https://v3.douyinvod.com/720.mp4')
  assert.equal(Q.pick(Object.values(hs), '480'), 540)
})

test('ytdlp heights with sizes', () => {
  const json = `{"id":"x","duration":60,"formats":[
      {"format_id":"140","vcodec":"none","acodec":"mp4a.40.2","filesize":1000000},
      {"format_id":"sb0","vcodec":"none","acodec":"none","format_note":"storyboard","ext":"mhtml"},
      {"format_id":"134","vcodec":"avc1","acodec":"none","width":640,"height":360,"filesize":3000000},
      {"format_id":"136","vcodec":"avc1","acodec":"none","width":1280,"height":720,"filesize":9000000},
      {"format_id":"18","vcodec":"avc1","acodec":"mp4a","width":640,"height":360,"filesize":5000000},
      {"format_id":"137","vcodec":"avc1","acodec":"none","width":1920,"height":1080,"tbr":2000}]}`
  const hs = Q.ytdlpHeights(json)
  assert.deepEqual(hs.map(h => h[0]), [1080, 720, 360])
  assert.equal(hs.find(h => h[0] === 720)[1], 10_000_000)
  assert.equal(hs.find(h => h[0] === 360)[1], 4_000_000)
  assert.equal(hs.find(h => h[0] === 1080)[1], 2000 * 125 * 60 + 1_000_000)
})

// ---------------------------------------------------------------- V21 / V22：YouTube

test('youtube ids', () => {
  assert.equal(Y.youtubeId('https://youtu.be/yWPrZluVsOA?si=abc'), 'yWPrZluVsOA')
  assert.equal(Y.youtubeId('https://youtube.com/shorts/kVk_Nwca6Wk?feature=share'), 'kVk_Nwca6Wk')
  assert.equal(Y.youtubeId('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1'), 'jNQXAC9IVRw')
  assert.equal(Y.youtubeId('https://www.youtube.com/@channel'), null)
})

const botLine = 'ERROR: [youtube] yWPrZluVsOA: Sign in to confirm you’re not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.'
const noPlayer = 'ERROR: [youtube] yWPrZluVsOA: Failed to extract any player response; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template.'

test('blocked vs final errors', () => {
  assert.ok(Y.ytBlocked(botLine))
  assert.ok(Y.ytBlocked(noPlayer))
  assert.ok(Y.ytBlocked('WARNING: Unable to download API page: HTTP Error 403: Forbidden\nERROR: x'))
  assert.equal(Y.ytBlocked("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video"), false)
  assert.equal(Y.ytBlocked('ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader'), false)
  assert.equal(Y.ytBlocked('ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.'), false)
  assert.equal(Y.ytReason(botLine), '要求验证不是机器人')
  assert.ok(Y.ytReason(noPlayer).includes('403'))
})

test('summary names every step and suggests fixes', () => {
  const m = Y.youtubeSummary([
    { name: '解析引擎 2026.11.23', result: '要求验证不是机器人' },
    { name: '备用客户端（tv / ios / visionos 等）', result: 'IP 被拒绝，拿不到播放信息（403）' },
    { name: 'PO Token 验证', result: '要求验证不是机器人' }], Y.YtAuth.NONE)
  assert.ok(m.includes('1. 解析引擎 2026.11.23：要求验证不是机器人'))
  assert.ok(m.includes('3. PO Token 验证'))
  assert.ok(m.includes('换一个 VPN 节点'))
  assert.ok(m.includes('登录') && m.includes('cookies.txt'))
  assert.ok(Y.youtubeSummary([], Y.YtAuth.ROTATED).includes('重新登录'))
  assert.ok(Y.YT_ALT_CLIENTS.startsWith('youtube:player_client=tv'))
})

test('first youtube attempt matches YTDLnis defaults', () => {
  const o = Y.infoOptions(Platform.YOUTUBE, '1080', null)
  assert.ok(!o.some(x => x.includes('player_client')))
  assert.ok(!o.includes('--extractor-args'))
  assert.ok(!o.includes('--proxy'))
  assert.ok(!o.includes('--cookies'))
  assert.ok(o.includes('--no-check-certificates'))
  assert.ok(o.includes('-v') && !o.includes('--no-warnings'))
  const c = Y.infoOptions(Platform.YOUTUBE, '1080', '/c.txt'); assert.ok(c.includes('--cookies') && c.includes('/c.txt'))
  assert.ok(Y.infoOptions(Platform.TIKTOK, '1080', null).includes('--no-warnings'))
  assert.ok(!Y.infoOptions(Platform.WEIBO, '1080', null).includes('-v'))
})

test('anonymous cookies are not a login', () => {
  const A = Y.CookieText.youtubeAuth
  assert.equal(A(['VISITOR_INFO1_LIVE', 'YSC', 'PREF', 'VISITOR_PRIVACY_METADATA', '__Secure-ROLLOUT_TOKEN']), false)
  assert.equal(A(['SAPISID', 'SID', '__Secure-3PSID']), false)
  assert.ok(A(['LOGIN_INFO', '__Secure-3PAPISID', 'YSC']))
  assert.ok(A(['LOGIN_INFO', 'SAPISID']))
})

test('netscape lines and imported names', () => {
  assert.equal(Y.CookieText.line('youtube.com', 'LOGIN_INFO', 'AFmm:QU=Q', 1800000000), '.youtube.com\tTRUE\t/\tTRUE\t1800000000\tLOGIN_INFO\tAFmm:QU=Q')
  assert.deepEqual(Y.CookieText.pairs('a=1; b=x=y=; c=; =bad'), [['a', '1'], ['b', 'x=y='], ['c', '']])
  const ext = '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tv\n' +
    '.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PAPISID\tv\n.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\tg\nwww.youtube.com\tFALSE\t/\tFALSE\t0\tYSC\ty\n'
  assert.deepEqual(Y.CookieText.youtubeNames(ext), new Set(['LOGIN_INFO', '__Secure-3PAPISID', 'YSC']))
  assert.ok(Y.CookieText.youtubeAuth(Y.CookieText.youtubeNames(ext)))
})

const verbose = `[debug] Command-line config: ['-v', '--no-playlist', 'https://www.youtube.com/watch?v=kVk_Nwca6Wk']
[debug] [youtube] [pot] PO Token Providers: shiying-1.0.0 (external)
[debug] [youtube] [jsc] JS Challenge Providers: quickjs
[debug] Loading youtube-nsig.abc from cache; cookies were sent; sign in state unknown
[youtube] kVk_Nwca6Wk: Downloading tv samsung player API JSON`

test('debug lines are not classified', () => {
  const privateVid = `${verbose}\nERROR: [youtube] kVk_Nwca6Wk: Private video. Sign in if you've been granted access to this video`
  assert.equal(Y.ytBlocked(privateVid), false)
  assert.equal(Y.errorMessage(privateVid, Platform.YOUTUBE), '这是私密内容，无法下载（YouTube）')
  const bot = `${verbose}\nERROR: [youtube] kVk_Nwca6Wk: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.`
  assert.ok(Y.ytBlocked(bot))
  assert.equal(Y.ytReason(bot), '要求验证不是机器人')
  assert.equal(Y.jsProblem(bot), false)
})

test('js challenge failure is not a bot check', () => {
  const js = `${verbose}\nWARNING: [youtube] kVk_Nwca6Wk: n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime and challenge solver script distribution installed.\n` +
    'ERROR: [youtube] kVk_Nwca6Wk: Requested format is not available. Use --list-formats for a list of available formats'
  assert.ok(Y.jsProblem(js))
  assert.ok(Y.ytBlocked(js))
  assert.ok(Y.ytReason(js).includes('JS'))
  assert.ok(Y.youtubeSummary([{ name: 'a', result: 'b' }], Y.YtAuth.NONE, true).includes('更新解析引擎'))
})

test('network errors are detected', () => {
  assert.ok(Y.netProblem('ERROR: [youtube] x: Unable to download API page: <urlopen error [Errno 7] No address associated with hostname> (caused by TransportError)'))
  assert.ok(Y.netProblem('ERROR: [youtube] x: Unable to download webpage: The read operation timed out'))
  assert.equal(Y.netProblem('ERROR: [youtube] x: Sign in to confirm you’re not a bot'), false)
})

test('real verbose log from yt-dlp', () => {
  const log = res('yt/verbose-rotated-403.txt')
  assert.equal(Y.ytAuth(log), Y.YtAuth.ROTATED)
  assert.ok(Y.ytBlocked(log))
  assert.ok(Y.ytReason(log).includes('403'))
  assert.equal(Y.ytAuth('[debug] [youtube] Found YouTube account cookies\n'), Y.YtAuth.OK)
  assert.equal(Y.ytAuth(verbose), Y.YtAuth.NONE)
})

test('summary reports the real login state', () => {
  const steps = [{ name: '默认', result: '要求验证不是机器人' }]
  assert.ok(Y.youtubeSummary(steps, Y.YtAuth.NONE).includes('未登录 YouTube'))
  assert.ok(!Y.youtubeSummary(steps, Y.YtAuth.NONE).includes('已带上'))
  assert.ok(Y.youtubeSummary(steps, Y.YtAuth.OK).includes('已带上 YouTube 登录状态'))
  assert.ok(Y.youtubeSummary(steps, Y.YtAuth.ROTATED).includes('已失效'))
  assert.ok(Y.youtubeSummary(steps, Y.YtAuth.NONE).includes('复制诊断日志'))
  assert.ok(Y.youtubeSummary(steps, Y.YtAuth.NONE, false, false).includes('Deno'))
})

test('redaction hides tokens and keeps the story', () => {
  const tok = 'MnQBj8Fp0TrB2Zyx' + 'a'.repeat(80)
  const log = "[debug] Command-line config: ['--extractor-args', 'youtube:player_client=web;visitor_data=CgtVaXNpdG9yRGF0YTEyMw%3D%3D', " +
    "'--cookies', 'C:\\Users\\luke\\AppData\\Roaming\\拾影\\cookies\\youtube.txt']\n" +
    `[debug] [youtube] x: Retrieved a gvs PO Token for web client: ${tok}\n` +
    'Authorization: SAPISIDHASH 1732500000_abcdef0123456789abcdef0123456789abcdef01\n' +
    'ERROR: [youtube] kVk_Nwca6Wk: Sign in to confirm you’re not a bot.'
  const r = Y.redact(log)
  assert.ok(!r.includes('CgtVaXNpdG9yRGF0YTEyMw'))
  assert.ok(!r.includes(tok))
  assert.ok(!r.includes('abcdef0123456789abcdef'))
  assert.ok(r.includes('Sign in to confirm you’re not a bot'))
  assert.ok(r.includes('kVk_Nwca6Wk'))
  assert.ok(r.includes('youtube.txt'))
})

test('deno js runtime args', () => {
  assert.deepEqual(Y.jsRuntimeArgs('C:\\Users\\a\\AppData\\Roaming\\拾影\\bin\\deno.exe'), ['--js-runtimes', 'deno:C:\\Users\\a\\AppData\\Roaming\\拾影\\bin\\deno.exe'])
  assert.deepEqual(Y.jsRuntimeArgs(null), [])
})
