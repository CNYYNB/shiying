'use strict'
// 1.2.0 内置更新：semver、清单校验 / 多地址回退、按系统挑文件、下载校验（sha256 / 大小）、取消清理、
// Windows 安装命令、Mac 替换脚本（Linux 上用假的 open / xattr / ditto 实际跑一遍）、清单生成工具、端到端模拟（AppUpdater）。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { execFileSync, spawn } = require('child_process')
const Net = require('../src/core/net')
const U = require('../src/core/updater')
const { AppUpdater } = require('../src/main/updater-main')

Net.setProxy(null) // 本地测试不走代理
delete process.env.SHIYING_UPDATE_MANIFESTS

const root = path.resolve(__dirname, '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-upd-'))
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 本地服务器：routes[path] = (req, res) => void */
function server(routes) {
  const s = http.createServer((req, res) => {
    const f = routes[decodeURIComponent(req.url.split('?')[0])]
    if (f) return f(req, res)
    res.writeHead(404); res.end('nf')
  })
  s.keepAliveTimeout = 100
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections?.(); s.close() } })))
}
const sendBuf = (buf, { slow = 0, type = 'application/octet-stream', length = buf.length } = {}) => (req, res) => {
  res.writeHead(200, { 'content-type': type, 'content-length': length })
  let i = 0
  const step = () => { if (res.destroyed) return; if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 32768)); i += 32768; setTimeout(step, slow) }
  step()
}
const json = o => (req, res) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b) }

function manifestFor(base, payloads, extra = {}) {
  const a = (name, buf, mirrors = []) => ({ name, url: `${base}/dl/${name}`, mirrors, sha256: sha(buf), size: buf.length })
  return {
    version: '1.2.0', date: '2026-11-25', notes: '新增内置更新', ...extra,
    win: { x64: a('Shiying-Windows-Setup-1.2.0.exe', payloads.win) },
    mac: { arm64: a('Shiying-macOS-1.2.0-arm64.zip', payloads.arm64), x64: a('Shiying-macOS-1.2.0-x64.zip', payloads.x64) },
  }
}

// ------------------------------------------------------------------ semver

test('semver 比较：数字逐段比较、v 前缀、预发布低于正式版、构建元数据忽略', () => {
  const c = U.cmpSemver
  assert.equal(c('1.2.0', '1.1.1'), 1)
  assert.equal(c('1.1.1', '1.2.0'), -1)
  assert.equal(c('1.10.0', '1.9.9'), 1) // 不是字符串比较
  assert.equal(c('2.0.0', '1.99.99'), 1)
  assert.equal(c('v1.2.0', '1.2.0'), 0)
  assert.equal(c('1.2.0+build.5', '1.2.0'), 0)
  assert.equal(c('1.2.0-beta.1', '1.2.0'), -1)
  assert.equal(c('1.2.0', '1.2.0-rc.1'), 1)
  assert.equal(c('1.2.0-beta.2', '1.2.0-beta.10'), -1)
  assert.equal(c('1.2.0-alpha', '1.2.0-alpha.1'), -1)
  assert.equal(c('1.2.0-alpha.1', '1.2.0-alpha.beta'), -1) // 数字标识低于字母
  assert.equal(c('1.2.0-rc.1', '1.2.0-beta.9'), 1)
  assert.throws(() => c('1.2', '1.2.0'))
  assert.throws(() => c('01.2.0', '1.2.0'))
  assert.throws(() => c('latest', '1.2.0'))
  assert.equal(U.isSemver('1.2.0'), true)
  assert.equal(U.isSemver('1.2.0.1'), false)
})

// ------------------------------------------------------------------ manifest

const GOOD = {
  version: '1.2.0', notes: ['新增内置更新', '修复'], minVersion: '1.0.0',
  win: { x64: { url: 'https://github.com/CNYYNB/shiying/releases/download/pc-1.2.0/Shiying-Windows-Setup-1.2.0.exe', mirrors: ['https://r2.example.com/pc-1.2.0/Shiying-Windows-Setup-1.2.0.exe'], sha256: 'A'.repeat(64), size: 123 } },
  mac: { arm64: { url: 'https://github.com/x/y/releases/download/pc-1.2.0/Shiying-macOS-1.2.0-arm64.zip', sha256: 'b'.repeat(64), size: 456 } },
}

test('清单解析：整理字段、notes 数组合并、sha256 小写、文件名取自地址；带 BOM 也能读', () => {
  const m = U.parseManifest('\uFEFF' + JSON.stringify(GOOD))
  assert.equal(m.version, '1.2.0')
  assert.equal(m.notes, '新增内置更新\n修复')
  assert.equal(m.minVersion, '1.0.0')
  assert.equal(m.page, U.DEFAULT_PAGE)
  assert.equal(m.win.x64.sha256, 'a'.repeat(64))
  assert.equal(m.win.x64.name, 'Shiying-Windows-Setup-1.2.0.exe')
  assert.deepEqual(m.win.x64.mirrors, ['https://r2.example.com/pc-1.2.0/Shiying-Windows-Setup-1.2.0.exe'])
  assert.deepEqual(m.mac.arm64.mirrors, [])
  assert.equal(U.parseManifest({ ...GOOD, version: 'v1.3.0' }).version, '1.3.0')
})

test('清单解析：拒绝不安全或不完整的清单（中文错误）', () => {
  const bad = (m, re) => assert.throws(() => U.parseManifest(m), e => e instanceof U.UpdateError && e.kind === 'manifest' && re.test(e.message))
  bad('<html>被拦截</html>', /不是 JSON/)
  bad('[]', /格式不对/)
  bad({ ...GOOD, version: '1.2' }, /版本号/)
  bad({ ...GOOD, minVersion: 'x' }, /minVersion/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, url: 'http://github.com/a.exe' } } }, /https/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, mirrors: ['ftp://x/a.exe'] } } }, /https/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, url: 'Shiying.exe' } } }, /完整网址/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, sha256: 'abc' } } }, /sha256/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, size: 0 } } }, /大小/)
  bad({ ...GOOD, win: { x64: { ...GOOD.win.x64, size: '123' } } }, /大小/)
  bad({ version: '1.2.0', notes: '' }, /没有任何安装文件/)
  // 测试时可以允许 http
  assert.ok(U.parseManifest({ ...GOOD, win: { x64: { ...GOOD.win.x64, url: 'http://127.0.0.1/a.exe' } } }, { allowHttp: true }))
})

test('按系统 / 架构挑安装文件', () => {
  const m = U.parseManifest({ ...GOOD, mac: { arm64: GOOD.mac.arm64, x64: { ...GOOD.mac.arm64, url: 'https://x/Shiying-macOS-1.2.0-x64.zip' } } })
  assert.equal(U.pickAsset(m, 'win32', 'x64').name, 'Shiying-Windows-Setup-1.2.0.exe')
  const wa = U.pickAsset(m, 'win32', 'arm64') // Windows on ARM 用 x64 模拟
  assert.equal(wa.name, 'Shiying-Windows-Setup-1.2.0.exe'); assert.equal(wa.emulated, true)
  assert.equal(U.pickAsset(m, 'darwin', 'arm64').name, 'Shiying-macOS-1.2.0-arm64.zip')
  assert.equal(U.pickAsset(m, 'darwin', 'arm64').emulated, false)
  assert.equal(U.pickAsset(m, 'darwin', 'x64').name, 'Shiying-macOS-1.2.0-x64.zip')
  assert.equal(U.pickAsset(m, 'linux', 'x64'), null)
  assert.equal(U.pickAsset(m, 'win32', 'ia32'), null)
  // 没有 Apple 芯片版时用 Intel 版（Rosetta）；没有 Intel 版时 Intel Mac 没有文件
  const onlyArm = U.parseManifest(GOOD)
  assert.equal(U.pickAsset(onlyArm, 'darwin', 'x64'), null)
  const onlyX64 = U.parseManifest({ ...GOOD, mac: { x64: GOOD.mac.arm64 } })
  assert.equal(U.pickAsset(onlyX64, 'darwin', 'arm64').emulated, true)
})

test('清单地址：环境变量 > package.json > 默认；package.json 的列表和默认一致（中文路径已编码）', () => {
  const pkg = require('../package.json')
  assert.deepEqual(U.manifestUrls(pkg, {}), U.DEFAULT_MANIFESTS)
  assert.equal(U.DEFAULT_MANIFESTS[0], 'https://shiying-louis.pages.dev/pc-version.json')
  assert.equal(U.DEFAULT_MANIFESTS[1], 'https://raw.githubusercontent.com/CNYYNB/shiying/main/%E7%94%B5%E8%84%91%E7%89%88/update/pc-version.json')
  assert.equal(U.DEFAULT_MANIFESTS[2], 'https://fastly.jsdelivr.net/gh/CNYYNB/shiying@main/%E7%94%B5%E8%84%91%E7%89%88/update/pc-version.json')
  assert.equal(decodeURIComponent(U.DEFAULT_MANIFESTS[1]).includes('/电脑版/update/'), true)
  assert.deepEqual(U.manifestUrls(pkg, { SHIYING_UPDATE_MANIFESTS: 'https://a/x.json, https://b/y.json' }), ['https://a/x.json', 'https://b/y.json'])
  assert.deepEqual(U.manifestUrls({ shiyingUpdate: { manifests: ['https://c/z.json'] } }, {}), ['https://c/z.json'])
  assert.deepEqual(U.manifestUrls({}, {}), U.DEFAULT_MANIFESTS)
  // 构建时覆盖（electron-builder extraMetadata）
  const { builderConfig } = require('../build/config')
  assert.equal(builderConfig({}), 'electron-builder.yml')
  assert.deepEqual(builderConfig({ SHIYING_UPDATE_MANIFESTS: 'https://m1/p.json,https://m2/p.json' }), { extends: 'electron-builder.yml', extraMetadata: { shiyingUpdate: { manifests: ['https://m1/p.json', 'https://m2/p.json'] } } })
  assert.throws(() => builderConfig({ SHIYING_UPDATE_MANIFESTS: 'http://m1/p.json' }))
})

test('读清单：按顺序回退（500 → 超时 → 拦截网页 → 正确），短超时', async () => {
  const good = { ...GOOD, version: '1.3.0' }
  const { base, close } = await server({
    '/500.json': (q, r) => { r.writeHead(500); r.end() },
    '/hang.json': () => {}, // 不回应
    '/html.json': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html>运营商拦截页</html>') },
    '/ok.json': json(good),
  })
  try {
    const t0 = Date.now()
    const logs = []
    const r = await U.fetchManifest([`${base}/500.json`, `${base}/hang.json`, `${base}/html.json`, `${base}/ok.json`], { timeout: 400, log: s => logs.push(s) })
    assert.equal(r.source, `${base}/ok.json`)
    assert.equal(r.manifest.version, '1.3.0')
    assert.equal(r.errors.length, 3)
    assert.deepEqual(r.errors.map(e => e.kind), ['http', 'timeout', 'manifest'])
    assert.ok(Date.now() - t0 < 3000, '超时要短')
    assert.equal(logs.length, 3)
  } finally { close() }
})

test('读清单：全部失败时给出最有用的中文提示（超时 / 拦截 → 建议 VPN；404）', async () => {
  const { base, close } = await server({ '/hang.json': () => {} })
  try {
    await assert.rejects(U.fetchManifest([`${base}/hang.json`], { timeout: 300 }), e => e.kind === 'timeout' && /检查更新失败/.test(e.message) && /VPN/.test(e.message))
    await assert.rejects(U.fetchManifest([`${base}/none.json`], { timeout: 300 }), e => e.kind === 'http404' && /404/.test(e.message))
    // 连不上的端口 → 拦截 / 无法连接
    const dead = await server({}); const deadUrl = dead.base + '/x.json'; dead.close(); await sleep(50)
    await assert.rejects(U.fetchManifest([deadUrl, `${base}/hang.json`], { timeout: 300 }), e => ['timeout', 'blocked'].includes(e.kind) && /VPN/.test(e.message) && /已尝试 2 个地址/.test(e.message))
  } finally { close() }
})

test('检查更新：有新版本 / 已是最新 / 低于 minVersion 要手动 / 没有本机文件', async () => {
  const { base, close } = await server({ '/m.json': json({ ...GOOD, minVersion: '1.1.0' }) })
  try {
    const urls = [`${base}/m.json`]
    let r = await U.checkForUpdate({ current: '1.1.1', urls, platform: 'win32', arch: 'x64' })
    assert.equal(r.available, true); assert.equal(r.needManual, false); assert.equal(r.asset.name, 'Shiying-Windows-Setup-1.2.0.exe')
    r = await U.checkForUpdate({ current: '1.2.0', urls, platform: 'win32', arch: 'x64' })
    assert.equal(r.available, false)
    r = await U.checkForUpdate({ current: '1.3.0-beta.1', urls, platform: 'win32', arch: 'x64' })
    assert.equal(r.available, false)
    r = await U.checkForUpdate({ current: '1.0.5', urls, platform: 'win32', arch: 'x64' })
    assert.equal(r.available, true); assert.equal(r.belowMin, true); assert.equal(r.needManual, true)
    r = await U.checkForUpdate({ current: '1.1.1', urls, platform: 'linux', arch: 'x64' })
    assert.equal(r.needManual, true); assert.equal(r.asset, null)
  } finally { close() }
})

// ------------------------------------------------------------------ download

const PAYLOAD = crypto.randomBytes(600 * 1024)

test('下载：进度、大小和 sha256 都对才保存；再次下载直接复用', async () => {
  const { base, close } = await server({ '/dl/a.exe': sendBuf(PAYLOAD) })
  try {
    const dir = tmp()
    const asset = { name: 'Shiying-Windows-Setup-1.2.0.exe', url: `${base}/dl/a.exe`, mirrors: [], sha256: sha(PAYLOAD), size: PAYLOAD.length }
    const prog = []
    const r = await U.downloadAsset(asset, dir, { onProgress: p => prog.push(p) })
    assert.equal(path.basename(r.file), 'Shiying-Windows-Setup-1.2.0.exe')
    assert.equal(r.cached, false)
    assert.deepEqual(fs.readFileSync(r.file), PAYLOAD)
    assert.equal(prog.at(-1).done, PAYLOAD.length); assert.equal(prog.at(-1).total, PAYLOAD.length)
    assert.deepEqual(fs.readdirSync(dir), ['Shiying-Windows-Setup-1.2.0.exe'])
    const again = await U.downloadAsset(asset, dir)
    assert.equal(again.cached, true)
  } finally { close() }
})

test('下载：sha256 不一致 → 拒绝并删除，换下一个地址；全错 → 「校验失败」', async () => {
  const tampered = Buffer.from(PAYLOAD); tampered[1000] ^= 0xff
  const { base, close } = await server({ '/dl/bad.exe': sendBuf(tampered), '/dl/good.exe': sendBuf(PAYLOAD), '/dl/404.exe': (q, r) => { r.writeHead(404); r.end() } })
  try {
    const dir = tmp()
    const asset = { name: 'S.exe', url: `${base}/dl/bad.exe`, mirrors: [`${base}/dl/404.exe`, `${base}/dl/good.exe`], sha256: sha(PAYLOAD), size: PAYLOAD.length }
    const logs = []
    const r = await U.downloadAsset(asset, dir, { log: s => logs.push(s) })
    assert.deepEqual(fs.readFileSync(r.file), PAYLOAD)
    assert.equal(logs.length, 2); assert.match(logs[0], /checksum/); assert.match(logs[1], /http404/)
    const dir2 = tmp()
    await assert.rejects(U.downloadAsset({ ...asset, mirrors: [`${base}/dl/404.exe`] }, dir2), e => e.kind === 'checksum' && /校验失败/.test(e.message) && /已删除/.test(e.message))
    assert.deepEqual(fs.readdirSync(dir2), [], '校验失败的文件和 .part 都要删掉')
    // 已有但被改过的旧文件不会被当作缓存
    fs.writeFileSync(path.join(dir2, 'S.exe'), tampered)
    await assert.rejects(U.downloadAsset({ ...asset, mirrors: [] }, dir2), e => e.kind === 'checksum')
    assert.deepEqual(fs.readdirSync(dir2), [])
  } finally { close() }
})

test('下载：大小不对（content-length 不一致 / 比声明的大）立即停止并删除；返回网页 → 拦截提示', async () => {
  const big = Buffer.concat([PAYLOAD, Buffer.alloc(5000)])
  const { base, close } = await server({
    '/dl/len.exe': sendBuf(big),
    '/dl/chunked.exe': (q, r) => { r.writeHead(200, { 'content-type': 'application/octet-stream' }); r.write(big.subarray(0, 400000)); setTimeout(() => r.end(big.subarray(400000)), 20) },
    '/dl/page.exe': (q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end('<html>登录 Wi-Fi</html>') },
  })
  try {
    const dir = tmp()
    const asset = n => ({ name: 'S.exe', url: `${base}/dl/${n}`, mirrors: [], sha256: sha(PAYLOAD), size: PAYLOAD.length })
    await assert.rejects(U.downloadAsset(asset('len.exe'), dir), e => e.kind === 'size')
    await assert.rejects(U.downloadAsset(asset('chunked.exe'), dir), e => e.kind === 'size' && /比发布的大/.test(e.message))
    await assert.rejects(U.downloadAsset(asset('page.exe'), dir), e => e.kind === 'blocked' && /网页/.test(e.message) && /VPN/.test(e.message))
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally { close() }
})

test('下载：取消 → 「已取消」，.part 删除，不再试备用地址', async () => {
  let mirrorHits = 0
  const { base, close } = await server({ '/dl/slow.exe': sendBuf(PAYLOAD, { slow: 40 }), '/dl/m.exe': (q, r) => { mirrorHits++; sendBuf(PAYLOAD)(q, r) } })
  try {
    const dir = tmp()
    const ctrl = new AbortController()
    let sawPart = false
    const p = U.downloadAsset({ name: 'S.exe', url: `${base}/dl/slow.exe`, mirrors: [`${base}/dl/m.exe`], sha256: sha(PAYLOAD), size: PAYLOAD.length }, dir, {
      signal: ctrl.signal,
      onProgress: x => { if (x.done > 100000 && !ctrl.signal.aborted) { sawPart = fs.existsSync(path.join(dir, 'S.exe.part')); ctrl.abort() } },
    })
    await assert.rejects(p, e => e.kind === 'cancelled' && e.message === '已取消')
    assert.equal(sawPart, true, '取消前应该有 .part')
    await sleep(50)
    assert.deepEqual(fs.readdirSync(dir), [], '取消后 .part 要删掉')
    assert.equal(mirrorHits, 0)
  } finally { close() }
})

test('下载：卡住没数据 → 超时提示（建议 VPN），删除 .part', async () => {
  const { base, close } = await server({ '/dl/stall.exe': (q, r) => { r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': PAYLOAD.length }); r.write(PAYLOAD.subarray(0, 50000)) } })
  try {
    const dir = tmp()
    await assert.rejects(U.downloadAsset({ name: 'S.exe', url: `${base}/dl/stall.exe`, mirrors: [], sha256: sha(PAYLOAD), size: PAYLOAD.length }, dir, { stallMs: 300 }),
      e => e.kind === 'timeout' && /卡住/.test(e.message) && /VPN/.test(e.message))
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally { close() }
})

test('错误归类：中文说明', () => {
  const k = e => U.classify(e)
  assert.equal(k(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).kind, 'blocked')
  assert.equal(k(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })).kind, 'blocked')
  assert.equal(k(Object.assign(new Error('x'), { name: 'TimeoutError' })).kind, 'timeout')
  assert.equal(k(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).kind, 'timeout')
  assert.equal(k(Object.assign(new Error('x'), { httpStatus: 404 })).kind, 'http404')
  assert.equal(k(Object.assign(new Error('x'), { httpStatus: 503 })).kind, 'http')
  assert.equal(k(Object.assign(new Error('no space'), { code: 'ENOSPC' })).kind, 'disk')
  assert.equal(k(Object.assign(new Error('x'), { code: 'EACCES' })).kind, 'perm')
  for (const e of [k(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), k(Object.assign(new Error('x'), { name: 'TimeoutError' }))]) assert.match(e.message, /VPN/)
})

// ------------------------------------------------------------------ install helpers

test('Windows：安装版静默升级参数；便携版打开安装界面；electron-builder 配置支持原地升级', () => {
  const exists = p => p === 'C:\\Users\\a\\AppData\\Local\\Programs\\拾影\\Uninstall 拾影.exe'
  assert.equal(U.winIsInstalled('C:\\Users\\a\\AppData\\Local\\Programs\\拾影\\拾影.exe', exists), true)
  assert.equal(U.winIsInstalled('D:\\便携\\拾影\\拾影.exe', exists), false)
  assert.deepEqual(U.winInstallCommand('C:\\T\\S.exe', { installed: true }), { file: 'C:\\T\\S.exe', args: ['/S', '--updated', '--force-run'], silent: true })
  assert.deepEqual(U.winInstallCommand('C:\\T\\S.exe', { installed: false }).args, [])
  const yml = require('js-yaml').load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  assert.equal(yml.appId, 'com.louis.shiying.pc') // 不变：注册表键和安装位置靠它
  assert.equal(yml.productName, '拾影') // 数据目录 %APPDATA%\拾影
  assert.equal(yml.nsis.perMachine, false)
  assert.equal(yml.nsis.oneClick, false)
  assert.notEqual(yml.nsis.deleteAppDataOnUninstall, true) // 升级时（--updated）和卸载时都不删数据
  assert.equal(yml.nsis.artifactName, 'Shiying-Windows-Setup-${version}.${ext}')
  assert.equal(yml.mac.artifactName, 'Shiying-macOS-${version}-${arch}.${ext}')
  // NSIS 模板确实认 --updated / --force-run
  const nsisDir = path.join(root, 'node_modules/app-builder-lib/templates/nsis')
  assert.match(fs.readFileSync(path.join(nsisDir, 'installSection.nsh'), 'utf8'), /isForceRun[\s\S]*Silent[\s\S]*doStartApp/)
  assert.match(fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8'), /flags\(\["updated", "force-run"/)
})

test('Mac：找 .app、判断能否原地替换', () => {
  assert.equal(U.macBundleFromExec('/Applications/拾影.app/Contents/MacOS/拾影'), '/Applications/拾影.app')
  assert.equal(U.macBundleFromExec('/Users/a/Downloads/拾影 2.app/Contents/MacOS/拾影'), '/Users/a/Downloads/拾影 2.app')
  assert.equal(U.macBundleFromExec('/usr/bin/node'), null)
  assert.deepEqual(U.macCanReplace('/Applications/拾影.app', { access: () => {} }), { ok: true })
  assert.equal(U.macCanReplace('/private/var/folders/x/AppTranslocation/ABC/d/拾影.app', { access: () => {} }).reason, 'translocated')
  assert.equal(U.macCanReplace('/Applications/拾影.app', { access: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } }).reason, 'no-permission')
  assert.equal(U.macCanReplace('/Volumes/拾影/拾影.app', { access: () => { throw Object.assign(new Error('x'), { code: 'EROFS' }) } }).reason, 'readonly')
  assert.equal(U.macCanReplace(null).reason, 'not-bundle')
  const msg = U.macFallbackMessage('no-permission', '/Users/a/Downloads/拾影新版本-1.2.0/拾影.app')
  assert.match(msg, /应用程序/); assert.match(msg, /替换/); assert.match(msg, /拾影新版本-1\.2\.0/); assert.match(msg, /会保留/)
})

/** 假的 拾影.app（Info.plist + 主程序） */
function fakeApp(dir, version, id = U.APP_ID) {
  const app = path.join(dir, '拾影.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>拾影</string></dict></plist>`)
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', '拾影'), '#!/bin/sh\n', { mode: 0o755 })
  return app
}

test('Mac：检查解压出来的 .app（bundle id、版本、主程序）', () => {
  const d = tmp(); fakeApp(d, '1.2.0')
  assert.equal(U.macFindAndCheckApp(d, '1.2.0'), path.join(d, '拾影.app'))
  assert.throws(() => U.macFindAndCheckApp(d, '1.3.0'), /版本/)
  const d2 = tmp(); fakeApp(d2, '1.2.0', 'com.evil.app')
  assert.throws(() => U.macFindAndCheckApp(d2, '1.2.0'), /bundle id/)
  assert.throws(() => U.macFindAndCheckApp(tmp(), '1.2.0'), /没有找到/)
})

/** PATH 里放假的 open / xattr / ditto（Linux 上模拟 macOS 命令），调用记录写到 calls.log */
function fakeMacBin() {
  const bin = tmp(), calls = path.join(bin, 'calls.log')
  const w = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} $*" >> '${calls}'\n${body}\n`, { mode: 0o755 })
  w('open', '')
  w('xattr', '')
  w('ditto', 'if [ "$1" = "-x" ]; then unzip -q "$3" -d "$4"; else cp -R "$1" "$2"; fi')
  return { bin, calls, env: { ...process.env, PATH: bin + ':' + process.env.PATH } }
}

test('Mac 替换脚本（Linux 上实际运行）：等进程退出 → 换成新版 → 去隔离 → 打开；失败时放回旧版', async () => {
  const fake = fakeMacBin()
  const apps = tmp(), stage = tmp()
  const target = fakeApp(apps, '1.1.1')
  fs.writeFileSync(path.join(target, 'Contents', 'user-file'), 'old')
  const newApp = fakeApp(stage, '1.2.0')
  const sleeper = spawn('sleep', ['30'])
  const log = path.join(stage, 'swap.log')
  const script = path.join(stage, 'swap.sh')
  fs.writeFileSync(script, U.macSwapScript({ pid: sleeper.pid, target, newApp, log }))
  const t0 = Date.now()
  const child = spawn('/bin/sh', [script], { env: fake.env })
  await sleep(500)
  assert.equal(U.plistValue(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString'), '1.1.1', '进程退出前不能动')
  sleeper.kill()
  const code = await new Promise(r => child.on('exit', r))
  assert.equal(code, 0, fs.readFileSync(log, 'utf8'))
  assert.ok(Date.now() - t0 >= 500)
  assert.equal(U.plistValue(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString'), '1.2.0')
  assert.equal(fs.existsSync(target + '.old-update'), false)
  assert.equal(fs.existsSync(newApp), false)
  const calls = fs.readFileSync(fake.calls, 'utf8')
  assert.match(calls, new RegExp(`xattr -cr ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(calls, /open .*拾影\.app\n?$/)

  // 新版不见了（mv 和 ditto 都失败）→ 放回旧版并打开旧版
  const apps2 = tmp(), stage2 = tmp()
  const target2 = fakeApp(apps2, '1.1.1')
  const script2 = path.join(stage2, 'swap.sh')
  fs.writeFileSync(script2, U.macSwapScript({ pid: 999999, target: target2, newApp: path.join(stage2, '不存在.app'), log: path.join(stage2, 'swap.log') }))
  const code2 = await new Promise(r => spawn('/bin/sh', [script2], { env: fake.env }).on('exit', r))
  assert.equal(code2, 1)
  assert.equal(U.plistValue(fs.readFileSync(path.join(target2, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString'), '1.1.1')
  assert.match(fs.readFileSync(path.join(stage2, 'swap.log'), 'utf8'), /rollback/)
})

test('Mac 替换脚本：路径里有单引号、空格也安全', () => {
  const s = U.macSwapScript({ pid: 1, target: "/Applications/拾影 'x'.app", newApp: '/tmp/a b/拾影.app', log: '/tmp/l.log' })
  assert.match(s, /TARGET='\/Applications\/拾影 '\\''x'\\''\.app'/)
  execFileSync('sh', ['-n', '-c', s]) // 语法检查
})

// ------------------------------------------------------------------ manifest tool

test('make-pc-manifest：读发布文件算 sha256 / 大小，地址正确编码，带备用镜像，通过客户端校验', () => {
  const { makeManifest } = require('../tools/make-pc-manifest')
  const dist = tmp()
  const files = { 'Shiying-Windows-Setup-1.2.0.exe': Buffer.from('win'), 'Shiying-macOS-1.2.0-arm64.zip': Buffer.from('arm'), 'Shiying-macOS-1.2.0-x64.zip': Buffer.from('x64x') }
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dist, n), b)
  const m = makeManifest({ version: '1.2.0', tag: 'pc-1.2.0', dist, mirror: ['https://pub-x.r2.dev/pc-1.2.0/'], date: '2026-11-25' })
  assert.equal(m.version, '1.2.0'); assert.equal(m.date, '2026-11-25')
  assert.match(m.notes, /新增内置更新/)
  assert.equal(m.win.x64.url, 'https://github.com/CNYYNB/shiying/releases/download/pc-1.2.0/Shiying-Windows-Setup-1.2.0.exe')
  assert.deepEqual(m.win.x64.mirrors, ['https://pub-x.r2.dev/pc-1.2.0/Shiying-Windows-Setup-1.2.0.exe'])
  assert.equal(m.mac.arm64.sha256, sha(files['Shiying-macOS-1.2.0-arm64.zip']))
  assert.equal(m.mac.x64.size, 4)
  const parsed = U.parseManifest(JSON.stringify(m))
  assert.equal(U.pickAsset(parsed, 'darwin', 'x64').name, 'Shiying-macOS-1.2.0-x64.zip')
  fs.rmSync(path.join(dist, 'Shiying-macOS-1.2.0-x64.zip'))
  assert.throws(() => makeManifest({ version: '1.2.0', dist, mirror: [] }), /找不到发布文件/)
  assert.throws(() => makeManifest({ version: '9.9.9', dist, mirror: [] }), /缺少更新说明/)
  assert.throws(() => makeManifest({ version: '1.2.0', dist, mirror: ['http://x/'] }), /mirror/)
})

test('仓库里的 update/pc-version.json 是 1.2.0、格式正确、地址指向 pc-1.2.0', () => {
  const f = path.join(root, 'update', 'pc-version.json')
  const m = U.parseManifest(fs.readFileSync(f, 'utf8'))
  const pkg = require('../package.json')
  assert.equal(m.version, pkg.version)
  assert.equal(pkg.version, '1.2.0')
  for (const a of [m.win.x64, m.mac.arm64, m.mac.x64]) assert.match(a.url, /^https:\/\/github\.com\/CNYYNB\/shiying\/releases\/download\/pc-1\.2\.0\/Shiying-/)
  // dist 里有构建产物时核对 sha256 / 大小
  for (const a of [m.win.x64, m.mac.arm64, m.mac.x64]) {
    const p = path.join(root, 'dist', a.name)
    if (!fs.existsSync(p)) continue
    assert.equal(fs.statSync(p).size, a.size, a.name)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), a.sha256, a.name)
  }
})

// ------------------------------------------------------------------ end-to-end (AppUpdater with fake Electron)

function fakeElectron(dir, { isPackaged = true } = {}) {
  const calls = { quit: 0, openExternal: [], openPath: [], showItemInFolder: [] }
  const paths = { temp: path.join(dir, 'temp'), userData: path.join(dir, 'userData'), downloads: path.join(dir, 'Downloads') }
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true })
  const store = {}
  return {
    calls,
    app: { isPackaged, getPath: k => paths[k], quit: () => { calls.quit++ } },
    shell: { openExternal: u => calls.openExternal.push(u), openPath: async p => { calls.openPath.push(p); return '' }, showItemInFolder: p => calls.showItemInFolder.push(p) },
    settings: { get: k => store[k], set: (k, v) => { store[k] = v } },
    store,
  }
}

test('端到端（Windows 安装版）：自动检查 → 下载进度 → 校验 → 静默安装参数 → 退出；6 小时内不重复检查；可关闭', async () => {
  const setup = crypto.randomBytes(300 * 1024)
  let manifestHits = 0
  const routes = { '/dl/Shiying-Windows-Setup-1.2.0.exe': sendBuf(setup) }
  const { base, close } = await server(routes)
  routes['/pc-version.json'] = (q, r) => { manifestHits++; json(manifestFor(base, { win: setup, arm64: Buffer.from('a'), x64: Buffer.from('b') }))(q, r) }
  try {
    const d = tmp(); const E = fakeElectron(d)
    const events = [], spawned = []
    const up = new AppUpdater({
      app: E.app, shell: E.shell, settings: E.settings, send: (ch, p) => events.push(p), version: '1.1.1', allowHttp: true,
      pkg: { shiyingUpdate: { manifests: [`${base}/missing.json`, `${base}/pc-version.json`] } },
      platform: 'win32', arch: 'x64', execPath: 'C:\\P\\拾影\\拾影.exe',
      spawn: (file, args, opts) => { spawned.push({ file, args, opts }); const { EventEmitter } = require('events'); const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('spawn')); return c },
    })
    // 便携版判断：没有 Uninstall 拾影.exe → win-setup；这里用 execPath 所在目录不存在 → 便携版
    let r = await up.check({ manual: false })
    assert.equal(r.ok, true); assert.equal(r.available, true); assert.equal(r.mode, 'win-setup')
    assert.equal(events[0].phase, 'available'); assert.equal(events[0].version, '1.2.0'); assert.match(events[0].notes, /内置更新/)
    assert.equal(await up.check({ manual: false }), null, '6 小时内不再自动检查')
    assert.equal(manifestHits, 1)
    E.store.updateCheckAt = Date.now() - 7 * 3600e3; E.store.updateAuto = false
    assert.equal(await up.check({ manual: false }), null, '关闭后不自动检查')
    // 安装版（exe 旁边有卸载程序）→ 静默升级
    const inst = path.join(d, 'inst'); fs.mkdirSync(inst); fs.writeFileSync(path.join(inst, 'Uninstall 拾影.exe'), '')
    up.execPath = path.join(inst, '拾影.exe').replace(/\//g, '\\')
    // winIsInstalled 用 win32 路径规则；Linux 上把它指回真实路径
    const orig = U.winIsInstalled; U.winIsInstalled = () => fs.existsSync(path.join(inst, 'Uninstall 拾影.exe'))
    try {
      r = await up.check({ manual: true })
      assert.equal(r.mode, 'win-silent')
      const res = await up.start()
      assert.equal(res.ok, true, res.error); assert.equal(res.quitting, true)
    } finally { U.winIsInstalled = orig }
    assert.equal(spawned.length, 1)
    assert.equal(path.basename(spawned[0].file), 'Shiying-Windows-Setup-1.2.0.exe')
    assert.ok(spawned[0].file.startsWith(path.join(d, 'temp', 'shiying-update')))
    assert.deepEqual(spawned[0].args, ['/S', '--updated', '--force-run'])
    assert.equal(spawned[0].opts.detached, true)
    assert.deepEqual(fs.readFileSync(spawned[0].file), setup)
    assert.ok(events.some(e => e.phase === 'progress' && e.done === setup.length))
    assert.ok(events.some(e => e.phase === 'installing'))
    await sleep(900)
    assert.equal(E.calls.quit, 1)
    // 新版第一次启动：提示「已更新到 1.2.0」，清理更新文件
    const up2 = new AppUpdater({ app: E.app, shell: E.shell, settings: E.settings, send: () => {}, version: '1.2.0', pkg: {} })
    assert.deepEqual({ from: up2.consumeMarker().from, to: '1.2.0' }, { from: '1.1.1', to: '1.2.0' })
    assert.equal(up2.consumeMarker(), null)
    assert.equal(fs.existsSync(path.join(d, 'temp', 'shiying-update')), false)
  } finally { close() }
})

test('端到端：下载中取消 → 删除没下完的文件、不退出；sha256 不对 → 「校验失败」、不安装', async () => {
  const setup = crypto.randomBytes(800 * 1024)
  const routes = { '/dl/Shiying-Windows-Setup-1.2.0.exe': sendBuf(setup, { slow: 30 }) }
  const { base, close } = await server(routes)
  let tamper = false
  routes['/pc-version.json'] = (q, r) => { const m = manifestFor(base, { win: setup, arm64: Buffer.from('a'), x64: Buffer.from('b') }); if (tamper) m.win.x64.sha256 = 'f'.repeat(64); json(m)(q, r) }
  try {
    const d = tmp(); const E = fakeElectron(d)
    let spawned = 0
    const events = []
    const up = new AppUpdater({ app: E.app, shell: E.shell, settings: E.settings, send: (c, p) => { events.push(p); if (p.phase === 'progress' && p.done > 64 * 1024) up.cancel() }, version: '1.1.1', allowHttp: true,
      pkg: { shiyingUpdate: { manifests: [`${base}/pc-version.json`] } }, platform: 'win32', arch: 'x64', execPath: 'D:\\portable\\拾影.exe', spawn: () => { spawned++ } })
    await up.check({ manual: true })
    const r = await up.start()
    assert.equal(r.ok, false); assert.equal(r.cancelled, true)
    await sleep(50)
    const dir = path.join(d, 'temp', 'shiying-update')
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [])
    assert.equal(spawned, 0); assert.equal(E.calls.quit, 0)
    // 校验失败
    tamper = true
    up.send = () => {}
    await up.check({ manual: true })
    const r2 = await up.start()
    assert.equal(r2.ok, false); assert.equal(r2.kind, 'checksum'); assert.match(r2.error, /校验失败/)
    assert.deepEqual(fs.readdirSync(dir), [])
    assert.equal(spawned, 0); assert.equal(E.calls.quit, 0)
    assert.match(up.diagText(), /checksum/)
  } finally { close() }
})

test('端到端（Mac，Linux 上模拟 ditto / xattr / open）：下载 zip → 解压 → 检查 → 退出后替换 .app 并重新打开', async () => {
  const fake = fakeMacBin()
  const oldPath = process.env.PATH; process.env.PATH = fake.env.PATH
  try {
    const src = tmp(); fakeApp(src, '1.2.0')
    const zip = path.join(tmp(), 'Shiying-macOS-1.2.0-arm64.zip')
    execFileSync('zip', ['-q', '-r', '-y', zip, '拾影.app'], { cwd: src })
    const zbuf = fs.readFileSync(zip)
    const routes = { '/dl/Shiying-macOS-1.2.0-arm64.zip': sendBuf(zbuf) }
    const { base, close } = await server(routes)
    routes['/pc-version.json'] = json(manifestFor(base, { win: Buffer.from('w'), arm64: zbuf, x64: Buffer.from('x') }))
    try {
      const d = tmp(); const E = fakeElectron(d)
      const apps = path.join(d, 'Applications'); fs.mkdirSync(apps)
      const target = fakeApp(apps, '1.1.1')
      const running = spawn('sleep', ['30']) // 代表正在运行的旧版拾影
      E.app.quit = () => { E.calls.quit++; running.kill() }
      const up = new AppUpdater({ app: E.app, shell: E.shell, settings: E.settings, send: () => {}, version: '1.1.1', allowHttp: true,
        pkg: { shiyingUpdate: { manifests: [`${base}/pc-version.json`] } }, platform: 'darwin', arch: 'arm64', execPath: path.join(target, 'Contents', 'MacOS', '拾影'), pid: running.pid })
      const c = await up.check({ manual: true })
      assert.equal(c.mode, 'mac')
      const r = await up.start()
      assert.equal(r.ok, true, r.error); assert.equal(r.quitting, true)
      const log = path.join(d, 'temp', 'shiying-update', 'swap.log')
      for (let i = 0; i < 60 && !(fs.existsSync(log) && /ok/.test(fs.readFileSync(log, 'utf8'))); i++) await sleep(100)
      assert.match(fs.readFileSync(log, 'utf8'), /ok/)
      assert.equal(U.plistValue(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString'), '1.2.0')
      const calls = fs.readFileSync(fake.calls, 'utf8')
      assert.match(calls, /^ditto -x -k /m)
      assert.match(calls, /^xattr -cr .*extract-1\.2\.0\/拾影\.app$/m) // 解压后先去隔离
      assert.match(calls, /^open .*Applications\/拾影\.app$/m) // 替换后重新打开
      assert.equal(E.calls.quit, 1)
    } finally { close() }
  } finally { process.env.PATH = oldPath }
})

test('端到端（Mac）：没有写入权限 → 新版放到「下载」并在访达中显示，给出中文步骤，不退出', async () => {
  const fake = fakeMacBin()
  const oldPath = process.env.PATH; process.env.PATH = fake.env.PATH
  const orig = U.macCanReplace
  U.macCanReplace = () => ({ ok: false, reason: 'no-permission' })
  try {
    const src = tmp(); fakeApp(src, '1.2.0')
    const zip = path.join(tmp(), 'z.zip')
    execFileSync('zip', ['-q', '-r', '-y', zip, '拾影.app'], { cwd: src })
    const zbuf = fs.readFileSync(zip)
    const routes = { '/dl/Shiying-macOS-1.2.0-x64.zip': sendBuf(zbuf) }
    const { base, close } = await server(routes)
    routes['/pc-version.json'] = json(manifestFor(base, { win: Buffer.from('w'), arm64: Buffer.from('a'), x64: zbuf }))
    try {
      const d = tmp(); const E = fakeElectron(d)
      const up = new AppUpdater({ app: E.app, shell: E.shell, settings: E.settings, send: () => {}, version: '1.1.1', allowHttp: true,
        pkg: { shiyingUpdate: { manifests: [`${base}/pc-version.json`] } }, platform: 'darwin', arch: 'x64', execPath: '/Applications/拾影.app/Contents/MacOS/拾影' })
      await up.check({ manual: true })
      const r = await up.start()
      assert.equal(r.ok, true, r.error); assert.equal(r.manual, true)
      assert.match(r.message, /没有权限/); assert.match(r.message, /应用程序/)
      const dest = path.join(d, 'Downloads', '拾影新版本-1.2.0', '拾影.app')
      assert.deepEqual(E.calls.showItemInFolder, [dest])
      assert.equal(U.plistValue(fs.readFileSync(path.join(dest, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString'), '1.2.0')
      assert.equal(E.calls.quit, 0)
    } finally { close() }
  } finally { process.env.PATH = oldPath; U.macCanReplace = orig }
})

test('开发模式 / Linux / 低于 minVersion：「立即更新」= 打开下载页', async () => {
  const { base, close } = await server({ '/m.json': json({ ...GOOD }) })
  try {
    const d = tmp(); const E = fakeElectron(d, { isPackaged: false })
    const up = new AppUpdater({ app: E.app, shell: E.shell, settings: E.settings, send: () => {}, version: '1.1.1', pkg: { shiyingUpdate: { manifests: [`${base}/m.json`] } }, platform: 'win32', arch: 'x64' })
    const c = await up.check({ manual: true })
    assert.equal(c.mode, 'manual'); assert.equal(c.dev, true)
    const r = await up.start()
    assert.equal(r.opened, true); assert.deepEqual(E.calls.openExternal, [U.DEFAULT_PAGE])
  } finally { close() }
})

test('macOS 菜单有「检查更新…」', () => {
  const SP = require('../src/core/sysplat')
  let n = 0
  const m = SP.menuTemplate('darwin', { onCheckUpdate: () => n++ })
  const item = m[0].submenu.find(i => i.label === '检查更新…')
  assert.ok(item); item.click(); assert.equal(n, 1)
})
