#!/usr/bin/env node
/*
 * 由 build/icon-512.png（安卓版 docs/icon-512.png，和 Windows 版同一个图标）生成 macOS 图标 build/icon.icns。
 * 需要 ImageMagick（convert）。ICNS 里每个尺寸存一张 PNG：
 *   icp4 16 · icp5 32 · icp6 64 · ic07 128 · ic08 256 · ic09 512 · ic11 32（16@2x）· ic12 64（32@2x）· ic13 256（128@2x）· ic14 512（256@2x）
 * 源图只有 512 px，所以不放 ic10（1024 = 512@2x），系统会用 512 那张。
 * 用法：node build/make-icns.js [源图]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const src = path.resolve(process.argv[2] || path.join(__dirname, 'icon-512.png'))
const out = path.join(__dirname, 'icon.icns')
const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icns-'))
const cache = {}
const chunks = types.map(([t, px]) => {
  if (!cache[px]) {
    const f = path.join(tmp, px + '.png')
    execFileSync('convert', [src, '-background', 'none', '-resize', `${px}x${px}`, '-strip', `PNG32:${f}`])
    cache[px] = fs.readFileSync(f)
  }
  const head = Buffer.alloc(8); head.write(t, 0, 'ascii'); head.writeUInt32BE(cache[px].length + 8, 4)
  return Buffer.concat([head, cache[px]])
})
const body = Buffer.concat(chunks)
const head = Buffer.alloc(8); head.write('icns', 0, 'ascii'); head.writeUInt32BE(body.length + 8, 4)
fs.writeFileSync(out, Buffer.concat([head, body]))
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`icon.icns 已生成（${types.length} 个尺寸，${fs.statSync(out).size} 字节）`)
