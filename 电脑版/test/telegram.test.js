'use strict'
// Telegram：链接解析、代理、错误归类、媒体挑选、脱敏，以及用假客户端测解析 / 下载 / 登录流程（不联网）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const TgS = require('../src/core/telegram-support')
const { TelegramService } = require('../src/core/telegram')
const { TelegramAccount, normalizePhone, checkApi, systemCandidates } = require('../src/core/telegram-account')
const Links = require('../src/core/links')
const P = require('../src/core/platform')
const Extractor = require('../src/core/extractor')
const { Cancelled, UserError } = require('../src/core/post')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-tg-'))
const reason = (fn) => { try { fn(); return null } catch (e) { return e.reason || e.message } }

// ------------------------------------------------------------------ links

test('Telegram.parseLink 公开频道 / 用户名', () => {
  let l = TgS.parseLink('https://t.me/durov/123')
  assert.equal(l.kind, 'username'); assert.equal(l.username, 'durov'); assert.equal(l.msgId, 123)
  assert.equal(l.single, false); assert.equal(l.topicId, null); assert.equal(l.publicFallback, true)
  assert.equal(l.url, 'https://t.me/durov/123')
  l = TgS.parseLink('https://telegram.me/Some_Channel/45?single')
  assert.equal(l.username, 'Some_Channel'); assert.equal(l.msgId, 45); assert.equal(l.single, true)
  assert.equal(l.url, 'https://t.me/Some_Channel/45?single')
  assert.equal(TgS.parseLink('https://telegram.dog/abcde/7').msgId, 7)
  assert.equal(TgS.parseLink('http://www.t.me/abcde/8').msgId, 8)
  assert.equal(TgS.parseLink('t.me/abcde/9').msgId, 9) // 没有 https://
  l = TgS.parseLink('https://t.me/s/abcde/10') // 网页预览
  assert.equal(l.username, 'abcde'); assert.equal(l.msgId, 10)
  l = TgS.parseLink('https://abcde.t.me/11') // 用户名子域名
  assert.equal(l.username, 'abcde'); assert.equal(l.msgId, 11)
})

test('Telegram.parseLink 私密频道 t.me/c、话题、评论、thread', () => {
  let l = TgS.parseLink('https://t.me/c/1234567890/55')
  assert.equal(l.kind, 'channel'); assert.equal(l.channelId, '1234567890'); assert.equal(l.msgId, 55); assert.equal(l.publicFallback, false)
  l = TgS.parseLink('https://t.me/c/1234567890/3/77') // 论坛话题
  assert.equal(l.topicId, 3); assert.equal(l.msgId, 77)
  assert.equal(l.url, 'https://t.me/c/1234567890/3/77')
  l = TgS.parseLink('https://t.me/c/1234567890/77?thread=3')
  assert.equal(l.threadId, 3); assert.equal(l.msgId, 77)
  l = TgS.parseLink('https://t.me/somechan/100?comment=2001')
  assert.equal(l.commentId, 2001); assert.equal(l.msgId, 100); assert.equal(l.publicFallback, false)
  l = TgS.parseLink('https://t.me/somegroup/5/900?single') // 公开论坛群的话题
  assert.equal(l.topicId, 5); assert.equal(l.msgId, 900); assert.equal(l.single, true)
  l = TgS.parseLink('https://t.me/somechan/100?single&comment=3')
  assert.equal(l.single, true); assert.equal(l.commentId, 3)
})

test('Telegram.parseLink tg:// 链接', () => {
  let l = TgS.parseLink('tg://resolve?domain=durov&post=12&single')
  assert.equal(l.username, 'durov'); assert.equal(l.msgId, 12); assert.equal(l.single, true)
  l = TgS.parseLink('tg://privatepost?channel=1234567890&post=34&thread=2')
  assert.equal(l.kind, 'channel'); assert.equal(l.channelId, '1234567890'); assert.equal(l.msgId, 34); assert.equal(l.threadId, 2)
  assert.equal(TgS.tgSchemeToHttps('看这个 tg://resolve?domain=durov&post=12 '), 'https://t.me/durov/12')
})

test('Telegram.parseLink 不是消息链接', () => {
  assert.equal(reason(() => TgS.parseLink('https://t.me/+AbCdEf123')), 'invite')
  assert.equal(reason(() => TgS.parseLink('https://t.me/joinchat/AbCdEf')), 'invite')
  assert.equal(reason(() => TgS.parseLink('https://t.me/durov')), 'no_message')
  assert.equal(reason(() => TgS.parseLink('https://t.me/c/1234567890')), 'no_message')
  assert.equal(reason(() => TgS.parseLink('https://t.me/addstickers/Cats')), 'not_message')
  assert.equal(reason(() => TgS.parseLink('https://t.me/proxy?server=1.2.3.4&port=443&secret=00')), 'not_message')
  assert.equal(reason(() => TgS.parseLink('https://t.me/durov/abc')), 'bad')
  assert.equal(reason(() => TgS.parseLink('https://t.me/c/abc/1')), 'bad')
  assert.equal(reason(() => TgS.parseLink('https://t.me/durov/1/2/3')), 'bad')
  assert.equal(reason(() => TgS.parseLink('https://example.com/durov/1')), 'not_message')
  assert.equal(reason(() => TgS.parseLink('')), 'bad')
  assert.ok(TgS.parseLink.length === 1)
})

test('Telegram 平台识别（分享文字、无 scheme、tg://）', () => {
  assert.equal(P.ofUrl('https://t.me/durov/1'), P.Platform.TELEGRAM)
  assert.equal(P.ofUrl('https://telegram.me/durov/1'), P.Platform.TELEGRAM)
  assert.equal(P.ofUrl('https://telegram.dog/durov/1'), P.Platform.TELEGRAM)
  assert.equal(P.Platform.TELEGRAM.engine, 'telegram')
  assert.equal(Links.detect('看看这个 https://t.me/durov/123?single 不错'), P.Platform.TELEGRAM)
  assert.equal(Links.findUrl('看看这个 https://t.me/durov/123?single，不错'), 'https://t.me/durov/123?single')
  assert.equal(Links.detect('t.me/c/1234567890/55'), P.Platform.TELEGRAM)
  assert.equal(Links.findUrl('t.me/c/1234567890/55'), 'https://t.me/c/1234567890/55')
  assert.equal(Links.detect('tg://privatepost?channel=1234567890&post=34'), P.Platform.TELEGRAM)
  assert.ok(Links.looksSupported('https://t.me/durov/1'))
  // 其他平台不受影响
  assert.equal(Links.detect('https://www.bilibili.com/video/BV1GJ411x7h7/'), P.Platform.BILIBILI)
  assert.equal(P.loginable().some(p => p.name === 'TELEGRAM'), false) // 不进网页登录列表
})

// ------------------------------------------------------------------ proxy

test('Telegram.parseProxy', () => {
  assert.equal(TgS.parseProxy(''), null)
  assert.deepEqual(TgS.parseProxy('socks5://127.0.0.1:7890'), { ip: '127.0.0.1', port: 7890, socksType: 5, username: undefined, password: undefined, timeout: 10 })
  assert.deepEqual(TgS.parseProxy('127.0.0.1:10808'), { ip: '127.0.0.1', port: 10808, socksType: 5, username: undefined, password: undefined, timeout: 10 })
  const a = TgS.parseProxy('socks5h://u%40x:p%3Aw@proxy.example.com:1080/')
  assert.equal(a.username, 'u@x'); assert.equal(a.password, 'p:w'); assert.equal(a.ip, 'proxy.example.com'); assert.equal(a.port, 1080)
  const mt = TgS.parseProxy('tg://proxy?server=1.2.3.4&port=443&secret=dd0123456789abcdef0123456789abcdef')
  assert.equal(mt.MTProxy, true); assert.equal(mt.ip, '1.2.3.4'); assert.equal(mt.port, 443); assert.equal(mt.secret, 'dd0123456789abcdef0123456789abcdef')
  assert.equal(TgS.parseProxy('https://t.me/proxy?server=h.example&port=8443&secret=0123456789ABCDEF0123456789ABCDEF').secret, '0123456789abcdef0123456789abcdef')
  assert.equal(TgS.parseProxy('https://t.me/socks?server=1.2.3.4&port=1080&user=a&pass=b').username, 'a')
  assert.throws(() => TgS.parseProxy('http://127.0.0.1:7890'), /不支持 HTTP 代理/)
  assert.throws(() => TgS.parseProxy('tg://proxy?server=1.2.3.4&port=443&secret=ee0123456789abcdef0123456789abcdef676f6f676c652e636f6d'), /FakeTLS/)
  assert.throws(() => TgS.parseProxy('socks5://127.0.0.1'), /格式不对/)
  assert.throws(() => TgS.parseProxy('ftp://1.2.3.4:21'), /socks5/)
  assert.equal(TgS.describeProxy(null), '直连')
})

test('Telegram 系统代理候选（HTTP 端口按 SOCKS5 试，最后直连）', () => {
  assert.deepEqual(systemCandidates('DIRECT', {}).map(c => c.label), ['直连'])
  const c = systemCandidates('PROXY 127.0.0.1:7890; DIRECT', {})
  assert.equal(c.length, 2); assert.equal(c[0].proxy.port, 7890); assert.equal(c[0].proxy.socksType, 5); assert.equal(c[1].proxy, null)
  assert.equal(systemCandidates('SOCKS5 127.0.0.1:1080', {})[0].proxy.port, 1080)
  assert.equal(systemCandidates('DIRECT', { ALL_PROXY: 'socks5://10.0.0.1:1080' })[0].proxy.ip, '10.0.0.1')
})

// ------------------------------------------------------------------ errors

test('Telegram 错误归类', () => {
  const rpc = (m, extra = {}) => Object.assign(new Error('400: ' + m), { errorMessage: m, ...extra })
  let c = TgS.classifyError(Object.assign(new Error('A wait of 120 seconds is required'), { errorMessage: 'FLOOD', seconds: 120 }))
  assert.equal(c.kind, 'flood'); assert.match(c.message, /120 秒/)
  c = TgS.classifyError(rpc('FLOOD_WAIT_45'))
  assert.equal(c.kind, 'flood'); assert.match(c.message, /45 秒/)
  assert.equal(TgS.classifyError(rpc('CHAT_FORWARDS_RESTRICTED')).message, '该频道/聊天禁止保存内容，拾影不下载这类内容')
  for (const m of ['CHANNEL_PRIVATE', 'USER_NOT_PARTICIPANT', 'CHANNEL_INVALID', 'PEER_ID_INVALID']) assert.equal(TgS.classifyError(rpc(m)).kind, 'no_access', m)
  assert.equal(TgS.classifyError(rpc('USERNAME_NOT_OCCUPIED')).kind, 'not_found')
  assert.equal(TgS.classifyError(new Error('Cannot find any entity corresponding to "nosuch"')).kind, 'not_found')
  assert.equal(TgS.classifyError(rpc('MSG_ID_INVALID')).kind, 'deleted')
  assert.equal(TgS.classifyError(rpc('API_ID_INVALID')).kind, 'auth_api')
  assert.equal(TgS.classifyError(rpc('PHONE_NUMBER_INVALID')).kind, 'auth_phone')
  assert.equal(TgS.classifyError(rpc('PHONE_CODE_INVALID')).kind, 'auth_code')
  assert.equal(TgS.classifyError(rpc('PHONE_CODE_EXPIRED')).kind, 'auth_code_expired')
  assert.equal(TgS.classifyError(rpc('PASSWORD_HASH_INVALID')).kind, 'auth_password')
  assert.equal(TgS.classifyError(rpc('SESSION_PASSWORD_NEEDED')).kind, 'auth_need_password')
  assert.equal(TgS.classifyError(rpc('AUTH_KEY_UNREGISTERED')).kind, 'session')
  assert.equal(TgS.classifyError(rpc('SESSION_REVOKED')).kind, 'session')
  c = TgS.classifyError(new Error('connect ECONNREFUSED 127.0.0.1:7890'), 'login')
  assert.equal(c.kind, 'net'); assert.match(c.message, /连不上 Telegram/); assert.match(c.message, /SOCKS5/)
  assert.equal(TgS.classifyError(new Error('Connection to telegram failed: timed out')).kind, 'net')
  let le; try { TgS.parseLink('https://t.me/+abc') } catch (e) { le = e }
  assert.equal(TgS.classifyError(le).kind, 'invalid')
  assert.equal(TgS.classifyError(rpc('SOMETHING_ODD')).kind, 'other')
})

// ------------------------------------------------------------------ media

const vdoc = (id, size, extra = {}) => ({ className: 'Document', id, size, mimeType: 'video/mp4', attributes: [{ className: 'DocumentAttributeVideo', w: 1280, h: 720, duration: 12.5 }], thumbs: [{ className: 'PhotoSize', type: 'm', w: 320, h: 180, size: 9000 }], ...extra })
const photo = (id) => ({ className: 'MessageMediaPhoto', photo: { className: 'Photo', id, sizes: [{ className: 'PhotoStrippedSize', type: 'i' }, { className: 'PhotoSize', type: 'm', w: 320, h: 240, size: 12000 }, { className: 'PhotoSizeProgressive', type: 'y', w: 1280, h: 960, sizes: [5000, 50000, 120000] }] } })
const msg = (id, media, extra = {}) => ({ className: 'Message', id, message: '', media, ...extra })

test('Telegram.mediaItems：视频挑最大、相片、GIF、图片文件、贴纸 / 音频不下载', () => {
  const big = { valueOf() { return 9 }, toJSNumber: () => 90_000_000 } // GramJS 的 BigInteger
  let it = TgS.mediaItems(msg(1, { className: 'MessageMediaDocument', document: vdoc(1, 20_000_000), altDocuments: [vdoc(2, big), vdoc(3, 5_000_000)] }))
  assert.equal(it.length, 1); assert.equal(it[0].kind, 'video'); assert.equal(it[0].alt, 0); assert.equal(it[0].size, 90_000_000); assert.equal(it[0].ext, '.mp4')
  it = TgS.mediaItems(msg(1, { className: 'MessageMediaDocument', document: vdoc(1, 20_000_000), altDocuments: [vdoc(3, 5_000_000)] }))
  assert.equal(it[0].alt, -1); assert.equal(it[0].h, 720); assert.equal(it[0].duration, 12.5)
  it = TgS.mediaItems(msg(2, photo(7)))
  assert.deepEqual([it[0].kind, it[0].ext, it[0].size, it[0].w], ['photo', '.jpg', 120000, 1280])
  it = TgS.mediaItems(msg(3, { className: 'MessageMediaDocument', document: vdoc(4, 100, { attributes: [{ className: 'DocumentAttributeAnimated' }, { className: 'DocumentAttributeVideo', w: 1, h: 1 }] }) }))
  assert.equal(it[0].kind, 'gif')
  it = TgS.mediaItems(msg(4, { className: 'MessageMediaDocument', document: { className: 'Document', size: 3000, mimeType: 'image/png', attributes: [{ className: 'DocumentAttributeFilename', fileName: 'a.png' }] } }))
  assert.deepEqual([it[0].kind, it[0].ext], ['image', '.png'])
  it = TgS.mediaItems(msg(5, { className: 'MessageMediaDocument', document: { className: 'Document', size: 3000, mimeType: 'video/quicktime', attributes: [] } }))
  assert.equal(it[0].ext, '.mov')
  const sticker = msg(6, { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'image/webp', attributes: [{ className: 'DocumentAttributeSticker' }] } })
  assert.equal(TgS.mediaItems(sticker).length, 0); assert.match(TgS.noMediaReason(sticker), /贴纸/)
  const audio = msg(7, { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'audio/ogg', attributes: [{ className: 'DocumentAttributeAudio' }] } })
  assert.equal(TgS.mediaItems(audio).length, 0); assert.match(TgS.noMediaReason(audio), /音频/)
  assert.match(TgS.noMediaReason(msg(8, null)), /只有文字/)
  assert.match(TgS.noMediaReason(msg(9, { className: 'MessageMediaPaidMedia' })), /付费/)
})

test('Telegram 相册（grouped_id）与禁止保存', () => {
  const g = { toString: () => '777' }
  const ms = [msg(9, photo(1)), msg(10, photo(2), { groupedId: g }), msg(12, photo(3), { groupedId: '777' }), msg(11, photo(4), { groupedId: 777 }), msg(13, photo(5), { groupedId: 778 }), { className: 'MessageEmpty', id: 14 }]
  assert.deepEqual(TgS.albumOf(ms[1], ms).map(m => m.id), [10, 11, 12])
  assert.deepEqual(TgS.albumOf(ms[0], ms).map(m => m.id), [9])
  assert.deepEqual(TgS.albumWindow(3), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(TgS.albumWindow(100).length, 19)
  assert.equal(TgS.isProtected({ noforwards: true }, null), true)
  assert.equal(TgS.isProtected({}, { noforwards: true }), true)
  assert.equal(TgS.isProtected({}, {}), false)
})

test('Telegram 诊断日志脱敏', () => {
  const session = '1BAAOMTQ5LjE1NC4xNjcuOTEAUA' + 'x'.repeat(300)
  const s = TgS.redact(`session=${session} apiHash: 0123456789abcdef0123456789abcdef phone +86 138 0013 8000 code=12345 pw hunter22 手机 13800138000`, ['hunter22', '12345', '+8613800138000'])
  assert.ok(!s.includes('xxxxxxxx')); assert.ok(!s.includes('0123456789abcdef')); assert.ok(!s.includes('hunter22'))
  assert.ok(!s.includes('12345')); assert.ok(!s.includes('13800138000')); assert.ok(!/138 0013/.test(s))
  assert.match(TgS.redact('连接 Telegram：直连'), /直连/) // 普通内容不动
})

// ------------------------------------------------------------------ fake client

class FakeApi {}
FakeApi.PeerChannel = class { constructor(o) { Object.assign(this, o, { className: 'PeerChannel' }) } }
FakeApi.messages = { GetDiscussionMessage: class { constructor(o) { Object.assign(this, o, { className: 'messages.GetDiscussionMessage' }) } } }

/** chats: { key → entity }；msgs: { chatKey → { id → message } } */
function fakeClient({ chats, msgs, dialogsReveal = {}, discussion = null, failGet = null, chunk = 4096, delay = 0 }) {
  const known = { ...chats }
  const calls = { dialogs: 0, downloads: 0 }
  const key = e => (typeof e === 'string' ? e : e.className === 'PeerChannel' ? 'c' + String(e.channelId) : e._key)
  const client = {
    calls,
    async getEntity(e) {
      const k = key(e)
      if (!known[k]) { const err = new Error('Could not find the input entity for ' + k); throw err }
      return known[k]
    },
    async getDialogs() { calls.dialogs++; Object.assign(known, dialogsReveal) },
    async getMessages(chat, { ids }) {
      if (failGet) throw failGet
      const box = msgs[chat._key] || {}
      return ids.map(i => box[i] || { className: 'MessageEmpty', id: i })
    },
    async invoke(req) {
      if (req.className === 'messages.GetDiscussionMessage') return discussion
      throw new Error('unexpected ' + req.className)
    },
    async downloadMedia(media, { outputFile, progressCallback, thumb } = {}) {
      if (thumb !== undefined) return Buffer.from('JPEGTHUMB')
      calls.downloads++
      const size = media.className === 'Document' ? media.size : (media.media?.document?.size || 50_000)
      let done = 0
      while (done < size) {
        if (delay) await new Promise(r => setTimeout(r, delay))
        const n = Math.min(chunk, size - done)
        await outputFile.write(Buffer.alloc(n, 1))
        done += n
        if (progressCallback) await progressCallback(done, size)
      }
    },
  }
  return client
}

const chan = (k, extra = {}) => ({ className: 'Channel', id: k.replace(/\D/g, '') || '1', _key: k, title: '测试频道', username: /^c\d/.test(k) ? undefined : k, ...extra })

test('TelegramService.resolve：公开频道单个视频 / 相册 / ?single', async () => {
  const ch = chan('pubchan')
  const box = {
    5: msg(5, { className: 'MessageMediaDocument', document: vdoc(1, 30000), altDocuments: [vdoc(2, 60000)] }, { message: '视频标题\n第二行' }),
    20: msg(20, photo(1), { groupedId: 9, message: '相册说明' }),
    21: msg(21, { className: 'MessageMediaDocument', document: vdoc(3, 40000) }, { groupedId: 9 }),
    22: msg(22, photo(2), { groupedId: 9 }),
    23: msg(23, photo(3), { groupedId: 10 }),
  }
  const client = fakeClient({ chats: { pubchan: ch }, msgs: { pubchan: box } })
  const svc = new TelegramService({ getClient: async () => client, Api: FakeApi })
  let p = await svc.resolve(TgS.parseLink('https://t.me/pubchan/5'))
  assert.equal(p.engine, 'telegram'); assert.equal(p.platform, 'TELEGRAM'); assert.equal(p.id, 'pubchan_5')
  assert.equal(p.title, '视频标题'); assert.equal(p.author, '测试频道'); assert.equal(p.isImages, false)
  assert.equal(p.tg.items.length, 1); assert.equal(p.tg.items[0].alt, 0); assert.equal(p.tg.items[0].size, 60000)
  assert.equal(p.durationMs, 12500); assert.equal(p.height, 720)
  assert.match(p.cover, /^data:image\/jpeg;base64,/)
  assert.deepEqual(p.tg.chat, { kind: 'username', username: 'pubchan', channelId: String(ch.id) })
  p = await svc.resolve(TgS.parseLink('https://t.me/pubchan/21'))
  assert.deepEqual(p.tg.msgIds, [20, 21, 22]); assert.equal(p.tg.items.length, 3); assert.equal(p.desc, '相册说明')
  assert.equal(p.tg.summary, '相册：2 张图片 + 1 个视频'); assert.equal(p.entries, 3)
  p = await svc.resolve(TgS.parseLink('https://t.me/pubchan/21?single'))
  assert.deepEqual(p.tg.msgIds, [21])
  p = await svc.resolve(TgS.parseLink('https://t.me/pubchan/22?single'))
  assert.equal(p.isImages, true); assert.equal(p.images.length, 1)
})

test('TelegramService.resolve：禁止保存 / 已删除 / 无媒体 / 限流 / 无权限', async () => {
  const prot = chan('protchan', { noforwards: true })
  const normal = chan('normal')
  const client = fakeClient({
    chats: { protchan: prot, normal },
    msgs: { protchan: { 1: msg(1, photo(1)) }, normal: { 2: msg(2, photo(1), { noforwards: true }), 3: msg(3, null, { message: '纯文字' }) } },
  })
  const svc = new TelegramService({ getClient: async () => client, Api: FakeApi })
  await assert.rejects(svc.resolve(TgS.parseLink('https://t.me/protchan/1')), e => e.message === '该频道/聊天禁止保存内容，拾影不下载这类内容' && e instanceof UserError)
  await assert.rejects(svc.resolve(TgS.parseLink('https://t.me/normal/2')), /禁止保存内容/)
  await assert.rejects(svc.resolve(TgS.parseLink('https://t.me/normal/99')), e => e.tgKind === 'deleted')
  await assert.rejects(svc.resolve(TgS.parseLink('https://t.me/normal/3')), /只有文字/)
  const flood = fakeClient({ chats: { normal }, msgs: {}, failGet: Object.assign(new Error('A wait of 33 seconds is required'), { errorMessage: 'FLOOD', seconds: 33 }) })
  const svc2 = new TelegramService({ getClient: async () => flood, Api: FakeApi })
  await assert.rejects(svc2.resolve(TgS.parseLink('https://t.me/normal/1')), e => e.tgKind === 'flood' && /33 秒/.test(e.message))
  const priv = fakeClient({ chats: { normal }, msgs: {}, failGet: Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' }) })
  await assert.rejects(new TelegramService({ getClient: async () => priv, Api: FakeApi }).resolve(TgS.parseLink('https://t.me/normal/1')), e => e.tgKind === 'no_access')
})

test('TelegramService.resolve：t.me/c 私密频道先读对话列表；不在频道里 → 没有权限', async () => {
  const pc = chan('c1234567890', { title: '私密频道' })
  const client = fakeClient({ chats: {}, dialogsReveal: { c1234567890: pc }, msgs: { c1234567890: { 55: msg(55, photo(1)) } } })
  const logs = []
  const svc = new TelegramService({ getClient: async () => client, Api: FakeApi, bigInt: s => s })
  const p = await svc.resolve(TgS.parseLink('https://t.me/c/1234567890/55'), { log: s => logs.push(s) })
  assert.equal(client.calls.dialogs, 1); assert.equal(p.id, 'c1234567890_55'); assert.equal(p.author, '私密频道')
  assert.ok(logs.some(s => /对话列表/.test(s)))
  const c2 = fakeClient({ chats: {}, msgs: {} })
  await assert.rejects(new TelegramService({ getClient: async () => c2, Api: FakeApi }).resolve(TgS.parseLink('https://t.me/c/42/1')), e => e.tgKind === 'no_access' && /不在里面/.test(e.message))
})

test('TelegramService.resolve：评论（?comment=）到讨论组里取', async () => {
  const ch = chan('newschan')
  const group = chan('c999', { title: '讨论组' })
  const client = fakeClient({
    chats: { newschan: ch }, msgs: { c999: { 3001: msg(3001, { className: 'MessageMediaDocument', document: vdoc(8, 7000) }, { message: '评论里的视频' }) } },
    discussion: { messages: [{ id: 500, peerId: { channelId: '999' } }], chats: [group] },
  })
  const p = await new TelegramService({ getClient: async () => client, Api: FakeApi }).resolve(TgS.parseLink('https://t.me/newschan/100?comment=3001'))
  assert.equal(p.title, '评论里的视频'); assert.deepEqual(p.tg.chat, { kind: 'channel', channelId: '999' }); assert.deepEqual(p.tg.msgIds, [3001])
  const protGroup = fakeClient({ chats: { newschan: ch }, msgs: {}, discussion: { messages: [{ id: 1, peerId: { channelId: '999' } }], chats: [chan('c999', { noforwards: true })] } })
  await assert.rejects(new TelegramService({ getClient: async () => protGroup, Api: FakeApi }).resolve(TgS.parseLink('https://t.me/newschan/100?comment=1')), /禁止保存内容/)
})

test('TelegramService.download：单个视频、相册文件夹、进度', async () => {
  const dir = tmpDir()
  const ch = chan('dlchan')
  const box = {
    5: msg(5, { className: 'MessageMediaDocument', document: vdoc(1, 30000), altDocuments: [vdoc(2, 60000)] }, { message: '我的视频' }),
    20: msg(20, photo(1), { groupedId: 9, message: '相册' }),
    21: msg(21, { className: 'MessageMediaDocument', document: vdoc(3, 40000) }, { groupedId: 9 }),
  }
  const client = fakeClient({ chats: { dlchan: ch }, msgs: { dlchan: box } })
  const svc = new TelegramService({ getClient: async () => client, Api: FakeApi })
  let post = await svc.resolve(TgS.parseLink('https://t.me/dlchan/5'))
  post = JSON.parse(JSON.stringify(post)) // 经过 IPC
  const prog = []
  let files = await svc.download(post, dir, { onProgress: x => prog.push(x) })
  assert.equal(files.length, 1)
  assert.equal(path.basename(files[0]), '测试频道-我的视频-dlchan_5.mp4')
  assert.equal(fs.statSync(files[0]).size, 60000) // 下的是最大的 altDocument
  assert.ok(prog.length >= 1 && prog[prog.length - 1].pct === 100)
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.part')))
  post = JSON.parse(JSON.stringify(await svc.resolve(TgS.parseLink('https://t.me/dlchan/20'))))
  files = await svc.download(post, dir, {})
  assert.equal(files.length, 3)
  assert.ok(fs.statSync(files[0]).isDirectory())
  assert.deepEqual(files.slice(1).map(f => path.basename(f)), ['01.jpg', '02.mp4'])
  assert.equal(path.basename(files[0]), '测试频道-相册-dlchan_20')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('TelegramService.download：取消会删掉已写的文件；下载前发现禁止保存就停', async () => {
  const dir = tmpDir()
  const ch = chan('slow')
  const box = { 1: msg(1, { className: 'MessageMediaDocument', document: vdoc(1, 400000) }, { groupedId: 3 }), 2: msg(2, { className: 'MessageMediaDocument', document: vdoc(2, 400000) }, { groupedId: 3 }) }
  const client = fakeClient({ chats: { slow: ch }, msgs: { slow: box }, chunk: 4096, delay: 5 })
  const svc = new TelegramService({ getClient: async () => client, Api: FakeApi })
  const post = JSON.parse(JSON.stringify(await svc.resolve(TgS.parseLink('https://t.me/slow/1'))))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 150)
  await assert.rejects(svc.download(post, dir, { signal: ctrl.signal }), e => e instanceof Cancelled)
  clearTimeout(t)
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(fs.readdirSync(dir), [])
  // 解析后频道改成禁止保存
  box[1].noforwards = true
  await assert.rejects(svc.download(post, dir, {}), /禁止保存内容/)
  assert.deepEqual(fs.readdirSync(dir), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ route

test('Extractor.route Telegram：没登录公开频道走 yt-dlp；私密要登录；登录后原生', async () => {
  let r = await Extractor.route('https://t.me/durov/123?single', () => {}, { telegram: { loggedIn: () => false } })
  assert.equal(r.type, 'ytdlp'); assert.equal(r.url, 'https://t.me/durov/123?single'); assert.equal(r.telegramFallback, true)
  r = await Extractor.route('https://telegram.me/durov/5/123', () => {}, {})
  assert.equal(r.url, 'https://t.me/durov/123')
  await assert.rejects(Extractor.route('https://t.me/c/123/4', () => {}, { telegram: { loggedIn: () => false } }), /需要先登录 Telegram/)
  await assert.rejects(Extractor.route('https://t.me/chan/4?comment=5', () => {}, {}), /需要先登录 Telegram/)
  await assert.rejects(Extractor.route('https://t.me/+invite', () => {}, {}), /邀请链接/)
  r = await Extractor.route('https://t.me/c/123/4', () => {}, { telegram: { loggedIn: async () => true, resolve: async l => ({ id: 'x', link: l }) } })
  assert.equal(r.type, 'native'); assert.equal(r.post.link.channelId, '123')
})

// ------------------------------------------------------------------ account / login flow

const fakeSecure = (available = true) => ({
  available: () => available,
  encrypt: s => Buffer.from('ENC:' + Buffer.from(s).toString('base64')),
  decrypt: b => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return Buffer.from(t.slice(4), 'base64').toString() },
})

function fakeLib(opts = {}) {
  const state = { created: [], signInCodes: [], passwords: [], loggedOut: 0 }
  class StringSession { constructor(s) { this.s = s } save() { return this.s || '1SESSION' + 'Q'.repeat(200) } }
  class TelegramClient {
    constructor(session, apiId, apiHash, params) { this.session = session; this.apiId = apiId; this.apiHash = apiHash; this.params = params; this.connected = false; state.created.push(this) }
    async connect() { if (opts.connectFail) throw new Error('connect ECONNREFUSED 1.2.3.4:443'); this.connected = true }
    async destroy() { this.connected = false }
    async checkAuthorization() { return !opts.unauthorized }
    async sendCode(api, phone) { state.phone = phone; if (opts.badApi) throw Object.assign(new Error('API_ID_INVALID'), { errorMessage: 'API_ID_INVALID' }); return { phoneCodeHash: 'hash1', isCodeViaApp: true } }
    async invoke(req) {
      if (req.className === 'auth.SignIn') {
        state.signInCodes.push(req.phoneCode)
        if (req.phoneCode !== '12345') throw Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' })
        if (opts.twoFa) throw Object.assign(new Error('SESSION_PASSWORD_NEEDED'), { errorMessage: 'SESSION_PASSWORD_NEEDED' })
        return { className: 'auth.Authorization' }
      }
      if (req.className === 'account.GetPassword') return { hint: '小狗名字' }
      if (req.className === 'auth.LogOut') { state.loggedOut++; return true }
      throw new Error('unexpected ' + req.className)
    }
    async signInWithPassword(api, { password, onError }) {
      const pw = await password()
      state.passwords.push(pw)
      if (pw !== 'right-pw') await onError(Object.assign(new Error('PASSWORD_HASH_INVALID'), { errorMessage: 'PASSWORD_HASH_INVALID' }))
      return { id: 1 }
    }
    async getMe() { return { firstName: 'Luke', lastName: '', username: 'luke_t' } }
  }
  const req = n => class { constructor(o) { Object.assign(this, o, { className: n }) } }
  const Api = { auth: { SignIn: req('auth.SignIn'), LogOut: req('auth.LogOut') }, account: { GetPassword: req('account.GetPassword') } }
  class Logger { constructor(l) { this.l = l } }
  return { lib: { TelegramClient, StringSession, Api, Logger }, state }
}

test('TelegramAccount 登录：验证码 → 两步验证 → 保存加密会话 → 退出', async () => {
  const dir = tmpDir()
  const { lib, state } = fakeLib({ twoFa: true })
  const acc = new TelegramAccount({ dir, secure: fakeSecure(), lib: () => lib, systemProxy: async () => 'DIRECT', env: {} })
  assert.equal(acc.status().loggedIn, false)
  await assert.rejects(acc.sendCode({ apiId: 'abc', apiHash: 'x', phone: '1' }), e => e.tgKind === 'auth_api')
  let r = await acc.sendCode({ apiId: '1234567', apiHash: '0123456789ABCDEF0123456789abcdef', phone: '138 0013 8000', proxy: 'socks5://127.0.0.1:7890' })
  assert.deepEqual(r, { step: 'code', viaApp: true })
  assert.equal(state.phone, '+8613800138000')
  assert.equal(state.created[0].params.proxy.port, 7890) // 用了设置的代理
  assert.equal(state.created[0].params.deviceModel, '拾影 PC')
  await assert.rejects(acc.signIn('99999'), e => e.tgKind === 'auth_code')
  r = await acc.signIn('12-345')
  assert.deepEqual(r, { step: 'password', hint: '小狗名字' })
  await assert.rejects(acc.password('wrong'), e => e.tgKind === 'auth_password')
  r = await acc.password('right-pw')
  assert.equal(r.step, 'done'); assert.equal(r.name, 'Luke'); assert.equal(r.saved, true)
  const st = acc.status()
  assert.equal(st.loggedIn, true); assert.equal(st.username, 'luke_t'); assert.equal(st.apiId, '1234567')
  // 文件是加密的，里面没有明文 session / api_hash / 手机号
  for (const f of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8')
    assert.ok(raw.startsWith('ENC:'), f); assert.ok(!raw.includes('SESSION') && !raw.includes('0123456789abcdef') && !raw.includes('13800138000'))
  }
  const cfg = JSON.parse(fakeSecure().decrypt(fs.readFileSync(path.join(dir, 'config.bin'))))
  assert.equal(cfg.phone, undefined) // 不保存手机号
  // 诊断日志：没有 api_hash、手机号、验证码、密码、session
  const d = acc.diagText()
  for (const s of ['0123456789abcdef', '13800138000', '12345', 'right-pw', 'wrong', 'QQQQQQQQ']) assert.ok(!d.toLowerCase().includes(s.toLowerCase()), s)
  // 重新打开（模拟重启）：从加密文件读回会话
  const acc2 = new TelegramAccount({ dir, secure: fakeSecure(), lib: () => lib, systemProxy: async () => 'DIRECT', env: {} })
  assert.equal(acc2.loggedIn(), true)
  const c = await acc2.getClient()
  assert.equal(c.session.s, '1SESSION' + 'Q'.repeat(200))
  r = await acc2.logout()
  assert.equal(r.remote, true); assert.equal(state.loggedOut, 1)
  assert.equal(acc2.loggedIn(), false); assert.ok(!fs.existsSync(path.join(dir, 'session.bin')))
  assert.equal(acc2.status().apiIdSet, true) // api_id 保留
  fs.rmSync(dir, { recursive: true, force: true })
})

test('TelegramAccount：连不上给中文提示；会话失效自动清除；不能加密时不写文件', async () => {
  const dir = tmpDir()
  let { lib } = fakeLib({ connectFail: true })
  let acc = new TelegramAccount({ dir, secure: fakeSecure(), lib: () => lib, systemProxy: async () => 'PROXY 127.0.0.1:7890', env: {} })
  await assert.rejects(acc.sendCode({ apiId: '1', apiHash: '0'.repeat(32), phone: '+447700900123' }).catch(e => { throw e }), e => e.tgKind === 'auth_api' || e.tgKind === 'net')
  await assert.rejects(acc.sendCode({ apiId: '1234', apiHash: '0'.repeat(32), phone: '+447700900123' }), e => e.tgKind === 'net' && /试过：系统代理端口 127\.0\.0\.1:7890.*直连/.test(e.message) && /SOCKS5/.test(e.message))
  ;({ lib } = fakeLib({ unauthorized: true }))
  fs.writeFileSync(path.join(dir, 'session.bin'), fakeSecure().encrypt('1OLD'))
  acc = new TelegramAccount({ dir, secure: fakeSecure(), lib: () => lib, systemProxy: async () => 'DIRECT', env: {} })
  assert.equal(acc.loggedIn(), true)
  await assert.rejects(acc.getClient(), e => e.tgKind === 'session' && /重新登录/.test(e.message))
  assert.equal(acc.loggedIn(), false)
  const dir2 = tmpDir()
  ;({ lib } = fakeLib())
  acc = new TelegramAccount({ dir: dir2, secure: fakeSecure(false), lib: () => lib, systemProxy: async () => 'DIRECT', env: {} })
  await acc.sendCode({ apiId: '1234', apiHash: '0'.repeat(32), phone: '+447700900123' })
  const r = await acc.signIn('12345')
  assert.equal(r.saved, false); assert.equal(acc.loggedIn(), true); assert.deepEqual(fs.readdirSync(dir2), [])
  await assert.rejects(acc.setProxy('http://127.0.0.1:7890'), e => /HTTP/.test(e.message))
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true })
})

test('Telegram 手机号 / api 校验', () => {
  assert.equal(normalizePhone('13800138000'), '+8613800138000')
  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100')
  assert.equal(normalizePhone('0044 7700 900123'), '+447700900123')
  assert.throws(() => normalizePhone('abc'), /手机号/)
  assert.deepEqual(checkApi(' 1234 ', 'ABCDEF0123456789abcdef0123456789'), { apiId: 1234, apiHash: 'abcdef0123456789abcdef0123456789' })
  assert.throws(() => checkApi('12a', '0'.repeat(32)), /api_id/)
  assert.throws(() => checkApi('123', '0'.repeat(31)), /api_hash/)
})
