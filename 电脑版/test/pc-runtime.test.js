'use strict'
// 电脑版新增部分：下载（取消 / 回滚 / 校验）、进度解析、SHA2-256SUMS、cookie jar、下载记录、封面 Referer（V21Test.thumbReferers）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const D = require('../src/core/downloader')
const Net = require('../src/core/net')
const { parseProgress } = require('../src/core/engine')
const { parseSums, downloadTo, cmpVer } = require('../src/core/tools')
const { History } = require('../src/core/store')
const { refererFor } = require('../src/core/thumbs')
const { Platform } = require('../src/core/platform')
const { makePost, Cancelled, UserError } = require('../src/core/post')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-test-'))

/** 本地 HTTP 服务器：/mp4（2 MB 慢速）/html /small.mp4 /img */
function server() {
  const mp4 = Buffer.alloc(2 * 1024 * 1024, 7); mp4.write('ftyp', 4, 'latin1')
  const s = http.createServer((req, res) => {
    if (req.url === '/mp4' || req.url === '/slow.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length })
      let i = 0
      const step = () => { if (i >= mp4.length) return res.end(); res.write(mp4.subarray(i, i + 65536)); i += 65536; setTimeout(step, req.url === '/slow.mp4' ? 30 : 0) }
      step()
    } else if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>error</html>') }
    else if (req.url === '/notmp4') { const b = Buffer.alloc(50000, 1); res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': b.length }); res.end(b) }
    else if (req.url === '/img') { const b = Buffer.concat([Buffer.from('RIFF0000WEBP'), Buffer.alloc(1000)]); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length }); res.end(b) }
    else { res.writeHead(404); res.end() }
  })
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}` })))
}

Net.setProxy(null) // 本地测试不走代理

test('fetchOne: skips bad candidates, saves mp4, never overwrites', async () => {
  const { s, base } = await server()
  try {
    const dir = tmp()
    let last = 0
    const f = await D.fetchOne([`${base}/html`, `${base}/notmp4`, `${base}/404`, `${base}/mp4`], {}, true, path.join(dir, '作者-标题-1'), { onProgress: d => { last = d } })
    assert.equal(path.basename(f), '作者-标题-1.mp4')
    assert.equal(fs.statSync(f).size, 2 * 1024 * 1024)
    assert.equal(last, 2 * 1024 * 1024)
    const g = await D.fetchOne([`${base}/mp4`], {}, true, path.join(dir, '作者-标题-1'))
    assert.equal(path.basename(g), '作者-标题-1 (2).mp4')
    await assert.rejects(D.fetchOne([`${base}/html`], {}, true, path.join(dir, 'x')), UserError)
    const img = await D.fetchOne([`${base}/img`], {}, false, path.join(dir, '01'))
    assert.equal(path.extname(img), '.webp') // 按内容识别扩展名
  } finally { s.close() }
})

test('fetchOne: cancel stops at once and leaves no partial file', async () => {
  const { s, base } = await server()
  try {
    const dir = tmp()
    const ctrl = new AbortController()
    const p = D.fetchOne([`${base}/slow.mp4`], {}, true, path.join(dir, 'v'), { signal: ctrl.signal, onProgress: d => { if (d > 300_000) ctrl.abort() } })
    await assert.rejects(p, Cancelled)
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally { s.close() }
})

test('downloadNative: atlas into its own folder; cancel rolls back everything', async () => {
  const { s, base } = await server()
  try {
    const dir = tmp()
    const post = makePost({ id: '5', isImages: true, author: '作者', desc: '图集标题', images: [{ urls: [`${base}/img`], liveVideoUrls: [`${base}/mp4`] }, { urls: [`${base}/img`], liveVideoUrls: [] }], platform: Platform.DOUYIN })
    const files = await D.downloadNative(post, dir, '1080', {})
    const folder = path.join(dir, '作者-图集标题-5')
    assert.equal(files[0], folder)
    assert.deepEqual(fs.readdirSync(folder).sort(), ['01-实况.mp4', '01.webp', '02.webp'])
    const ctrl = new AbortController()
    const big = makePost({ ...post, id: '6', images: [{ urls: [`${base}/img`], liveVideoUrls: [] }, { urls: [`${base}/slow.mp4`], liveVideoUrls: [] }] })
    let seen = 0
    await assert.rejects(D.downloadNative(big, dir, '1080', { signal: ctrl.signal, onProgress: x => { if (++seen > 5) ctrl.abort() } }), Cancelled)
    assert.ok(!fs.existsSync(path.join(dir, '作者-图集标题-6')))
  } finally { s.close() }
})

test('moveYtdlpFiles names files 作者-标题-ID', () => {
  const dir = tmp(), t = path.join(dir, 't'), out = path.join(dir, 'o')
  fs.mkdirSync(t); fs.mkdirSync(out)
  fs.writeFileSync(path.join(t, '001-a.mp4'), 'x'); fs.writeFileSync(path.join(t, '002-b.mp4'), 'y')
  const post = makePost({ id: 'BV1x', author: 'up主', desc: '标题', platform: Platform.BILIBILI })
  const files = D.moveYtdlpFiles([path.join(t, '001-a.mp4'), path.join(t, '002-b.mp4')], post, out)
  assert.deepEqual(files.map(f => path.basename(f)), ['up主-标题-BV1x-01.mp4', 'up主-标题-BV1x-02.mp4'])
})

test('yt-dlp progress lines', () => {
  assert.deepEqual(parseProgress('[shiying-progress]  45.3%|   2.10MiB/s|00:12|1234|5678|NA'), { pct: 45.3, speed: '2.10MiB/s', eta: '00:12', done: 1234, total: 5678 })
  assert.equal(parseProgress('[shiying-progress] 100.0%|NA|NA|99|NA|120.5').total, 120.5)
  assert.equal(parseProgress('[download]  12.5% of 10.00MiB at 1.00MiB/s ETA 00:09').pct, 12.5)
  assert.equal(parseProgress('[Merger] Merging formats into "x.mp4"'), null)
})

test('SHA2-256SUMS parsing and version compare', () => {
  const sums = 'aa'.repeat(32) + '  yt-dlp\n' + 'bb'.repeat(32) + '  yt-dlp.exe\n' + 'cc'.repeat(32) + '  yt-dlp_linux_aarch64\n'
  assert.equal(parseSums(sums, 'yt-dlp.exe'), 'bb'.repeat(32))
  assert.equal(parseSums(sums, 'yt-dlp_macos'), null)
  assert.ok(cmpVer('v2.10.0', 'v2.9.8') > 0)
})

test('downloadTo verifies sha256 and size', async () => {
  const { s, base } = await server()
  try {
    const dir = tmp()
    await assert.rejects(downloadTo(`${base}/mp4`, path.join(dir, 'f'), { sha256: '00'.repeat(32) }), /校验失败/)
    assert.deepEqual(fs.readdirSync(dir), [])
    await assert.rejects(downloadTo(`${base}/mp4`, path.join(dir, 'f'), { minSize: 10_000_000 }), /太小/)
    await downloadTo(`${base}/mp4`, path.join(dir, 'f'))
    assert.equal(fs.statSync(path.join(dir, 'f')).size, 2 * 1024 * 1024)
  } finally { s.close() }
})

test('cookie jar: domain / host-only / expiry', () => {
  const j = new Net.CookieJar()
  j.setFromHeader('https://www.iesdouyin.com/share/video/1/', 'ttwid=abc; Domain=.iesdouyin.com; Path=/; Max-Age=3600')
  j.setFromHeader('https://www.iesdouyin.com/', 'host=1; Path=/')
  j.setFromHeader('https://www.iesdouyin.com/', 'gone=1; Max-Age=0')
  assert.equal(j.header('https://m.iesdouyin.com/x'), 'ttwid=abc')
  assert.equal(j.header('https://www.iesdouyin.com/x'), 'ttwid=abc; host=1')
  assert.equal(j.header('https://example.com/'), '')
})

test('history: newest first, max 200, stale running → failed', () => {
  const f = path.join(tmp(), 'h.json')
  const dropped = []
  const h = new History(f, { onDrop: e => dropped.push(e.key) })
  for (let i = 0; i < 202; i++) h.put({ key: 'k' + i, status: i === 201 ? 'running' : 'done', files: [] })
  assert.equal(h.all().length, 200)
  assert.equal(h.all()[0].key, 'k201')
  assert.deepEqual(dropped, ['k0', 'k1'])
  const h2 = new History(f)
  h2.fixStale()
  assert.equal(h2.get('k201').status, 'failed')
  assert.equal(h2.get('k201').message, '下载被中断')
})

test('thumbnail referers (V21Test.thumbReferers)', () => {
  assert.equal(refererFor('https://wx3.sinaimg.cn/orj480/abc.jpg', Platform.WEIBO, null), 'https://weibo.com/')
  assert.equal(refererFor('https://i0.hdslb.com/bfs/archive/x.jpg', Platform.BILIBILI, null), 'https://www.bilibili.com/')
  assert.equal(refererFor('https://p3-sign.douyinpic.com/x~tplv.jpeg', Platform.DOUYIN, null), 'https://www.douyin.com/')
  assert.equal(refererFor('https://i.ytimg.com/vi/x/hq720.jpg', Platform.YOUTUBE, null), null)
  assert.equal(refererFor('https://cdn.example.com/x.jpg', Platform.WEIBO, null), 'https://weibo.com/')
})
