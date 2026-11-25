#!/usr/bin/env node
/*
 * 检查 Windows 构建产物（不需要 Windows）：
 *  - 安装包 Shiying-Windows-Setup-<版本>.exe：PE 头 / 图标 / 版本信息；7z 能列出内容（app-64.7z、Uninstall 拾影.exe）；
 *    解出 app-64.7z → 拾影.exe 版本、app.asar 内容（含内置更新）、package.json 版本和清单地址
 *  - 便携版 Shiying-Windows-<版本>-x64-portable.zip：拾影.exe、resources/app.asar
 *  - 大小和 sha256
 * 用法：node tools/win-verify.js   结果写到 out/win-smoke-report.txt（需要 7z）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const asar = require('@electron/asar')
const ResEdit = require('resedit')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const U = require(path.join(root, 'src/core/updater'))
const lines = []
let failed = 0
const ok = (c, m) => { lines.push(`${c ? '✓' : '✗'} ${m}`); if (!c) failed++ }
const sha = f => { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(f)); return h.digest('hex') }

function peInfo(file) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const icons = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).flatMap(g => g.icons)
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  const l = vi && vi.getAllLanguagesForStringValues()[0]
  return { machine: exe.newHeader.fileHeader.machine, icons: icons.length, strings: vi ? vi.getStringValues(l) : {} }
}

function checkAsar(asarPath, label) {
  const files = new Set(asar.listPackage(asarPath).map(f => f.replace(/\\/g, '/')))
  for (const f of ['/package.json', '/src/main/main.js', '/src/main/updater-main.js', '/src/core/updater.js', '/src/renderer/app.js', '/node_modules/undici/index.js'])
    ok(files.has(f), `${label} app.asar 含 ${f}`)
  const apkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString())
  ok(apkg.version === pkg.version, `${label} package.json 版本 ${apkg.version}`)
  const urls = U.manifestUrls(apkg, {})
  ok(urls.length >= 3 && urls.every(u => u.startsWith('https://')), `${label} 内置更新清单地址：${urls.map(u => new URL(u).host).join(' → ')}`)
  const html = asar.extractFile(asarPath, 'src/renderer/index.html').toString()
  ok(/检查更新/.test(html) && /启动时自动检查更新/.test(html), `${label} 菜单有「检查更新」「启动时自动检查更新」`)
}

function main() {
  lines.push(`拾影 ${pkg.version} Windows 构建检查  ${new Date().toISOString()}  （Linux 上静态检查，没有在真 Windows 上安装）`)
  const setup = path.join(root, 'dist', `Shiying-Windows-Setup-${pkg.version}.exe`)
  const portable = path.join(root, 'dist', `Shiying-Windows-${pkg.version}-x64-portable.zip`)
  for (const f of [setup, portable]) {
    if (!fs.existsSync(f)) { ok(false, '找不到 ' + f); continue }
    lines.push('', `== ${path.basename(f)} ==`, `大小 ${fs.statSync(f).size} 字节（${(fs.statSync(f).size / 1048576).toFixed(1)} MB），sha256 ${sha(f)}`)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winv-'))
  if (fs.existsSync(setup)) {
    lines.push('', '-- 安装包 --')
    const pe = peInfo(setup)
    ok(pe.machine === 0x14c || pe.machine === 0x8664, `PE 文件（machine 0x${pe.machine.toString(16)}，NSIS 安装程序本身是 32 位）`)
    ok(pe.icons >= 1, `图标 ${pe.icons} 个`)
    ok(pe.strings.ProductName === '拾影' && pe.strings.ProductVersion === pkg.version, `版本信息 ProductName=${pe.strings.ProductName} ProductVersion=${pe.strings.ProductVersion}`)
    const list = execFileSync('7z', ['l', setup], { encoding: 'utf8' })
    ok(/\$PLUGINSDIR\/app-64\.7z/.test(list), '7z 能列出安装包：含 $PLUGINSDIR/app-64.7z')
    ok(/Uninstall 拾影\.exe/.test(list), '含卸载程序「Uninstall 拾影.exe」（内置更新靠它区分安装版 / 便携版）')
    execFileSync('7z', ['x', '-y', `-o${tmp}/setup`, setup, '$PLUGINSDIR/app-64.7z'], { stdio: 'ignore' })
    execFileSync('7z', ['x', '-y', `-o${tmp}/app`, path.join(tmp, 'setup', '$PLUGINSDIR', 'app-64.7z')], { stdio: 'ignore' })
    const exe = path.join(tmp, 'app', '拾影.exe')
    ok(fs.existsSync(exe), 'app-64.7z 里有 拾影.exe')
    if (fs.existsSync(exe)) {
      const ae = peInfo(exe)
      ok(ae.machine === 0x8664, '拾影.exe 是 x64')
      ok(String(ae.strings.ProductVersion).startsWith(pkg.version) && String(ae.strings.FileVersion).startsWith(pkg.version), `拾影.exe 版本 ${ae.strings.ProductVersion}（FileVersion ${ae.strings.FileVersion}）`)
    }
    checkAsar(path.join(tmp, 'app', 'resources', 'app.asar'), '安装包')
  }
  if (fs.existsSync(portable)) {
    lines.push('', '-- 便携版 --')
    execFileSync('unzip', ['-q', portable, '-d', path.join(tmp, 'portable')], { env: { ...process.env, LANG: 'C.UTF-8' } })
    ok(fs.existsSync(path.join(tmp, 'portable', '拾影.exe')), 'zip 里有 拾影.exe')
    ok(!fs.existsSync(path.join(tmp, 'portable', 'Uninstall 拾影.exe')), '没有卸载程序（内置更新按便携版处理：下载安装包后打开安装界面）')
    checkAsar(path.join(tmp, 'portable', 'resources', 'app.asar'), '便携版')
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  lines.push('', failed ? `有 ${failed} 项没通过` : '全部通过')
  const out = path.join(root, 'out', 'win-smoke-report.txt')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  process.exit(failed ? 1 : 0)
}
main()
