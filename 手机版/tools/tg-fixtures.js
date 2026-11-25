// Generates app/src/test/resources/tg/gramjs-fixtures.json: TL bytes / crypto results computed by GramJS (MIT, layer 198),
// which TgMtprotoTest compares with 拾影's own Kotlin MTProto code. Dev-only (needs the PC repo's node_modules):
//   node tools/tg-fixtures.js /workspace/shiying-pc/node_modules/telegram
const path = require('path')
const fs = require('fs')
const root = process.argv[2] || '/workspace/shiying-pc/node_modules/telegram'
const { Api } = require(path.join(root, 'tl'))
const { IGE } = require(path.join(root, 'crypto/IGE'))
const Helpers = require(path.join(root, 'Helpers'))
const Password = require(path.join(root, 'Password'))
const bigInt = require(require.resolve('big-integer', { paths: [root] }))
const L = s => bigInt(s)
const hex = b => Buffer.from(b).toString('hex')
const B = (s) => Buffer.from(s, 'hex')

const fx = { objects: {}, requests: {}, ige: null, srp: null }

// ---------------------------------------------------------------- objects the app parses
const photo = new Api.Photo({ id: L('5001'), accessHash: L('-77'), fileReference: B('0102030405'), date: 1700000000, dcId: 4,
  sizes: [
    new Api.PhotoStrippedSize({ type: 'i', bytes: B('010203') }),
    new Api.PhotoSize({ type: 'm', w: 320, h: 180, size: 9000 }),
    new Api.PhotoSize({ type: 'x', w: 800, h: 450, size: 40000 }),
    new Api.PhotoSizeProgressive({ type: 'y', w: 1280, h: 720, sizes: [10000, 30000, 81234] }),
  ] })
const vattr = (w, h, d) => new Api.DocumentAttributeVideo({ w, h, duration: d, supportsStreaming: true })
const doc = (id, size, attrs, mime = 'video/mp4') => new Api.Document({ id: L(String(id)), accessHash: L('123456789012345'), fileReference: B('aabb'), date: 1700000001,
  mimeType: mime, size: L(String(size)), dcId: 5, attributes: attrs,
  thumbs: [new Api.PhotoSize({ type: 'm', w: 320, h: 180, size: 7000 })] })
const peer = new Api.PeerChannel({ channelId: L('1987654321') })
const msgPhoto = new Api.Message({ id: 10, peerId: peer, date: 1700000002, message: '图集 #测试', groupedId: L('777'), media: new Api.MessageMediaPhoto({ photo }) })
const msgVideo = new Api.Message({ id: 11, peerId: peer, date: 1700000003, message: '', groupedId: L('777'), noforwards: false,
  media: new Api.MessageMediaDocument({ video: true, document: doc(6001, 1000000, [vattr(640, 360, 12.5), new Api.DocumentAttributeFilename({ fileName: 'a.mp4' })]),
    altDocuments: [doc(6002, 5000000, [vattr(1920, 1080, 12.5)]), doc(6003, 300000, [vattr(320, 180, 12.5)])] }) })
const msgGif = new Api.Message({ id: 12, peerId: peer, date: 1700000004, message: 'gif',
  media: new Api.MessageMediaDocument({ document: doc(6004, 200000, [vattr(480, 270, 3), new Api.DocumentAttributeAnimated()]) }) })
const msgImageFile = new Api.Message({ id: 13, peerId: peer, date: 1700000005, message: 'png 原图',
  media: new Api.MessageMediaDocument({ document: doc(6005, 2500000, [new Api.DocumentAttributeImageSize({ w: 4000, h: 3000 }), new Api.DocumentAttributeFilename({ fileName: 'x.png' })], 'image/png') }) })
const msgSticker = new Api.Message({ id: 14, peerId: peer, date: 1700000006, message: '',
  media: new Api.MessageMediaDocument({ document: doc(6006, 20000, [new Api.DocumentAttributeSticker({ alt: '😀', stickerset: new Api.InputStickerSetEmpty() })], 'image/webp') }) })
const msgProtected = new Api.Message({ id: 15, peerId: peer, date: 1700000007, message: '受保护', noforwards: true, media: new Api.MessageMediaPhoto({ photo }) })
const msgText = new Api.Message({ id: 16, peerId: peer, date: 1700000008, message: '只有文字' })
const channel = new Api.Channel({ id: L('1987654321'), accessHash: L('-5555555555555'), title: '测试频道', username: 'shiying_test', photo: new Api.ChatPhotoEmpty(),
  date: 1600000000, broadcast: true, noforwards: true })
const channelMessages = new Api.messages.ChannelMessages({ pts: 1, count: 3, messages: [msgPhoto, msgVideo, new Api.MessageEmpty({ id: 17 })], topics: [], chats: [channel], users: [] })
fx.objects.channelMessages = hex(channelMessages.getBytes())
fx.objects.messages = { photo: hex(msgPhoto.getBytes()), video: hex(msgVideo.getBytes()), gif: hex(msgGif.getBytes()), imageFile: hex(msgImageFile.getBytes()),
  sticker: hex(msgSticker.getBytes()), protected: hex(msgProtected.getBytes()), text: hex(msgText.getBytes()) }
fx.objects.resolvedPeer = hex(new Api.contacts.ResolvedPeer({ peer, chats: [channel], users: [] }).getBytes())
fx.objects.uploadFile = hex(new Api.upload.File({ type: new Api.storage.FileMp4(), mtime: 0, bytes: B('00000018667479706d703432') }).getBytes())

// ---------------------------------------------------------------- requests the app sends
fx.requests.sendCode = hex(new Api.auth.SendCode({ phoneNumber: '+8613800138000', apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', settings: new Api.CodeSettings({}) }).getBytes())
fx.requests.signIn = hex(new Api.auth.SignIn({ phoneNumber: '+8613800138000', phoneCodeHash: 'abc123', phoneCode: '12345' }).getBytes())
fx.requests.getFile = hex(new Api.upload.GetFile({ location: new Api.InputDocumentFileLocation({ id: L('6002'), accessHash: L('123456789012345'), fileReference: B('aabb'), thumbSize: '' }), offset: L('1048576'), limit: 524288 }).getBytes())
fx.requests.getPhoto = hex(new Api.upload.GetFile({ location: new Api.InputPhotoFileLocation({ id: L('5001'), accessHash: L('-77'), fileReference: B('0102030405'), thumbSize: 'y' }), offset: L('0'), limit: 524288 }).getBytes())
fx.requests.getMessages = hex(new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: L('1987654321'), accessHash: L('-5555555555555') }), id: [new Api.InputMessageID({ id: 10 }), new Api.InputMessageID({ id: 11 })] }).getBytes())
fx.requests.getDialogs = hex(new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 100, hash: L('0'), folderId: 1 }).getBytes())
fx.requests.discussion = hex(new Api.messages.GetDiscussionMessage({ peer: new Api.InputPeerChannel({ channelId: L('1987654321'), accessHash: L('-5555555555555') }), msgId: 42 }).getBytes())
fx.requests.resolve = hex(new Api.contacts.ResolveUsername({ username: 'shiying_test' }).getBytes())
fx.requests.init = hex(new Api.InvokeWithLayer({ layer: 198, query: new Api.InitConnection({ apiId: 12345, deviceModel: 'Pixel 8', systemVersion: 'Android 14', appVersion: '2.4',
  systemLangCode: 'zh-CN', langPack: '', langCode: 'zh', query: new Api.help.GetConfig() }) }).getBytes())
fx.requests.checkPassword = hex(new Api.auth.CheckPassword({ password: new Api.InputCheckPasswordSRP({ srpId: L('987654321'), A: B('01'.repeat(256)), M1: B('02'.repeat(32)) }) }).getBytes())

// ---------------------------------------------------------------- AES-IGE
const key = B('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const iv = B('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f')
const plain = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) & 255))
fx.ige = { key: hex(key), iv: hex(iv), plain: hex(plain), enc: hex(new IGE(key, iv).encryptIge(plain)) }

;(async () => {
  // ---------------------------------------------------------------- SRP (2FA) with fixed randomness
  const p = B('c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b')
  const salt1 = B('11'.repeat(40)), salt2 = B('22'.repeat(16))
  const pBig = Helpers.readBigIntFromBuffer(p, false)
  const b = Helpers.readBigIntFromBuffer(B('33'.repeat(256)), false)
  const srpB = Helpers.readBufferFromBigInt(Helpers.modExp(bigInt(3), b, pBig), 256, false)
  const aBytes = B('5a'.repeat(256))
  const orig = Helpers.generateRandomBytes
  Helpers.generateRandomBytes = n => (n === 256 ? Buffer.from(aBytes) : orig(n))
  const algo = new Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow({ salt1, salt2, g: 3, p })
  const res = await Password.computeCheck(new Api.account.Password({ currentAlgo: algo, srp_B: srpB, srpId: L('987654321'), hasPassword: true,
    newAlgo: algo, newSecureAlgo: new Api.SecurePasswordKdfAlgoUnknown(), secureRandom: Buffer.alloc(0) }), '测试密码 pw!')
  Helpers.generateRandomBytes = orig
  fx.srp = { salt1: hex(salt1), salt2: hex(salt2), g: 3, p: hex(p), srpB: hex(srpB), srpId: '987654321', password: '测试密码 pw!', a: hex(aBytes), A: hex(res.A), M1: hex(res.M1) }
  const out = path.join(__dirname, '../app/src/test/resources/tg/gramjs-fixtures.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(fx, null, 1))
  console.log('wrote', out)
})()
