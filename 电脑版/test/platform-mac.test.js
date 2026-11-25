'use strict'
// 1.1.1：按系统 / 架构选择组件文件、路径、结束进程树、菜单等（macOS 版新增）。不联网。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawn } = require('child_process')

const T = require('../src/core/tools')
const SP = require('../src/core/sysplat')
const { killTree } = require('../src/core/engine')
require('../src/core/net').setProxy(null) // 本地测试不走代理

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-mac-'))

test('assetNames：macOS / Windows / Linux × arm64 / x64', () => {
  assert.deepStrictEqual(T.assetNames('darwin', 'arm64'), { ytdlp: 'yt-dlp_macos', ffmpeg: 'ffmpeg-darwin-arm64.gz', deno: 'deno-aarch64-apple-darwin.zip' })
  assert.deepStrictEqual(T.assetNames('darwin', 'x64'), { ytdlp: 'yt-dlp_macos', ffmpeg: 'ffmpeg-darwin-x64.gz', deno: 'deno-x86_64-apple-darwin.zip' })
  assert.deepStrictEqual(T.assetNames('win32', 'x64'), { ytdlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg-win32-x64.gz', deno: 'deno-x86_64-pc-windows-msvc.zip' })
  assert.strictEqual(T.assetNames('win32', 'arm64').deno, 'deno-aarch64-pc-windows-msvc.zip')
  assert.strictEqual(T.assetNames('linux', 'arm64').ytdlp, 'yt-dlp_linux_aarch64')
  assert.strictEqual(T.assetNames('linux', 'x64').ffmpeg, 'ffmpeg-linux-x64.gz')
})

test('yt-dlp 来源：macOS 用 universal 的 yt-dlp_macos，nightly → 镜像 → stable，同源 SHA2-256SUMS', () => {
  for (const arch of ['arm64', 'x64']) {
    const s = T.ytdlpSources('nightly', 'darwin', arch)
    assert.strictEqual(s.length, 6)
    for (const x of s) {
      assert.strictEqual(x.asset, 'yt-dlp_macos')
      assert.ok(x.url.endsWith('/releases/latest/download/yt-dlp_macos'), x.url)
      assert.strictEqual(x.sums, x.url.replace(/yt-dlp_macos$/, 'SHA2-256SUMS'))
    }
    assert.ok(s[0].url.startsWith('https://github.com/yt-dlp/yt-dlp-nightly-builds/'))
    assert.ok(s[1].url.startsWith('https://ghfast.top/https://github.com/'))
    assert.ok(s[2].url.startsWith('https://gh-proxy.com/https://github.com/'))
    assert.ok(s[3].url.startsWith('https://github.com/yt-dlp/yt-dlp/'))
  }
  assert.strictEqual(T.ytdlpSources('stable', 'darwin', 'arm64').length, 3)
  assert.strictEqual(T.parseSums('aa'.repeat(32) + '  yt-dlp_macos\n' + 'bb'.repeat(32) + '  yt-dlp_macos.zip\n', 'yt-dlp_macos'), 'aa'.repeat(32))
})

test('ffmpeg 来源：macOS arm64 / x64 各自的静态版，三个镜像，固定 sha256', () => {
  for (const [arch, asset] of [['arm64', 'ffmpeg-darwin-arm64.gz'], ['x64', 'ffmpeg-darwin-x64.gz']]) {
    const s = T.ffmpegSources('darwin', arch)
    assert.deepStrictEqual(s.map(x => x.name), ['GitHub', 'npmmirror', 'ghfast.top'])
    for (const x of s) {
      assert.ok(x.url.endsWith('/b6.1.1/' + asset), x.url)
      assert.match(x.sha256, /^[0-9a-f]{64}$/)
      assert.strictEqual(x.sha256, T.FFMPEG_SHA256[asset])
    }
    assert.ok(s[1].url.startsWith('https://registry.npmmirror.com/-/binary/ffmpeg-static/'))
  }
  assert.notStrictEqual(T.ffmpegSources('darwin', 'arm64')[0].sha256, T.ffmpegSources('darwin', 'x64')[0].sha256)
  assert.strictEqual(T.ffmpegSources('win32', 'x64')[0].sha256, T.FFMPEG_SHA256['ffmpeg-win32-x64.gz'])
  for (const v of Object.values(T.FFMPEG_SHA256)) assert.match(v, /^[0-9a-f]{64}$/)
})

test('Deno 来源：aarch64-apple-darwin / x86_64-apple-darwin，带 .sha256sum', () => {
  const a = T.denoSources('v2.9.8', 'darwin', 'arm64')
  assert.deepStrictEqual(a.map(x => x.name), ['dl.deno.land', 'npmmirror', 'GitHub'])
  assert.strictEqual(a[0].url, 'https://dl.deno.land/release/v2.9.8/deno-aarch64-apple-darwin.zip')
  for (const x of a) assert.strictEqual(x.sha, x.url + '.sha256sum')
  assert.ok(T.denoSources('v2.9.8', 'darwin', 'x64').every(x => x.url.endsWith('deno-x86_64-apple-darwin.zip')))
})

test('Tools 路径：macOS 没有 .exe，Windows 有；资产随架构变化', () => {
  const d = tmp()
  const mac = new T.Tools(d, { platform: 'darwin', arch: 'arm64' })
  assert.strictEqual(mac.ytdlpPath, path.join(d, 'yt-dlp'))
  assert.strictEqual(mac.ffmpegPath, path.join(d, 'ffmpeg'))
  assert.strictEqual(mac.denoPath, path.join(d, 'deno'))
  assert.strictEqual(mac.assets().ffmpeg, 'ffmpeg-darwin-arm64.gz')
  assert.strictEqual(new T.Tools(d, { platform: 'darwin', arch: 'x64' }).assets().deno, 'deno-x86_64-apple-darwin.zip')
  const w = new T.Tools(d, { platform: 'win32', arch: 'x64' })
  assert.strictEqual(w.ytdlpPath, path.join(d, 'yt-dlp.exe'))
  assert.strictEqual(w.denoPath, path.join(d, 'deno.exe'))
  assert.strictEqual(SP.binFile('ffmpeg', 'darwin'), 'ffmpeg')
  assert.strictEqual(SP.binFile('ffmpeg', 'win32'), 'ffmpeg.exe')
})

test('makeRunnable：macOS / Linux chmod 755（xattr 只在真 macOS 上运行），Windows 不动', { skip: process.platform === 'win32' }, async () => {
  const d = tmp()
  const f = path.join(d, 'yt-dlp')
  fs.writeFileSync(f, '#!/bin/sh\necho ok\n', { mode: 0o644 })
  await new T.Tools(d, { platform: 'darwin', arch: 'arm64' }).makeRunnable(f)
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o755)
  fs.chmodSync(f, 0o644)
  await new T.Tools(d, { platform: 'win32', arch: 'x64' }).makeRunnable(f)
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644)
})

test('downloadTo：gz 的 sha256 按下载的原始字节校验（解压前），不一致就删掉', async () => {
  const raw = crypto.randomBytes(50_000)
  const gz = zlib.gzipSync(raw)
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-length': gz.length }); r.end(gz) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/ffmpeg-darwin-arm64.gz`
  const d = tmp()
  try {
    const good = crypto.createHash('sha256').update(gz).digest('hex')
    await T.downloadTo(url, path.join(d, 'ffmpeg'), { gunzip: true, sha256: good })
    assert.ok(fs.readFileSync(path.join(d, 'ffmpeg')).equals(raw))
    await assert.rejects(T.downloadTo(url, path.join(d, 'ffmpeg2'), { gunzip: true, sha256: '0'.repeat(64) }), /sha256/)
    assert.ok(!fs.existsSync(path.join(d, 'ffmpeg2')) && !fs.existsSync(path.join(d, 'ffmpeg2.part')))
  } finally { srv.close() }
})

test('killPlan：Windows taskkill /T /F；macOS / Linux 向进程组发 SIGKILL', () => {
  assert.deepStrictEqual(SP.killPlan(1234, 'win32'), { type: 'exec', cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] })
  assert.deepStrictEqual(SP.killPlan(1234, 'darwin'), { type: 'signal', pid: -1234, signal: 'SIGKILL' })
  assert.deepStrictEqual(SP.killPlan(99, 'linux'), { type: 'signal', pid: -99, signal: 'SIGKILL' })
  assert.strictEqual(SP.spawnDetached('darwin'), true)
  assert.strictEqual(SP.spawnDetached('win32'), false)
})

test('killTree：真的结束整个进程组（父进程 + 子进程）', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: SP.spawnDetached() })
  const grandPid = await new Promise(r => child.stdout.once('data', d => r(Number(String(d).trim()))))
  const closed = new Promise(r => child.on('close', (code, sig) => r(sig)))
  killTree(child)
  assert.strictEqual(await closed, 'SIGKILL')
  await new Promise(r => setTimeout(r, 100))
  assert.throws(() => process.kill(grandPid, 0), /ESRCH/) // 孙进程（相当于 ffmpeg）也没了
})

test('默认保存位置与数据目录：macOS ~/Downloads/拾影、~/Library/Application Support/拾影', () => {
  assert.strictEqual(SP.defaultSaveDir('/Users/luke/Downloads', 'darwin'), '/Users/luke/Downloads/拾影')
  assert.strictEqual(SP.defaultSaveDir('C:\\Users\\luke\\Downloads', 'win32'), 'C:\\Users\\luke\\Downloads\\拾影')
  assert.strictEqual(SP.dataDirLabel('darwin'), '~/Library/Application Support/拾影')
  assert.strictEqual(SP.dataSubLabel('telegram', 'darwin'), '~/Library/Application Support/拾影/telegram')
  assert.strictEqual(SP.dataSubLabel('telegram', 'win32'), '%APPDATA%\\拾影\\telegram')
  assert.strictEqual(SP.osLabel('darwin', 'arm64'), 'macOS（Apple 芯片）')
  assert.strictEqual(SP.osLabel('darwin', 'x64'), 'macOS（Intel）')
  assert.strictEqual(SP.pasteKey('darwin'), '⌘V')
  assert.strictEqual(SP.pasteKey('win32'), 'Ctrl+V')
})

test('macOS 菜单：中文、有退出（⌘Q）和编辑菜单（⌘V 粘贴）；Windows 不显示菜单', () => {
  assert.strictEqual(SP.menuTemplate('win32'), null)
  assert.strictEqual(SP.menuTemplate('linux'), null)
  let opened = 0
  const m = SP.menuTemplate('darwin', { appName: '拾影', onHomepage: () => opened++ })
  assert.deepStrictEqual(m.map(x => x.label), ['拾影', '编辑', '显示', '窗口', '帮助'])
  const roles = m.flatMap(x => x.submenu).filter(i => i.role).map(i => i.role)
  for (const r of ['about', 'hide', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize', 'close']) assert.ok(roles.includes(r), r)
  const quit = m[0].submenu.find(i => i.role === 'quit')
  assert.strictEqual(quit.label, '退出拾影')
  assert.strictEqual(m[1].submenu.find(i => i.role === 'paste').label, '粘贴')
  for (const i of m.flatMap(x => x.submenu)) if (i.label) assert.ok(!/[A-Za-z]{3,}/.test(i.label), i.label) // 全中文
  m[4].submenu[0].click()
  assert.strictEqual(opened, 1)
  const dev = SP.menuTemplate('darwin', { isDev: true })
  assert.ok(dev[2].submenu.some(i => i.role === 'toggleDevTools'))
  assert.ok(!m[2].submenu.some(i => i.role === 'toggleDevTools'))
})

test('登录窗口 UA：和本机系统一致，不带 Electron', () => {
  const ua = SP.chromeUA('140.0.7339.0', 'darwin')
  assert.match(ua, /Macintosh; Intel Mac OS X 10_15_7/)
  assert.match(ua, /Chrome\/140\.0\.7339\.0 Safari/)
  assert.doesNotMatch(ua, /Electron/)
  assert.match(SP.chromeUA('140', 'win32'), /Windows NT 10\.0/)
})

test('electron-builder.yml：mac 目标 arm64 + x64、图标 icns、最低系统版本、Info.plist 显示名', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')
  assert.match(y, /^mac:/m)
  assert.match(y, /icon: build\/icon\.icns/)
  assert.match(y, /minimumSystemVersion: "?12\.0"?/)
  assert.match(y, /CFBundleDisplayName: 拾影/)
  assert.ok(fs.statSync(path.join(__dirname, '..', 'build', 'icon.icns')).size > 50_000)
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.icns')).subarray(0, 4).toString(), 'icns')
})
