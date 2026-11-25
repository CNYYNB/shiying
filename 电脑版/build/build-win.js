#!/usr/bin/env node
/*
 * 在 Linux（包括 aarch64）上构建 Windows x64 安装包和便携版 zip，不需要 wine：
 *  - makensis 用系统自带的（Debian: apt install nsis），通过 ELECTRON_BUILDER_NSIS_DIR 指给 electron-builder；
 *  - electron-builder 在非 Windows 上默认用 wine 运行一次安装程序来生成卸载程序。这里改用它自带的
 *    UninstallerReader（直接从安装程序里读出卸载程序，macOS 上就是这么做的）。
 * 在 Windows 上直接运行也可以（这两处改动只在非 Windows 生效）。
 * 用法：node build/build-win.js [nsis] [zip] [dir]   （默认 nsis zip）
 */
const path = require('path')
const fs = require('fs')
const root = path.resolve(__dirname, '..')
process.chdir(root)
process.env.ELECTRON_CACHE ||= path.join(root, '.cache/electron')
process.env.ELECTRON_BUILDER_CACHE ||= path.join(root, '.cache/eb')

async function prepareLinuxNsis() {
  const sys = ['/usr/bin/makensis', '/usr/local/bin/makensis', '/opt/homebrew/bin/makensis'].find(p => fs.existsSync(p))
  if (!sys) { console.error('需要系统 makensis：sudo apt install nsis（或 brew install makensis）'); process.exit(1) }
  const dir = path.join(root, '.cache/nsis-sys')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'makensis'), `#!/bin/sh\nexec ${sys} "$@"\n`, { mode: 0o755 })
  // electron-builder 还要从同一目录拿 elevate.exe（Windows 程序，只是被打包进安装程序）：从它自己的 NSIS 包里复制
  const elevate = path.join(dir, 'elevate.exe')
  const find = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r } else if (e.name === 'elevate.exe') return p } }
  if (!fs.existsSync(elevate)) {
    let src = find(process.env.ELECTRON_BUILDER_CACHE)
    if (!src) {
      console.log('下载 electron-builder 的 NSIS 包（只为取得 elevate.exe）…')
      await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath(undefined, undefined)
      src = find(process.env.ELECTRON_BUILDER_CACHE)
    }
    if (!src) throw new Error('找不到 elevate.exe，请手动放一个到 ' + dir)
    fs.copyFileSync(src, elevate)
  }
  process.env.ELECTRON_BUILDER_NSIS_DIR = dir
  // 卸载程序：直接从生成器 exe 里读出（不用 wine 运行它）
  require('app-builder-lib/out/util/macosVersion').isMacOsCatalina = () => true
  require('app-builder-lib/out/targets/nsis/nsisUtil').UninstallerReader.exec = require('./nsis-uninstaller-reader').exec
}

const { build, Platform, Arch } = require('electron-builder')
const targets = process.argv.slice(2).filter(a => !a.startsWith('-'))
Promise.resolve(process.platform !== 'win32' && (targets.length === 0 || targets.includes('nsis')) ? prepareLinuxNsis() : null)
  .then(() => build({ targets: Platform.WINDOWS.createTarget(targets.length ? targets : ['nsis', 'zip'], Arch.x64), config: 'electron-builder.yml' }))
  .then(files => { console.log('完成：\n' + files.join('\n')) })
  .catch(e => { console.error(e); process.exit(1) })
