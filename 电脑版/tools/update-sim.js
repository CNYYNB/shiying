#!/usr/bin/env node
/*
 * 内置更新的本机模拟（Linux 上也能跑，不联网）：本地 HTTP 服务器提供 update/pc-version.json（地址换成本地）和 dist/ 里的真实发布文件，
 * 用 src/core/updater.js 走一遍：读清单（第一个地址故意失败）→ 1.1.1 判断有新版本 → 按系统挑文件 →
 * 下载真实安装包（主地址 404 → 备用地址）→ sha256 / 大小校验 → 取消清理 → 被篡改的文件被拒绝。
 * Mac zip 再解压一次，用更新器的检查函数认出 拾影.app。结果写到 out/update-sim-report.txt。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const U = require(path.join(root, 'src/core/updater'))
const Net = require(path.join(root, 'src/core/net'))
Net.setProxy(null)

const lines = []
let failed = 0
const ok = (c, m) => { lines.push(`${c ? '✓' : '✗'} ${m}`); if (!c) failed++ }

async function main() {
  const real = JSON.parse(fs.readFileSync(path.join(root, 'update', 'pc-version.json'), 'utf8'))
  const dist = path.join(root, 'dist')
  let tamper = false
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0])
    if (u === '/pc-version.json') {
      const m = JSON.parse(JSON.stringify(real))
      for (const pk of ['win', 'mac']) for (const a of Object.values(m[pk])) { a.mirrors = [`${base}/mirror/${a.name}`]; a.url = `${base}/missing/${a.name}` }
      const b = Buffer.from(JSON.stringify(m)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); return res.end(b)
    }
    const m = /^\/mirror\/(Shiying-[^/]+)$/.exec(u)
    if (m && fs.existsSync(path.join(dist, m[1]))) {
      const f = path.join(dist, m[1]); const size = fs.statSync(f).size
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
      const rs = fs.createReadStream(f)
      if (tamper) { let first = true; rs.on('data', c => { if (first) { c = Buffer.from(c); c[100] ^= 1; first = false } res.write(c) }); rs.on('end', () => res.end()); return }
      return rs.pipe(res)
    }
    res.writeHead(404); res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-sim-'))
  lines.push(`拾影内置更新本机模拟  ${new Date().toISOString()}  清单 update/pc-version.json（${real.version}），文件来自 dist/，本地 HTTP 服务器`)
  try {
    const urls = [`${base}/nope.json`, `${base}/pc-version.json`]
    for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
      lines.push('', `== ${platform} ${arch} ==`)
      const c = await U.checkForUpdate({ current: '1.1.1', urls, platform, arch, allowHttp: true, timeout: 3000 })
      ok(c.available && c.manifest.version === real.version && !c.needManual, `1.1.1 → 发现 ${c.manifest.version}（清单来自第二个地址，第一个 404 已跳过）`)
      const same = await U.checkForUpdate({ current: real.version, urls, platform, arch, allowHttp: true, timeout: 3000 })
      ok(!same.available, `${real.version} → 已是最新`)
      const asset = c.asset
      ok(asset && asset.name === real[platform === 'win32' ? 'win' : 'mac'][arch].name, `挑选文件 ${asset.name}（${asset.size} 字节）`)
      const dir = path.join(work, `${platform}-${arch}`)
      const t0 = Date.now()
      let last = null
      const r = await U.downloadAsset(asset, dir, { onProgress: p => { last = p } })
      ok(fs.statSync(r.file).size === asset.size && (await U.sha256File(r.file)) === asset.sha256, `下载并校验通过（主地址 404 → 备用地址，${((Date.now() - t0) / 1000).toFixed(1)} 秒，最后进度 ${last.done}/${last.total}）`)
      if (platform === 'darwin') {
        const ex = path.join(dir, 'extract')
        execFileSync('unzip', ['-q', r.file, '-d', ex], { env: { ...process.env, LANG: 'C.UTF-8' } }) // Mac 上是 ditto -x -k
        const app = U.macFindAndCheckApp(ex, real.version)
        ok(path.basename(app) === '拾影.app', '解压后更新器认出 拾影.app（bundle id com.louis.shiying.pc、版本、主程序）')
      }
      // 取消
      const ctrl = new AbortController()
      const cdir = path.join(work, 'cancel')
      await U.downloadAsset(asset, cdir, { signal: ctrl.signal, onProgress: p => { if (p.done > 5e6) ctrl.abort() } }).then(() => ok(false, '取消没有生效'), e => ok(e.kind === 'cancelled' && fs.readdirSync(cdir).length === 0, `下载到 5 MB 时取消 → 「${e.message}」，没下完的文件已删除`))
      // 篡改
      tamper = true
      const tdir = path.join(work, 'tamper')
      await U.downloadAsset(asset, tdir).then(() => ok(false, '篡改的文件被接受了'), e => ok(e.kind === 'checksum' && fs.readdirSync(tdir).length === 0, `改动 1 个字节 → 「${e.message}」`))
      tamper = false
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } finally { srv.close(); fs.rmSync(work, { recursive: true, force: true }) }
  lines.push('', failed ? `有 ${failed} 项没通过` : '全部通过')
  fs.writeFileSync(path.join(root, 'out', 'update-sim-report.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
