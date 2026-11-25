'use strict'
/**
 * 拾影电脑版内置更新（1.2.0）：纯 Node，不依赖 Electron，单元测试直接跑。Electron 部分见 src/main/updater-main.js。
 *
 * 流程：
 *  1. 按顺序从几个镜像读 pc-version.json（每个 6 秒超时；默认 Cloudflare Pages → raw.githubusercontent → jsDelivr，
 *     列表来自 package.json 的 shiyingUpdate.manifests，构建时可用 SHIYING_UPDATE_MANIFESTS 覆盖）。
 *  2. 校验清单（版本号、https、sha256、大小），按系统 / 架构挑安装文件，和当前版本做 semver 比较。
 *  3. 下载：url → mirrors 依次尝试，先写 .part，边下边算 sha256，大小和 sha256 都对才改名；取消 / 失败删除 .part。
 *  4. 安装（由 updater-main.js 调用）：
 *     - Windows 安装版：NSIS 安装包 `/S --updated --force-run`（静默升级，沿用原安装位置和“仅为我 / 所有用户”，完成后自动重新打开拾影）；
 *       便携版：打开安装包（普通安装界面）。
 *     - macOS：ditto -x -k 解压 → 检查 bundle id / 版本 → xattr -cr → 退出后由一个小 shell 脚本替换 .app 并重新打开；
 *       没有写入权限（/Applications 属于别的用户、App Translocation、只读磁盘）时，把新版放到「下载」里并在访达中显示。
 *       不用 Squirrel.Mac / electron-updater：它们要求 Developer ID 签名，拾影只有 ad-hoc 签名。
 * 网络请求走 Net.getDispatcher（系统代理 / PAC / HTTPS_PROXY，和解析、引擎下载一样）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { Readable, Transform } = require('stream')
const { fetch } = require('undici')
const Net = require('./net')

const APP_ID = 'com.louis.shiying.pc'

/** 默认清单地址（与 package.json 的 shiyingUpdate.manifests 相同；那里优先） */
const DEFAULT_MANIFESTS = [
  'https://shiying-louis.pages.dev/pc-version.json',
  'https://raw.githubusercontent.com/CNYYNB/shiying/main/' + encodeURIComponent('电脑版') + '/update/pc-version.json',
  'https://fastly.jsdelivr.net/gh/CNYYNB/shiying@main/' + encodeURIComponent('电脑版') + '/update/pc-version.json',
]
const DEFAULT_PAGE = 'https://shiying-louis.pages.dev/'
const CHECK_INTERVAL = 6 * 3600e3

// ------------------------------------------------------------------ errors

/** kind: cancelled | timeout | blocked | http404 | http | checksum | size | disk | perm | manifest | install | other */
class UpdateError extends Error {
  constructor(kind, message, detail) { super(message); this.name = 'UpdateError'; this.kind = kind; this.detail = detail || '' }
}
const VPN_HINT = '国内网络访问 GitHub 常被拦截，建议开启 VPN / 代理后再试'

/** 任意异常 → UpdateError（中文） */
function classify(e) {
  if (e instanceof UpdateError) return e
  const code = String(e?.code || e?.cause?.code || '')
  const msg = String(e?.message || '') + ' ' + String(e?.cause?.message || '')
  if (e?.name === 'AbortError' && e?.cancelled) return new UpdateError('cancelled', '已取消')
  if (e?.httpStatus === 404) return new UpdateError('http404', '更新文件不存在（HTTP 404），可能新版本还在上传，请稍后再试', msg)
  if (e?.httpStatus) return new UpdateError('http', `更新服务器返回错误（HTTP ${e.httpStatus}），请稍后再试`, msg)
  if (/ENOSPC/.test(code) || /ENOSPC/.test(msg)) return new UpdateError('disk', '磁盘空间不足，无法下载更新，请清理后再试', msg)
  if (/EACCES|EPERM|EROFS/.test(code)) return new UpdateError('perm', '没有写入权限，无法保存更新文件', msg)
  if (e?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code) || /timed? ?out|超时|卡住/i.test(msg))
    return new UpdateError('timeout', '连接超时：更新服务器没有响应。' + VPN_HINT, msg)
  if (/ENOTFOUND|EAI_AGAIN/.test(code) || /getaddrinfo/.test(msg)) return new UpdateError('blocked', '无法连接更新服务器（域名解析失败），网络可能被拦截。' + VPN_HINT, msg)
  if (/ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|CERT|TLS|SSL/i.test(code) || /socket|ssl|tls|certificate|other side closed/i.test(msg))
    return new UpdateError('blocked', '网络被拦截或无法连接更新服务器。' + VPN_HINT, msg)
  return new UpdateError('other', '更新失败：' + (String(e?.message || e).slice(0, 120)), msg)
}

/** 多个来源都失败时挑最有用的一个说 */
const KIND_RANK = ['checksum', 'size', 'disk', 'perm', 'manifest', 'http404', 'timeout', 'blocked', 'http', 'other']
function pickError(errs) {
  if (!errs.length) return new UpdateError('other', '更新失败')
  const sorted = [...errs].sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind))
  const best = sorted[0]
  const e = new UpdateError(best.kind, best.message + (errs.length > 1 ? `（已尝试 ${errs.length} 个地址）` : ''), errs.map(x => `${x.source || ''} ${x.kind}: ${x.detail || x.message}`.trim()).join('\n'))
  return e
}

// ------------------------------------------------------------------ semver

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function parseSemver(v) {
  const m = SEMVER.exec(String(v || '').trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function isSemver(v) { return !!parseSemver(v) }
/** semver 比较：a < b → -1，相等 → 0，a > b → 1（预发布版本低于正式版；构建元数据忽略）。不合法抛错 */
function cmpSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b)
  if (!x || !y) throw new Error(`版本号格式不对：${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1 } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

// ------------------------------------------------------------------ manifest

const PLATFORM_KEY = { win32: 'win', darwin: 'mac' }

function checkAsset(a, where, allowHttp) {
  if (!a || typeof a !== 'object') throw new UpdateError('manifest', `更新信息格式不对：缺少 ${where}`)
  const urls = [a.url, ...(Array.isArray(a.mirrors) ? a.mirrors : [])]
  for (const u of urls) {
    let p
    try { p = new URL(u) } catch { throw new UpdateError('manifest', `更新信息格式不对：${where} 的地址不是完整网址`) }
    if (!(p.protocol === 'https:' || (allowHttp && p.protocol === 'http:'))) throw new UpdateError('manifest', `更新信息格式不对：${where} 的地址必须是 https`)
  }
  if (!/^[0-9a-f]{64}$/i.test(String(a.sha256 || ''))) throw new UpdateError('manifest', `更新信息格式不对：${where} 没有正确的 sha256`)
  if (!Number.isSafeInteger(a.size) || a.size <= 0) throw new UpdateError('manifest', `更新信息格式不对：${where} 没有正确的文件大小`)
  return {
    url: a.url, mirrors: urls.slice(1), sha256: String(a.sha256).toLowerCase(), size: a.size,
    name: a.name || decodeURIComponent(path.posix.basename(new URL(a.url).pathname)),
  }
}

/**
 * 校验并整理 pc-version.json：
 * { version, notes, date?, minVersion?, page?, win: { x64: Asset }, mac: { arm64: Asset, x64: Asset } }
 * Asset = { url, mirrors?: [], sha256, size, name? }。notes 可以是字符串或字符串数组。
 */
function parseManifest(input, { allowHttp = false } = {}) {
  let m = input
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const s = String(input).replace(/^\uFEFF/, '')
    try { m = JSON.parse(s) } catch { throw new UpdateError('manifest', '更新信息格式不对（不是 JSON），可能被网络拦截页替换了') }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new UpdateError('manifest', '更新信息格式不对')
  if (!isSemver(m.version)) throw new UpdateError('manifest', '更新信息格式不对：版本号不对')
  if (m.minVersion != null && !isSemver(m.minVersion)) throw new UpdateError('manifest', '更新信息格式不对：minVersion 不对')
  const notes = Array.isArray(m.notes) ? m.notes.map(String).join('\n') : String(m.notes || '')
  const out = { version: String(m.version).replace(/^v/, ''), notes, date: m.date ? String(m.date) : '', minVersion: m.minVersion ? String(m.minVersion).replace(/^v/, '') : null, page: DEFAULT_PAGE, win: {}, mac: {} }
  if (m.page) { try { const u = new URL(m.page); if (u.protocol === 'https:') out.page = u.toString() } catch {} }
  for (const pk of ['win', 'mac']) {
    if (m[pk] == null) continue
    if (typeof m[pk] !== 'object') throw new UpdateError('manifest', `更新信息格式不对：${pk}`)
    for (const [arch, a] of Object.entries(m[pk])) out[pk][arch] = checkAsset(a, `${pk}.${arch}`, allowHttp)
  }
  if (!Object.keys(out.win).length && !Object.keys(out.mac).length) throw new UpdateError('manifest', '更新信息里没有任何安装文件')
  return out
}

/** 本机用哪个文件：Windows 只有 x64（arm64 Windows 用 x64 模拟）；Mac 按芯片，没有 arm64 时退回 x64（Rosetta）。没有 → null */
function pickAsset(manifest, platform = process.platform, arch = process.arch) {
  const pk = PLATFORM_KEY[platform]
  if (!pk) return null
  const table = manifest[pk] || {}
  if (table[arch]) return { ...table[arch], arch, emulated: false }
  if (arch === 'arm64' && table.x64) return { ...table.x64, arch: 'x64', emulated: true }
  return null
}

/** 清单地址列表：环境变量 SHIYING_UPDATE_MANIFESTS（逗号分隔）> package.json shiyingUpdate.manifests > 默认 */
function manifestUrls(pkg = {}, env = process.env) {
  const fromEnv = String(env.SHIYING_UPDATE_MANIFESTS || '').split(/[,\s]+/).filter(Boolean)
  if (fromEnv.length) return fromEnv
  const fromPkg = pkg && pkg.shiyingUpdate && Array.isArray(pkg.shiyingUpdate.manifests) ? pkg.shiyingUpdate.manifests.filter(u => typeof u === 'string' && u) : []
  return fromPkg.length ? fromPkg : [...DEFAULT_MANIFESTS]
}

const UA = 'Shiying-PC-Updater'

async function getJson(url, { timeout, signal }) {
  const sig = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
  const r = await fetch(url, { dispatcher: await Net.getDispatcher(url), signal: sig, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/json', 'Cache-Control': 'no-cache' } })
  if (!r.ok) { await r.body?.cancel().catch(() => {}); const e = new Error(`HTTP ${r.status}`); e.httpStatus = r.status; throw e }
  const len = Number(r.headers.get('content-length')) || 0
  if (len > 512 * 1024) { await r.body?.cancel().catch(() => {}); throw new UpdateError('manifest', '更新信息文件太大，不像正确的文件') }
  const text = await r.text()
  if (text.length > 512 * 1024) throw new UpdateError('manifest', '更新信息文件太大，不像正确的文件')
  return text
}

/** 按顺序读清单，第一个读到且格式正确的为准。返回 { manifest, source, errors[] } */
async function fetchManifest(urls, { timeout = 6000, signal, allowHttp = false, log = () => {} } = {}) {
  const errs = []
  for (const url of urls) {
    if (signal?.aborted) throw new UpdateError('cancelled', '已取消')
    try {
      const manifest = parseManifest(await getJson(url, { timeout, signal }), { allowHttp })
      return { manifest, source: url, errors: errs }
    } catch (e) {
      if (signal?.aborted) throw new UpdateError('cancelled', '已取消')
      const ue = classify(e); ue.source = hostOf(url); errs.push(ue)
      log(`清单 ${hostOf(url)} 失败：${ue.kind} ${ue.detail || ue.message}`)
    }
  }
  const e = pickError(errs)
  e.message = '检查更新失败：' + e.message
  throw e
}

function hostOf(u) { try { return new URL(u).host } catch { return String(u).slice(0, 40) } }

/**
 * 检查更新。返回 { available, current, manifest, asset, source, needManual }。
 * needManual：当前版本低于 minVersion（新版不能从这个版本直接内置更新，要去主页下载完整安装包）或本机没有对应文件。
 */
async function checkForUpdate({ current, urls, platform = process.platform, arch = process.arch, timeout, signal, allowHttp, log } = {}) {
  const { manifest, source } = await fetchManifest(urls, { timeout, signal, allowHttp, log })
  const available = cmpSemver(manifest.version, current) > 0
  const asset = pickAsset(manifest, platform, arch)
  const belowMin = !!(manifest.minVersion && cmpSemver(current, manifest.minVersion) < 0)
  return { available, current, manifest, asset, source, needManual: available && (belowMin || !asset), belowMin }
}

// ------------------------------------------------------------------ download

async function sha256File(p) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(p), h)
  return h.digest('hex')
}

function rmQuiet(p) { for (let i = 0; i < 3; i++) { try { fs.rmSync(p, { force: true, recursive: true }); return } catch {} } }

/** 只保留安全的文件名字符 */
function safeName(n) { return String(n || 'update.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 120) }

/**
 * 下载安装文件到 dir。asset = pickAsset 的结果。依次尝试 url、mirrors；每个地址：
 * 先写 <文件>.part，超过声明大小立即停；下完后大小、sha256 都对才改名。sha256 不对的地址换下一个。
 * 已经下好且校验正确的文件直接复用。取消 → UpdateError('cancelled')，.part 一定删掉。
 * onProgress({ done, total, speed, source })
 */
async function downloadAsset(asset, dir, { signal, onProgress = () => {}, stallMs = 30_000, log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, safeName(asset.name))
  const part = dest + '.part'
  if (fs.existsSync(dest)) {
    try {
      if (fs.statSync(dest).size === asset.size && await sha256File(dest) === asset.sha256) { onProgress({ done: asset.size, total: asset.size, speed: 0, source: '已下载' }); return { file: dest, cached: true } }
    } catch {}
    rmQuiet(dest)
  }
  const errs = []
  for (const url of [asset.url, ...(asset.mirrors || [])]) {
    if (signal?.aborted) break
    try {
      await downloadOne(url, part, asset, { signal, onProgress, stallMs })
      rmQuiet(dest)
      fs.renameSync(part, dest)
      return { file: dest, cached: false, source: hostOf(url) }
    } catch (e) {
      rmQuiet(part)
      if (signal?.aborted) break
      const ue = classify(e); ue.source = hostOf(url); errs.push(ue)
      log(`下载 ${hostOf(url)} 失败：${ue.kind} ${ue.detail || ue.message}`)
      if (ue.kind === 'disk' || ue.kind === 'perm') break
    }
  }
  rmQuiet(part)
  if (signal?.aborted) throw new UpdateError('cancelled', '已取消')
  throw pickError(errs)
}

async function downloadOne(url, part, asset, { signal, onProgress, stallMs }) {
  const stall = new AbortController()
  let timer = null
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), stallMs) }
  const sig = AbortSignal.any([stall.signal, ...(signal ? [signal] : [])])
  kick()
  try {
    let r
    try { r = await fetch(url, { dispatcher: await Net.getDispatcher(url), signal: sig, redirect: 'follow', headers: { 'User-Agent': UA } }) } catch (e) {
      if (stall.signal.aborted) throw new UpdateError('timeout', '连接超时：更新服务器没有响应。' + VPN_HINT, url)
      throw e
    }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); const e = new Error(`HTTP ${r.status}`); e.httpStatus = r.status; throw e }
    if (/text\/html/i.test(r.headers.get('content-type') || '')) { await r.body?.cancel().catch(() => {}); throw new UpdateError('blocked', '下载地址返回的是网页而不是安装文件，可能被网络拦截。' + VPN_HINT) }
    const declared = Number(r.headers.get('content-length')) || 0
    if (declared && declared !== asset.size) { await r.body?.cancel().catch(() => {}); throw new UpdateError('size', '文件大小和发布的不一致，已停止下载（可能被网络替换），请重试或开启 VPN', `${declared} != ${asset.size}`) }
    const h = crypto.createHash('sha256')
    let done = 0, last = 0, lastDone = 0, lastT = Date.now(), speed = 0
    const counter = new Transform({
      transform(chunk, _e, cb) {
        done += chunk.length
        if (done > asset.size) return cb(new UpdateError('size', '文件比发布的大，已停止下载（可能被网络替换），请重试或开启 VPN'))
        h.update(chunk); kick()
        const now = Date.now()
        if (now - last > 200) {
          if (now - lastT >= 1000) { speed = Math.round((done - lastDone) * 1000 / (now - lastT)); lastDone = done; lastT = now }
          last = now; onProgress({ done, total: asset.size, speed, source: hostOf(url) })
        }
        cb(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(part), { signal: sig })
    onProgress({ done, total: asset.size, speed, source: hostOf(url) })
    if (done !== asset.size) throw new UpdateError('size', `下载不完整（${done} / ${asset.size} 字节），已删除，请重试`)
    if (h.digest('hex') !== asset.sha256) throw new UpdateError('checksum', '校验失败：下载的文件和发布的不一致（可能损坏或被网络篡改），已删除。请换个网络或开启 VPN 后重试')
  } catch (e) {
    if (signal?.aborted) throw new UpdateError('cancelled', '已取消')
    if (stall.signal.aborted && !(e instanceof UpdateError)) throw new UpdateError('timeout', `下载卡住超过 ${Math.round(stallMs / 1000)} 秒。` + VPN_HINT)
    throw e
  } finally { clearTimeout(timer) }
}

// ------------------------------------------------------------------ install helpers (Windows)

/** NSIS 安装版：exe 旁边有「Uninstall 拾影.exe」；没有就是便携版 */
function winIsInstalled(execPath, exists = fs.existsSync) {
  const dir = path.win32.dirname(execPath)
  return exists(path.win32.join(dir, 'Uninstall 拾影.exe'))
}

/**
 * 运行安装包的方式。安装版：静默升级（electron-builder NSIS：/S 静默，--updated 升级模式——跳过页面、
 * 先静默卸载旧版但保留数据、自动结束正在运行的拾影，--force-run 装完重新打开）。原来的安装位置和
 * “仅为我 / 所有用户”从注册表读（所有用户安装会弹 UAC）。便携版：打开普通安装界面。
 */
function winInstallCommand(setupPath, { installed }) {
  return installed ? { file: setupPath, args: ['/S', '--updated', '--force-run'], silent: true } : { file: setupPath, args: [], silent: false }
}

// ------------------------------------------------------------------ install helpers (macOS)

/** /Applications/拾影.app/Contents/MacOS/拾影 → /Applications/拾影.app */
function macBundleFromExec(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''))
  return m ? m[1] : null
}

/**
 * 能否直接替换正在运行的 .app：要能写 .app 所在文件夹和 .app 本身（改名、删除旧版）。
 * 返回 { ok, reason: 'translocated' | 'readonly' | 'no-permission' | 'not-bundle' }
 */
function macCanReplace(bundle, { access = (p, m) => fs.accessSync(p, m) } = {}) {
  if (!bundle) return { ok: false, reason: 'not-bundle' }
  if (/\/AppTranslocation\//.test(bundle)) return { ok: false, reason: 'translocated' }
  const W = fs.constants.W_OK
  try { access(path.posix.dirname(bundle), W); access(bundle, W); access(bundle + '/Contents', W) } catch (e) {
    return { ok: false, reason: /EROFS/.test(String(e?.code)) || /^\/Volumes\//.test(bundle) ? 'readonly' : 'no-permission' }
  }
  return { ok: true }
}

/** 读 Info.plist（XML）里的字符串值 */
function plistValue(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(String(xml))
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null
}

/** 在解压目录里找 .app，并检查 bundle id 和版本。返回 .app 路径 */
function macFindAndCheckApp(extractDir, expectVersion) {
  const apps = fs.readdirSync(extractDir).filter(n => n.endsWith('.app'))
  if (apps.length !== 1) throw new UpdateError('install', '更新包里没有找到拾影.app，可能下载了错误的文件')
  const app = path.join(extractDir, apps[0])
  let plist = ''
  try { plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8') } catch { throw new UpdateError('install', '更新包里的拾影.app 不完整（没有 Info.plist）') }
  if (plistValue(plist, 'CFBundleIdentifier') !== APP_ID) throw new UpdateError('install', '更新包不是拾影（bundle id 不对），已停止安装')
  const v = plistValue(plist, 'CFBundleShortVersionString')
  if (expectVersion && v !== expectVersion) throw new UpdateError('install', `更新包的版本（${v}）和更新信息（${expectVersion}）不一致，已停止安装`)
  const exe = plistValue(plist, 'CFBundleExecutable')
  if (!exe || !fs.existsSync(path.join(app, 'Contents', 'MacOS', exe))) throw new UpdateError('install', '更新包里的拾影.app 不完整（没有主程序）')
  return app
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * 退出后替换 .app 的 shell 脚本（/bin/sh）。等拾影进程（pid）退出（最多 60 秒）→ 旧版改名为 .old →
 * 新版移进来（mv，跨磁盘时 ditto）→ 去隔离属性 → 删除旧版 → 打开新版。任何一步失败都把旧版放回去，
 * 打开旧版，并在访达中显示新版（让用户手动拖）。日志写到 log。
 */
function macSwapScript({ pid, target, newApp, log }) {
  return `#!/bin/sh
# 拾影内置更新：替换 ${target}
PID=${Number(pid)}
TARGET=${shq(target)}
NEW=${shq(newApp)}
BAK="$TARGET.old-update"
LOG=${shq(log)}
echo "start $(date)" >> "$LOG"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 300 ]; then echo "app still running, abort" >> "$LOG"; open -R "$NEW"; exit 1; fi
  sleep 0.2
done
rm -rf "$BAK"
if ! mv "$TARGET" "$BAK" 2>>"$LOG"; then
  echo "cannot move old app" >> "$LOG"; open "$TARGET"; open -R "$NEW"; exit 1
fi
if mv "$NEW" "$TARGET" 2>>"$LOG" || ditto "$NEW" "$TARGET" 2>>"$LOG"; then
  xattr -cr "$TARGET" 2>>"$LOG"
  rm -rf "$BAK"
  echo "ok" >> "$LOG"
  open "$TARGET"
  exit 0
fi
echo "cannot move new app, rollback" >> "$LOG"
rm -rf "$TARGET"
mv "$BAK" "$TARGET" 2>>"$LOG"
open "$TARGET"
open -R "$NEW"
exit 1
`
}

const MAC_FALLBACK_TEXT = {
  translocated: '拾影现在是从「下载」或临时位置直接运行的（macOS 的“App 转移”），不能原地替换。',
  readonly: '拾影现在是从只读的磁盘（例如 dmg）运行的，不能原地替换。',
  'no-permission': '拾影没有权限替换「应用程序」里的旧版本（它可能是用别的账户安装的）。',
  'not-bundle': '没有找到正在运行的拾影.app。',
}

/** 不能原地替换时给用户的中文说明 */
function macFallbackMessage(reason, newAppPath) {
  return `${MAC_FALLBACK_TEXT[reason] || MAC_FALLBACK_TEXT['no-permission']}\n\n新版本已下载并校验，放在：\n${newAppPath}\n（已在访达中显示）\n\n请这样更新：\n1. 退出拾影（⌘Q）；\n2. 把访达里的新「拾影」拖到左边栏的「应用程序」文件夹；\n3. 提示已存在时选「替换」（可能要输入开机密码）；\n4. 打开「应用程序」里的拾影。\n\n登录状态、下载记录和设置都会保留。`
}

module.exports = {
  APP_ID, DEFAULT_MANIFESTS, DEFAULT_PAGE, CHECK_INTERVAL, UpdateError, classify, pickError,
  parseSemver, isSemver, cmpSemver, parseManifest, pickAsset, manifestUrls, fetchManifest, checkForUpdate,
  downloadAsset, sha256File, safeName, winIsInstalled, winInstallCommand,
  macBundleFromExec, macCanReplace, plistValue, macFindAndCheckApp, macSwapScript, macFallbackMessage,
}
