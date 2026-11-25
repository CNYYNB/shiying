#!/usr/bin/env node
/*
 * 生成内置更新清单 update/pc-version.json（拾影电脑版 1.2.0 起）。
 *
 * 用法：
 *   node tools/make-pc-manifest.js [--version 1.2.0] [--tag pc-1.2.0] [--dist dist] [--out update/pc-version.json]
 *        [--repo CNYYNB/shiying] [--mirror https://xxx.r2.dev/pc-1.2.0/]… [--min-version 1.2.0] [--date 2026-11-25]
 *   默认：版本 = package.json，tag = pc-<版本>。
 *
 * 读取 dist/ 里的发布文件（必须都在），算 sha256 和大小：
 *   Shiying-Windows-Setup-<版本>.exe   → win.x64
 *   Shiying-macOS-<版本>-arm64.zip     → mac.arm64
 *   Shiying-macOS-<版本>-x64.zip       → mac.x64
 * 主地址：https://github.com/<repo>/releases/download/<tag>/<文件名>；每个 --mirror 前缀 + 文件名 是备用地址（按顺序）。
 * 更新说明：tools/notes-pc-<版本>.txt（必须有）。写出前用 src/core/updater.js 的 parseManifest 校验一遍。
 * 不联网、不上传任何东西。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const root = path.resolve(__dirname, '..')
const U = require(path.join(root, 'src/core/updater'))

function args(argv) {
  const o = { mirror: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2), v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error('缺少参数值：' + a)
    if (k === 'mirror') o.mirror.push(v); else o[k] = v
    i++
  }
  return o
}

const assetNames = v => ({
  win: { x64: `Shiying-Windows-Setup-${v}.exe` },
  mac: { arm64: `Shiying-macOS-${v}-arm64.zip`, x64: `Shiying-macOS-${v}-x64.zip` },
})

function sha256(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(4 << 20)
  let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  fs.closeSync(fd)
  return h.digest('hex')
}

function makeManifest(o) {
  const version = o.version || require(path.join(root, 'package.json')).version
  if (!U.isSemver(version)) throw new Error('版本号格式不对：' + version)
  const tag = o.tag || `pc-${version}`
  const repo = o.repo || 'CNYYNB/shiying'
  const dist = path.resolve(root, o.dist || 'dist')
  const notesFile = path.join(root, 'tools', `notes-pc-${version}.txt`)
  if (!fs.existsSync(notesFile)) throw new Error('缺少更新说明：' + path.relative(root, notesFile))
  const notes = fs.readFileSync(notesFile, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  for (const m of o.mirror) if (!/^https:\/\/.+\/$/.test(m)) throw new Error('--mirror 要是以 / 结尾的 https 前缀：' + m)
  const date = o.date || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) // 北京时间日期
  const out = { schema: 1, version, date, notes, page: 'https://shiying-louis.pages.dev/' }
  if (o['min-version']) out.minVersion = o['min-version']
  for (const [pk, table] of Object.entries(assetNames(version))) {
    out[pk] = {}
    for (const [arch, name] of Object.entries(table)) {
      const file = path.join(dist, name)
      if (!fs.existsSync(file)) throw new Error('找不到发布文件：' + file)
      const enc = encodeURIComponent(name)
      out[pk][arch] = {
        name,
        url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${enc}`,
        mirrors: o.mirror.map(m => m + enc),
        sha256: sha256(file),
        size: fs.statSync(file).size,
      }
    }
  }
  U.parseManifest(JSON.stringify(out)) // 和客户端用同一个校验
  return out
}

if (require.main === module) {
  try {
    const o = args(process.argv.slice(2))
    const m = makeManifest(o)
    const outFile = path.resolve(root, o.out || 'update/pc-version.json')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(m, null, 2) + '\n')
    console.log(`已写出 ${path.relative(root, outFile)}（版本 ${m.version}）`)
    for (const pk of ['win', 'mac']) for (const [arch, a] of Object.entries(m[pk])) console.log(`  ${pk}.${arch}  ${a.name}  ${a.size} 字节  sha256 ${a.sha256}`)
  } catch (e) { console.error('生成失败：' + e.message); process.exit(1) }
}

module.exports = { makeManifest, assetNames }
