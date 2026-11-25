#!/usr/bin/env node
/*
 * 检查 macOS 构建产物（不需要 Mac）：解压 dist/拾影-<版本>-mac-<arch>.zip，检查
 *  - Info.plist：CFBundleIdentifier、版本、CFBundleDisplayName 拾影、LSMinimumSystemVersion、图标、ElectronAsarIntegrity 与 app.asar 头一致
 *  - app.asar 内容：主进程、界面、sysplat / tools（含 mac 下载来源）、依赖、package.json 版本
 *  - 主程序 / Helper / Framework 的 CPU 架构
 *  - 每个 Mach-O 文件都有 ad-hoc 签名，且没有 hardened runtime 标志（rcodesign print-signature-info）
 *  - zip 里保留了符号链接
 * 用法：node tools/mac-verify.js [arm64] [x64]   结果写到 out/mac-smoke-report.txt
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const RC = process.env.RCODESIGN || [path.join(root, '.cache/rcodesign/apple-codesign-0.29.0-aarch64-unknown-linux-musl/rcodesign'), path.join(root, '.cache/rcodesign/apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign')].find(p => fs.existsSync(p))
const CPU = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' }

const lines = []
let failed = 0
const ok = (cond, msg) => { lines.push(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

function plistGet(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m ? m[1] : null
}

function machoArchs(file) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4096); fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd)
  if (b.readUInt32BE(0) === 0xcafebabe) { const n = b.readUInt32BE(4); return Array.from({ length: n }, (_, i) => CPU[b.readUInt32BE(8 + i * 20)] || 'cpu?') }
  if (b.readUInt32LE(0) === 0xfeedfacf) return [CPU[b.readUInt32LE(4)] || 'cpu?']
  return null
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}

function verify(arch) {
  const zip = path.join(root, 'dist', `拾影-${pkg.version}-mac-${arch}.zip`)
  lines.push('', `== ${path.basename(zip)} ==`)
  if (!fs.existsSync(zip)) { ok(false, '找不到 ' + zip); return }
  const data = fs.readFileSync(zip)
  lines.push(`大小 ${data.length} 字节（${(data.length / 1048576).toFixed(1)} MB），sha256 ${crypto.createHash('sha256').update(data).digest('hex')}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macv-'))
  execFileSync('unzip', ['-q', zip, '-d', tmp], { env: { ...process.env, LANG: 'C.UTF-8' } })
  const app = path.join(tmp, '拾影.app')
  ok(fs.existsSync(app), 'zip 顶层是 拾影.app')
  const C = path.join(app, 'Contents')
  const plist = fs.readFileSync(path.join(C, 'Info.plist'), 'utf8')
  ok(plistGet(plist, 'CFBundleIdentifier') === 'com.louis.shiying.pc', 'CFBundleIdentifier = com.louis.shiying.pc')
  ok(plistGet(plist, 'CFBundleShortVersionString') === pkg.version, `CFBundleShortVersionString = ${pkg.version}`)
  ok(plistGet(plist, 'CFBundleVersion') === pkg.version, `CFBundleVersion = ${pkg.version}`)
  ok(plistGet(plist, 'CFBundleDisplayName') === '拾影', 'CFBundleDisplayName = 拾影')
  ok(plistGet(plist, 'CFBundleName') === '拾影', 'CFBundleName = 拾影')
  ok(plistGet(plist, 'CFBundleExecutable') === '拾影' && fs.existsSync(path.join(C, 'MacOS', '拾影')), 'CFBundleExecutable = 拾影（文件存在）')
  ok(plistGet(plist, 'LSMinimumSystemVersion') === '12.0', 'LSMinimumSystemVersion = 12.0')
  const icon = plistGet(plist, 'CFBundleIconFile')
  ok(icon && fs.readFileSync(path.join(C, 'Resources', icon)).subarray(0, 4).toString() === 'icns', `图标 ${icon}（icns）`)
  // asar
  const asarPath = path.join(C, 'Resources', 'app.asar')
  const hdr = asar.getRawHeader(asarPath)
  const integ = /<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>([0-9a-f]{64})<\/string>/.exec(plist)
  ok(integ && integ[1] === crypto.createHash('sha256').update(hdr.headerString).digest('hex'), 'ElectronAsarIntegrity 与 app.asar 头一致')
  const files = new Set(asar.listPackage(asarPath).map(f => f.replace(/\\/g, '/')))
  for (const f of ['/package.json', '/src/main/main.js', '/src/main/preload.js', '/src/main/cookies.js', '/src/main/webcapture.js', '/src/renderer/index.html', '/src/renderer/app.js', '/src/renderer/icon.png', '/src/core/sysplat.js', '/src/core/tools.js', '/src/core/engine.js', '/src/core/telegram.js', '/node_modules/telegram/index.js', '/node_modules/undici/index.js', '/node_modules/yauzl/index.js', '/node_modules/big-integer/BigInteger.js'])
    ok(files.has(f), 'app.asar 含 ' + f)
  ok(![...files].some(f => f.startsWith('/test/') || f.startsWith('/build/') || f.startsWith('/dist/')), 'app.asar 不含 test / build / dist')
  const apkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString())
  ok(apkg.version === pkg.version && apkg.main === 'src/main/main.js', `asar 里 package.json 版本 ${apkg.version}，main ${apkg.main}`)
  const toolsJs = asar.extractFile(asarPath, 'src/core/tools.js').toString()
  ok(/yt-dlp_macos/.test(toolsJs) && /ffmpeg-darwin-arm64\.gz/.test(toolsJs) && /apple-darwin/.test(toolsJs) && /com\.apple\.quarantine/.test(toolsJs), 'tools.js 含 macOS 组件来源与去隔离属性')
  ok(/menuTemplate/.test(asar.extractFile(asarPath, 'src/main/main.js').toString()), 'main.js 使用 macOS 菜单')
  ok(fs.existsSync(path.join(C, 'Resources', 'LICENSE.txt')) && fs.existsSync(path.join(C, 'Resources', 'NOTICE.md')), 'Resources 含 LICENSE.txt / NOTICE.md')
  // 架构
  const want = arch === 'arm64' ? 'arm64' : 'x86_64'
  for (const rel of ['MacOS/拾影', 'Frameworks/拾影 Helper.app/Contents/MacOS/拾影 Helper', 'Frameworks/拾影 Helper (Renderer).app/Contents/MacOS/拾影 Helper (Renderer)', 'Frameworks/拾影 Helper (GPU).app/Contents/MacOS/拾影 Helper (GPU)', 'Frameworks/拾影 Helper (Plugin).app/Contents/MacOS/拾影 Helper (Plugin)', 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework'])
    ok(JSON.stringify(machoArchs(path.join(C, rel))) === JSON.stringify([want]), `${rel}：${want}`)
  // 符号链接
  const cur = path.join(C, 'Frameworks/Electron Framework.framework/Versions/Current')
  ok(fs.lstatSync(cur).isSymbolicLink() && fs.readlinkSync(cur) === 'A', 'Electron Framework 的 Versions/Current 是符号链接（zip 保留了符号链接）')
  // 签名
  if (!RC) { ok(false, '没有 rcodesign，跳过签名检查'); return }
  const machos = walk(app).filter(f => machoArchs(f))
  let signed = 0, runtime = 0
  const bad = []
  for (const f of machos) {
    const info = execFileSync(RC, ['print-signature-info', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const flags = [...info.matchAll(/^\s*flags: CodeSignatureFlags\(([^)]*)\)/gm)].map(m => m[1])
    if (flags.length && flags.every(x => /ADHOC/.test(x))) signed++; else bad.push(path.relative(app, f))
    if (flags.some(x => /RUNTIME/.test(x))) runtime++
  }
  ok(bad.length === 0, `${machos.length} 个 Mach-O 文件都有 ad-hoc 签名${bad.length ? '；没有：' + bad.join(', ') : ''}`)
  ok(runtime === 0, '没有 hardened runtime 标志（ad-hoc 时不需要 JIT entitlements）')
  const main = execFileSync(RC, ['print-signature-info', path.join(C, 'MacOS', '拾影')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  ok(/identifier: com\.louis\.shiying\.pc\b/.test(main) && /Info \(1\)|slot: Info/.test(main) && /ResourceDir|Resources \(3\)|slot: ResourceDir/.test(main), '主程序签名绑定 Info.plist 和 _CodeSignature/CodeResources')
  ok(fs.existsSync(path.join(C, '_CodeSignature', 'CodeResources')), 'Contents/_CodeSignature/CodeResources 存在')
  fs.rmSync(tmp, { recursive: true, force: true })
}

const archs = process.argv.slice(2).filter(a => ['arm64', 'x64'].includes(a))
lines.push(`拾影 ${pkg.version} macOS 构建检查  ${new Date().toISOString()}  （Linux 上静态检查，没有在真 Mac 上运行）`)
for (const a of archs.length ? archs : ['arm64', 'x64']) verify(a)
lines.push('', failed ? `✗ ${failed} 项不通过` : '✓ 全部通过')
const report = lines.join('\n') + '\n'
fs.mkdirSync(path.join(root, 'out'), { recursive: true })
fs.writeFileSync(path.join(root, 'out', 'mac-smoke-report.txt'), report)
process.stdout.write(report)
process.exit(failed ? 1 : 0)
