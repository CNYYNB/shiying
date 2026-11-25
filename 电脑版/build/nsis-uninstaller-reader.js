/*
 * 从 electron-builder 生成的“卸载程序生成器”里直接读出卸载程序（不用 wine 运行它）。
 * 和 app-builder-lib 的 UninstallerReader 相同的做法，但支持新版 NSIS（3.08+）stub 里的 .idata / .reloc 等节。
 */
const fs = require('fs')
const zlib = require('zlib')

const SIG = Buffer.from([0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74])

function extract(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("Invalid 'MZ' signature.")
  const pe = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("Invalid 'PE' signature.")
  const nSec = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  let off = pe + 24 + optSize
  let end = 0
  for (let i = 0; i < nSec; i++, off += 40) {
    const rawSize = buf.readUInt32LE(off + 16), rawPtr = buf.readUInt32LE(off + 20)
    if (rawPtr && rawSize) end = Math.max(end, rawPtr + rawSize)
  }
  const exe = buf.subarray(0, end)
  const data = buf.subarray(end)
  if (!data.subarray(4, 20).equals(SIG)) throw new Error('Invalid signature.')
  if (data.readUInt32LE(24) !== data.length) throw new Error('Size mismatch.')
  let pos = 28, inner = null
  while (pos + 4 <= data.length) {
    let size = data.readUInt32LE(pos); pos += 4
    const compressed = (size & 0x80000000) !== 0
    size &= 0x7fffffff
    if (size === 0 || pos + size > data.length) break
    let block = data.subarray(pos, pos + size); pos += size
    if (compressed) block = zlib.inflateRawSync(block)
    if (block.length >= 20 && block.subarray(4, 20).equals(SIG)) {
      if (inner) throw new Error('Multiple inner blocks.')
      inner = block
    }
  }
  if (!inner) throw new Error('Inner block not found.')
  return Buffer.concat([exe, inner])
}

async function exec(installerPath, uninstallerPath) {
  fs.writeFileSync(uninstallerPath, extract(fs.readFileSync(installerPath)))
}

module.exports = { extract, exec }
