#!/usr/bin/env node
/*
 * 构建 macOS 版（Apple 芯片 arm64 + Intel x64），在 Linux 或 macOS 上都能运行：
 *  1. electron-builder 生成 拾影.app（target dir；electron-builder 只禁止在 Windows 上构建 mac）；
 *  2. ad-hoc 签名（没有 Apple Developer ID，不公证）：Linux 上用 rcodesign（apple-codesign，没有证书时就是 ad-hoc），
 *     macOS 上用系统的 `codesign --force --deep -s -`。Apple 芯片要求每个可执行文件至少有 ad-hoc 签名，否则直接被系统杀掉；
 *     改过 Info.plist / 换了 app.asar 以后 Electron 原来的签名已失效，所以必须重签整个 .app（含 Frameworks 和 Helper）；
 *  3. zip -y（保留 Electron Framework 里的符号链接，否则签名失效、体积翻倍）→ dist/Shiying-macOS-<版本>-<arch>.zip（1.2.0 起英文文件名）。
 *     zip 顶层是 拾影.app；内置更新在 Mac 上用 ditto -x -k 解压它。
 * 不生成 .dmg（Linux 上没有可靠的 UDIF 工具）。
 * 用法：node build/build-mac.js [arm64] [x64]   （默认两个都出）
 * rcodesign：先找 PATH / RCODESIGN 环境变量，再找 .cache/rcodesign/，都没有就下载 apple-codesign 0.29.0（GitHub 发布页）。
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const root = path.resolve(__dirname, '..')
process.chdir(root)
process.env.ELECTRON_CACHE ||= path.join(root, '.cache/electron')
process.env.ELECTRON_BUILDER_CACHE ||= path.join(root, '.cache/eb')
const { version } = require(path.join(root, 'package.json'))

const RC_VER = '0.29.0'
function findRcodesign() {
  if (process.env.RCODESIGN && fs.existsSync(process.env.RCODESIGN)) return process.env.RCODESIGN
  try { return execFileSync('sh', ['-c', 'command -v rcodesign'], { encoding: 'utf8' }).trim() || null } catch {}
  const triple = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  const dir = path.join(root, '.cache/rcodesign')
  const bin = path.join(dir, `apple-codesign-${RC_VER}-${triple}`, 'rcodesign')
  if (fs.existsSync(bin)) return bin
  if (process.platform !== 'linux') return null
  console.log(`下载 rcodesign ${RC_VER}（${triple}）…`)
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, `rc-${triple}.tar.gz`)
  execFileSync('curl', ['-fsSL', '-o', tgz, `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RC_VER}/apple-codesign-${RC_VER}-${triple}.tar.gz`], { stdio: 'inherit' })
  execFileSync('tar', ['xzf', tgz, '-C', dir])
  return fs.existsSync(bin) ? bin : null
}

function adhocSign(app) {
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
    return 'codesign -s -（ad-hoc）'
  }
  const rc = findRcodesign()
  if (!rc) throw new Error('找不到 rcodesign，无法 ad-hoc 签名（可设置 RCODESIGN=路径）')
  // 不给证书 = ad-hoc 签名；rcodesign 会从里到外签所有嵌套的 .app / .framework / dylib / 可执行文件。
  // code-signature-flags 不加 runtime（hardened runtime 需要 allow-jit 等 entitlements，ad-hoc 时不需要）
  execFileSync(rc, ['sign', app], { stdio: ['ignore', 'ignore', 'inherit'] })
  return `rcodesign ${RC_VER}（ad-hoc）`
}

function zipApp(dir, appName, out) {
  fs.rmSync(out, { force: true })
  execFileSync('zip', ['-q', '-r', '-y', '-X', out, appName], { cwd: dir, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
}

async function main() {
  const { build, Platform, Arch } = require('electron-builder')
  const archs = process.argv.slice(2).filter(a => ['arm64', 'x64'].includes(a))
  const results = []
  for (const arch of archs.length ? archs : ['arm64', 'x64']) {
    await build({ targets: Platform.MAC.createTarget(['dir'], Arch[arch]), config: require('./config').builderConfig() })
    const outDir = path.join(root, 'dist', arch === 'x64' ? 'mac' : 'mac-' + arch)
    const app = path.join(outDir, '拾影.app')
    if (!fs.existsSync(app)) throw new Error('没有生成 ' + app)
    const signer = adhocSign(app)
    const zip = path.join(root, 'dist', `Shiying-macOS-${version}-${arch}.zip`) // 英文文件名：GitHub Releases / 内置更新清单用
    zipApp(outDir, '拾影.app', zip)
    results.push(`${zip}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB，${signer}）`)
  }
  console.log('完成：\n' + results.join('\n'))
}
main().catch(e => { console.error(e); process.exit(1) })
