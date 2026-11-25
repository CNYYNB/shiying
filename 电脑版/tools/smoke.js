#!/usr/bin/env node
/*
 * 联网冒烟测试（不需要 Electron）：真实网站 + 真实 yt-dlp。
 *   node tools/smoke.js [binDir]            只解析
 *   SHIYING_SMOKE_DL=1 node tools/smoke.js   另外下载第一个成功的原生视频和 yt-dlp 视频（会用 ffmpeg 合并）
 * binDir 默认 ./.cache/smoke-bin；缺组件时先按应用里的方式下载（多镜像）。
 * 结果写到 out/smoke-report.txt。网络失败（地区 / IP 限制）是预期内的，记录下来即可。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Tools } = require('../src/core/tools')
const { Engine } = require('../src/core/engine')
const Extractor = require('../src/core/extractor')
const D = require('../src/core/downloader')
const { execFileSync } = require('child_process')

const binDir = process.argv[2] || path.join(__dirname, '..', '.cache', 'smoke-bin')
const outDir = path.join(__dirname, '..', 'out')
const INPUTS = [
  ['抖音（ID）', '7578030072632839465'],
  ['抖音（分享文字）', '7.43 复制打开抖音，看看【小轨的作品】过年啦！ https://v.douyin.com/f-QpBB_oD9Y/ x@F.ub'],
  ['快手', 'https://www.kuaishou.com/short-video/3xqensd76nig6nw'],
  ['小红书', 'https://www.xiaohongshu.com/explore/6a6310ee000000001003f430'],
  ['TikTok', 'https://www.tiktok.com/@zachking/video/6768504823336815877'],
  ['X', 'https://x.com/SpaceX/status/1732824684683784516'],
  ['B站', 'https://www.bilibili.com/video/BV1GJ411x7h7/'],
  ['YouTube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['Vimeo', 'https://vimeo.com/76979871'],
]

async function main() {
  const report = [`拾影电脑版冒烟测试 ${new Date().toISOString()} · ${process.platform}/${process.arch} · 代理 ${process.env.HTTPS_PROXY ? '有' : '无'}`]
  const say = s => { console.log(s); report.push(s) }
  const tools = new Tools(binDir)
  const t0 = Date.now()
  const r = await tools.ensure(p => { if (p.total && p.done === p.total) say(`  组件 ${p.name} 下载完成（${p.source}，${(p.total / 1e6).toFixed(1)} MB）`) })
  say(`组件：${JSON.stringify(tools.status())} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.denoError ? 'Deno 失败：' + r.denoError : ''}`)
  say(`yt-dlp ${await tools.version('ytdlp')} · ffmpeg ${await tools.version('ffmpeg')} · deno ${await tools.version('deno')}`)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiying-smoke-'))
  const engine = new Engine({ tools, dataDir })
  const dl = process.env.SHIYING_SMOKE_DL === '1'
  let didNative = false, didYt = false
  for (const [name, text] of INPUTS) {
    const t = Date.now()
    try {
      const route = await Extractor.route(text, () => {})
      let post = route.post
      if (route.type === 'ytdlp') post = await engine.info(route.url, route.platform, '720', null, { log: () => {} })
      say(`✓ ${name}：${post.engine} · 「${post.title.slice(0, 30)}」 @${post.author} · ${post.isImages ? post.images.length + ' 张图' : (post.height || Object.values(post.heights || {})[0] || '?') + 'p'} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
      if (dl && post.engine === 'native' && !didNative && !post.isImages) {
        didNative = true
        const dir = path.join(dataDir, 'save'); fs.mkdirSync(dir, { recursive: true })
        const files = await D.downloadNative(post, dir, '720', {})
        say(`  ↳ 原生下载：${files.map(f => path.basename(f) + ' ' + (fs.statSync(f).size / 1e6).toFixed(2) + ' MB').join(', ')} ${probe(tools, files[0])}`)
      }
      if (dl && post.engine === 'ytdlp' && !didYt) {
        didYt = true
        const tmp = path.join(dataDir, 'tmp'); const dir = path.join(dataDir, 'save')
        let last = 0
        const raw = await engine.download(post, tmp, '480', null, { onProgress: p => { last = p.pct } })
        const files = D.moveYtdlpFiles(raw, post, dir)
        say(`  ↳ yt-dlp 下载 + 合并：${files.map(f => path.basename(f) + ' ' + (fs.statSync(f).size / 1e6).toFixed(2) + ' MB').join(', ')}（最后进度 ${last}%）${probe(tools, files[0])}`)
      }
    } catch (e) {
      say(`✗ ${name}：${e.name}：${String(e.message).split('\n').slice(0, 3).join(' / ')} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
    }
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'smoke-report.txt'), report.join('\n') + '\n')
  console.log('报告：out/smoke-report.txt')
  process.exit(0)
}

function probe(tools, f) {
  try {
    const out = execFileSync(tools.ffmpegPath, ['-hide_banner', '-i', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    return out
  } catch (e) {
    const s = String(e.stderr || '')
    const v = (s.match(/Video: (\w+)[^\n]*?(\d{2,5}x\d{2,5})/) || []).slice(1).join(' ')
    const a = (s.match(/Audio: (\w+)/) || [])[1]
    return `[ffmpeg 检查：视频 ${v || '无'}，音频 ${a || '无'}]`
  }
}

main().catch(e => { console.error(e); process.exit(1) })
