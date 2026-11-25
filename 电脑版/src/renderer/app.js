'use strict'
/* 拾影电脑版界面（无框架）。所有能力经 preload 的 window.shiying 调用主进程。 */
const api = window.shiying
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const S = { os: { platform: 'win32', label: 'Windows', pasteKey: 'Ctrl+V', telegramDir: '%APPDATA%\\拾影\\telegram' }, version: '', settings: {}, qualities: [], post: null, jobs: {}, postJob: null, lastClip: '', parsing: false }

const NOTICE_TEXT = '仅供个人学习与备份自己有权保存的内容。请遵守各平台的服务条款和当地法律，不要用于搬运、二次发布或侵犯他人版权。'

// ------------------------------------------------------------------ helpers

let toastTimer
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms)
}
function fmtSize(b) {
  if (!b) return ''
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB'
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1) + ' MB'
  return Math.max(1, Math.round(b / 1024)) + ' KB'
}
function fmtTime(t) {
  const d = new Date(t), now = new Date()
  const p = n => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return '今天 ' + hm
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
function qLabel(k) { return k === 'best' ? '最高画质' : k === 'worst' ? '省流量' : k + 'p' }
function show(el, on) { (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on) }

// ------------------------------------------------------------------ init

async function init() {
  const r = await api.init()
  S.version = r.version; S.settings = r.settings; S.qualities = r.qualities
  if (r.os) { S.os = r.os; $('input').placeholder = $('input').placeholder.replace('Ctrl+V', r.os.pasteKey); document.documentElement.dataset.os = r.os.platform }
  renderSettings()
  renderHistory()
  api.onParseLog(t => { $('statusText').textContent = t })
  api.onJob(onJob)
  api.onSetup(onSetup)
  api.onHistoryChanged(() => renderHistory())
  api.onFocus(() => checkClipboard())
  api.onUpdate(onUpdateEvent)
  api.onMenuCheckUpdate(() => checkUpdate(true))
  setTimeout(checkClipboard, 400)
  if (r.justUpdated) toast(`拾影已更新到 ${r.justUpdated.to}`, 5000)
}

function renderSettings() {
  $('saveDir').textContent = S.settings.saveDir; $('saveDir').title = S.settings.saveDir
  const sel = $('qualitySel')
  sel.innerHTML = S.qualities.map(q => `<option value="${q.key}">${esc(qLabel(q.key))}</option>`).join('')
  sel.value = S.settings.quality
  $('menuQuality').innerHTML = S.qualities.map(q => `<button data-q="${q.key}" class="${q.key === S.settings.quality ? 'on' : ''}">${q.key === S.settings.quality ? '● ' : '○ '}${esc(q.label)}</button>`).join('')
  $('menuClip').textContent = (S.settings.autoClipboard ? '✓ ' : '　 ') + '自动识别剪贴板里的链接'
  $('menuAutoUpdate').textContent = (S.settings.updateAuto !== false ? '✓ ' : '　 ') + '启动时自动检查更新'
}

async function setQuality(q) {
  S.settings.quality = await api.setQuality(q)
  renderSettings()
  if (S.post) renderPreview()
  toast('下载画质：' + qLabel(S.settings.quality) + '（之后解析的作品生效）')
}

// ------------------------------------------------------------------ clipboard / input

async function checkClipboard() {
  if (!S.settings.autoClipboard || S.parsing) return
  const c = await api.clipboard()
  if (!c.supported || !c.text || c.text === S.lastClip) return
  S.lastClip = c.text
  if ($('input').value.trim() === c.text.trim()) return
  $('input').value = c.text.trim()
  updateDetected()
  toast(`已从剪贴板识别到${c.platform ? ' ' + c.platform + ' ' : ''}链接，正在解析…`)
  doParse()
}

let detTimer
async function updateDetected() {
  clearTimeout(detTimer)
  detTimer = setTimeout(async () => {
    const t = $('input').value.trim()
    const p = t ? await api.detect(t) : null
    $('detected').textContent = p ? '已识别：' + p : ''
    show('detected', !!p)
  }, 120)
}

// ------------------------------------------------------------------ parse

async function doParse() {
  const text = $('input').value.trim()
  if (!text) { $('input').focus(); toast('先粘贴分享链接'); return }
  const seq = S.parseSeq = (S.parseSeq || 0) + 1
  S.parsing = true
  show('error', false); show('preview', false); S.post = null
  $('statusText').textContent = '正在解析…'; show('status', true)
  $('btnParse').disabled = true
  const r = await api.parse(text)
  if (seq !== S.parseSeq) return // 已被更新的一次解析取代
  S.parsing = false
  $('btnParse').disabled = false
  show('status', false)
  if (!r.ok) {
    if (r.cancelled) return
    $('errorText').textContent = r.error
    show('btnErrLogin', /登录/.test(r.error))
    show('btnErrDiag', /解析引擎|YouTube|yt-dlp|诊断|改版|拒绝|限流|机器人/.test(r.error))
    show('error', true)
    return
  }
  S.post = r.post
  S.postJob = null
  renderPreview()
  loadCover(r.post)
}

async function loadCover(p) {
  const img = $('pvCover')
  img.removeAttribute('src')
  if (!p.cover) { img.src = 'icon.png'; return }
  const data = await api.cover(p.cover, p.platform, p.headers?.Referer)
  if (S.post !== p) return
  img.src = data || 'icon.png'
}

function renderPreview() {
  const p = S.post
  if (!p) { show('preview', false); return }
  show('preview', true)
  $('pvPlatform').textContent = p.platformLabel + (p.source ? ' · ' + (p.engine === 'ytdlp' ? '解析引擎' : p.engine === 'telegram' ? '账号登录下载' : '原生解析') : '')
  $('pvTitle').textContent = p.title
  $('pvAuthor').textContent = p.author ? '@' + p.author : ''
  $('pvBadge').textContent = p.engine === 'telegram' ? (p.entries > 1 ? '相册' : '') : p.isImages ? '图集' : (p.entries > 1 ? `${p.entries} 个视频` : '')
  $('pvDur').textContent = p.durationText || ''
  const meta = []
  if (p.engine === 'telegram') {
    meta.push(p.tg?.summary || '')
    if (p.shownHeight) meta.push(`${p.shownHeight}p`)
    if (p.tg?.totalSize) meta.push('约 ' + fmtSize(p.tg.totalSize))
  } else if (p.isImages) { meta.push(`${p.images.length} 张图片`); if (p.liveCount) meta.push(`含 ${p.liveCount} 个实况`) }
  else {
    const h = p.qualityOverride ? Number(p.qualityOverride) : p.shownHeight
    if (h) meta.push(`${h}p`)
    if (p.qualities?.length < 2 && !h) meta.push('视频')
  }
  $('pvMeta').textContent = meta.join(' · ')
  // 本次画质（≥ 2 档时）
  const qs = p.qualities || []
  show('pvQualityRow', !p.isImages && qs.length >= 2)
  if (!p.isImages && qs.length >= 2) {
    const sel = $('pvQuality')
    const cur = p.qualityOverride ? Number(p.qualityOverride) : p.shownHeight
    sel.innerHTML = qs.map(q => `<option value="${q.h}">${q.h}p${q.size ? ' · 约 ' + fmtSize(q.size) : ''}${q.h === p.shownHeight && !p.qualityOverride ? '（按设置）' : ''}</option>`).join('')
    sel.value = String(cur)
  }
  renderPostJob()
}

function renderPostJob() {
  const j = S.postJob ? S.jobs[S.postJob] : null
  const running = j && (j.status === 'running' || j.status === 'queued')
  show('pvProgress', !!running)
  const b = $('btnDownload')
  if (running) {
    b.textContent = '取消下载'; b.classList.remove('primary'); b.classList.add('danger')
    const pct = Math.max(0, Math.min(100, j.pct || 0))
    $('pvBar').style.width = pct.toFixed(1) + '%'
    $('pvBar').parentElement.classList.toggle('indet', !j.pct)
    $('pvPText').textContent = j.text || '排队中…'
    $('pvPct').textContent = j.pct ? pct.toFixed(0) + '%' : ''
  } else {
    b.textContent = j && j.status === 'done' ? '再次下载' : '下载'; b.classList.add('primary'); b.classList.remove('danger')
  }
  show('btnShowDone', !!(j && j.status === 'done'))
}

async function onDownloadClick() {
  const p = S.post
  if (!p) return
  const j = S.postJob ? S.jobs[S.postJob] : null
  if (j && (j.status === 'running' || j.status === 'queued')) { await api.cancel(S.postJob); return }
  const sel = $('pvQuality')
  const override = !p.isImages && (p.qualities || []).length >= 2 && Number(sel.value) !== p.shownHeight ? sel.value : null
  const key = await api.download(p, override)
  S.postJob = key
  S.jobs[key] = { status: 'queued', pct: 0, text: '排队中…' }
  renderPostJob()
}

function onJob(e) {
  const j = S.jobs[e.key] || (S.jobs[e.key] = {})
  Object.assign(j, e)
  if (e.key === S.postJob) renderPostJob()
  if (e.status === 'done') toast('下载完成' + (e.files?.length ? '：' + e.files[0].split(/[\\/]/).pop() : ''))
  else if (e.status === 'failed') toast('下载失败：' + (e.message || ''), 5000)
  updateHistoryProgress(e)
}

// ------------------------------------------------------------------ engine setup

const SETUP = { ytdlp: '解析引擎 yt-dlp', ffmpeg: '音视频合并 ffmpeg', deno: 'YouTube 用的 Deno' }
function onSetup(e) {
  if (e.phase === 'start') {
    show('setup', true); show('setupErr', false); show('setupRetry', false)
    $('setupTitle').textContent = '正在准备解析引擎'
    $('setupRows').innerHTML = ''
    return
  }
  if (e.phase === 'progress') {
    let row = document.getElementById('setup-' + e.name)
    if (!row) {
      row = document.createElement('div'); row.className = 'setup-row'; row.id = 'setup-' + e.name
      row.innerHTML = `<div class="bar"><i></i></div><div class="ptext"><span class="l"></span><span class="r"></span></div>`
      $('setupRows').appendChild(row)
    }
    const pct = e.total ? e.done * 100 / e.total : 0
    row.querySelector('i').style.width = pct.toFixed(1) + '%'
    row.querySelector('.bar').classList.toggle('indet', !e.total)
    row.querySelector('.l').textContent = `${SETUP[e.name] || e.label} · ${e.phase}${e.source ? '（' + e.source + '）' : ''}`
    row.querySelector('.r').textContent = e.total ? `${fmtSize(e.done)} / ${fmtSize(e.total)}` : (e.done ? fmtSize(e.done) : '')
    return
  }
  if (e.phase === 'done') {
    $('setupTitle').textContent = '解析引擎已就绪'
    for (const i of document.querySelectorAll('#setupRows i')) i.style.width = '100%'
    if (e.denoError) { $('setupErr').textContent = 'Deno 没有装好，只影响 YouTube：\n' + e.denoError; show('setupErr', true); show('setupRetry', true) }
    else setTimeout(() => show('setup', false), 1500)
    return
  }
  if (e.phase === 'error') {
    show('setup', true)
    $('setupTitle').textContent = '解析引擎下载失败'
    $('setupErr').textContent = e.message + '\n\n抖音、快手、小红书不需要解析引擎，可以照常使用。'
    show('setupErr', true); show('setupRetry', true)
  }
}

// ------------------------------------------------------------------ history

async function renderHistory() {
  const list = await api.history()
  show('histEmpty', !list.length)
  $('history').innerHTML = list.map(e => {
    const thumb = e.thumb ? `<img class="h-thumb" src="${e.thumb}" alt="">` : `<div class="h-ph">${esc((e.platformLabel || '影').slice(0, 1))}</div>`
    const j = S.jobs[e.key]
    let status = ''
    if (e.status === 'running') {
      const pct = j?.pct || 0
      status = `<div class="bar ${pct ? '' : 'indet'}"><i style="width:${pct.toFixed(1)}%"></i></div><div class="h-msg gray" data-ptext>${esc(j?.text || e.message || '排队中…')}</div>
        <div class="h-act"><a href="#" data-a="cancel">取消</a></div>`
    } else if (e.status === 'done') {
      status = `<div class="h-act"><span class="h-ok">✓ 已保存</span>${e.exists ? `<a href="#" data-a="open">打开</a><a href="#" data-a="folder">在文件夹中显示</a>` : '<span class="h-msg gray">文件已被移动或删除</span>'}<a href="#" data-a="copy">复制链接</a></div>`
    } else {
      status = `<div class="h-msg ${e.status === 'cancelled' ? 'gray' : ''}">${esc(e.message || (e.status === 'cancelled' ? '已取消' : '失败'))}</div>
        <div class="h-act"><a href="#" data-a="retry">重新解析</a><a href="#" data-a="copy">复制链接</a></div>`
    }
    return `<li data-key="${esc(e.key)}">${thumb}<div class="h-main"><div class="h-title" title="${esc(e.title)}">${esc(e.title)}</div>
      <div class="h-sub">${esc(e.platformLabel)}${e.author ? ' · ' + esc(e.author) : ''} · ${e.isImages ? '图集 · ' : ''}${fmtTime(e.time)}</div>${status}</div>
      <button class="h-del" data-a="del" title="删除这条记录（不删除文件）">×</button></li>`
  }).join('')
  S.histCache = Object.fromEntries(list.map(e => [e.key, e]))
}

function updateHistoryProgress(e) {
  const li = document.querySelector(`#history li[data-key="${CSS.escape(e.key)}"]`)
  if (!li || e.status !== 'running') { if (e.status !== 'running') renderHistory(); return }
  const bar = li.querySelector('.bar'), t = li.querySelector('[data-ptext]')
  if (bar) { bar.classList.toggle('indet', !e.pct); bar.querySelector('i').style.width = (e.pct || 0).toFixed(1) + '%' }
  if (t) t.textContent = e.text || ''
}

async function onHistoryClick(ev) {
  const a = ev.target.closest('[data-a]'); if (!a) return
  ev.preventDefault()
  const key = a.closest('li').dataset.key
  const e = S.histCache?.[key]; if (!e) return
  const files = e.files || []
  switch (a.dataset.a) {
    case 'open': { const err = await api.openFile(files[0]); if (err) toast(err); break }
    case 'folder': { const err = await api.showFile(files[0]); if (err) toast(err); break }
    case 'copy': await api.copyText(e.link); toast('已复制链接'); break
    case 'retry': $('input').value = e.link; updateDetected(); doParse(); break
    case 'cancel': await api.cancel(key); break
    case 'del': await api.historyRemove(key); break
  }
}

// ------------------------------------------------------------------ modals

function openModal(html) { $('modalBody').innerHTML = html; show('modal', true) }
function closeModal() { show('modal', false); $('modalBody').innerHTML = '' }

async function openLogin() {
  const [st, tg] = await Promise.all([api.loginStatus(), api.tgStatus()])
  openModal(`<h2>登录平台账号（可选）</h2>
    <p>大部分作品不用登录就能下载。遇到「需要登录」「年龄限制」或想要 B 站 1080p 时再登录。登录状态只保存在这台电脑上。</p>
    <div class="login-row tg-row"><b>Telegram</b>
      <span class="st ${tg.loggedIn ? 'on' : ''}">${tg.loggedIn ? '已登录' + (tg.name || tg.username ? '：' + esc(tg.name || '@' + tg.username) : '') : '未登录（私密频道 / 群组需要登录）'}</span>
      <button id="tgOpen" class="primary">${tg.loggedIn ? 'Telegram 设置' : 'Telegram 账号登录'}</button>${tg.loggedIn ? '<button id="tgOutQuick" class="ghost">退出 Telegram 登录</button>' : ''}</div>
    <div id="loginList">${st.map(s => `<div class="login-row" data-n="${s.name}"><b>${esc(s.label)}</b>
      <span class="st ${s.loggedIn ? 'on' : ''}">${s.loggedIn ? (s.imported ? '已导入 cookies' : '已登录') : '未登录'}</span>
      <button data-l="open">网页登录</button><button data-l="import" class="ghost">导入 cookies.txt</button>${s.loggedIn ? '<button data-l="out" class="ghost">退出</button>' : ''}</div>`).join('')}</div>
    <p style="font-size:12px">提示：Google 可能拒绝在内嵌窗口里登录 YouTube，这时请用浏览器扩展「Get cookies.txt LOCALLY」在已登录的浏览器里导出 cookies.txt，再点「导入 cookies.txt」。</p>
    <div class="row-btns"><span class="grow"></span><button id="logoutAll" class="ghost">退出全部登录</button></div>`)
  $('loginList').onclick = async ev => {
    const b = ev.target.closest('[data-l]'); if (!b) return
    const n = b.closest('[data-n]').dataset.n
    if (b.dataset.l === 'open') { toast('在弹出的窗口里登录，登录好后关闭那个窗口'); const ok = await api.loginOpen(n); toast(ok ? '已登录，之后解析会自动带上登录状态' : '没有检测到登录'); openLogin() }
    if (b.dataset.l === 'import') { const r = await api.loginImport(n); if (r === 'ok') { toast('已导入 cookies'); openLogin() } else if (r) toast(r, 5000) }
    if (b.dataset.l === 'out') { await api.loginLogout(n); toast('已退出'); openLogin() }
  }
  $('logoutAll').onclick = async () => { await api.loginLogoutAll(); toast('已退出全部登录'); openLogin() }
  $('tgOpen').onclick = () => openTelegram()
  if ($('tgOutQuick')) $('tgOutQuick').onclick = () => tgLogout(openLogin)
}

// ------------------------------------------------------------------ Telegram 登录

const TG_GUIDE = `<details class="tg-guide"><summary>怎么获取 api_id 和 api_hash？（只需要做一次）</summary><ol>
  <li>用浏览器打开 <a href="#" data-url="https://my.telegram.org">my.telegram.org</a>（需要能访问 Telegram 的网络）。</li>
  <li>输入你的 Telegram 手机号（带区号，如 <b>+86</b>13800138000），点 <b>Next</b>。</li>
  <li>验证码会发到你手机上的 <b>Telegram App</b> 里（「Telegram」官方账号发来的消息，不是短信），填到网页上，点 <b>Sign In</b>。</li>
  <li>点 <b>API development tools</b>。</li>
  <li>第一次会让你创建应用：<b>App title</b> 填 <code>shiying</code>，<b>Short name</b> 填 <code>shiyingpc</code>（5–32 位英文字母或数字），<b>Platform</b> 选 <b>Desktop</b>，其他留空，点 <b>Create application</b>。<br>提示「ERROR」时：换个代理节点、关掉广告拦截插件，或过一会儿再试。</li>
  <li>把页面上的 <b>App api_id</b>（一串数字）和 <b>App api_hash</b>（32 位字母数字）复制到下面。</li>
</ol><p>api_id / api_hash 只属于你的账号，不要发给别人。拾影只把它们和登录状态加密保存在这台电脑上（__TGDIR__）。</p></details>`

const TG_PROXY_HINT = '留空 = 跟随系统代理（Clash / v2rayN 开「系统代理」即可）；或填 socks5://127.0.0.1:7890、MTProxy 链接（tg://proxy?…）'

const TG = { step: 'form', hint: '', viaApp: true }

function tgBusy(on, text) {
  for (const b of document.querySelectorAll('#tgBox button')) b.disabled = on
  show('tgBusy', on); if (text) $('tgBusyText').textContent = text
  if (on) show('tgErr', false)
}
function tgError(msg) { $('tgErr').textContent = msg; show('tgErr', true) }

async function tgLogout(after) {
  if (!confirm('退出 Telegram 登录？\n会通知 Telegram 结束这个会话，并删除这台电脑上保存的登录状态（api_id / api_hash 和代理设置会保留）。')) return
  toast('正在退出 Telegram 登录…')
  const r = await api.tgLogout(false)
  TG.step = 'form'
  toast(r.ok ? (r.remote ? '已退出 Telegram 登录' : '已删除本机的 Telegram 登录（没连上 Telegram，可以在手机「设置 → 设备」里结束「拾影 PC」会话）') : r.error, 6000)
  after ? after() : openTelegram()
}

async function openTelegram() {
  const st = await api.tgStatus()
  if (!st.pending && TG.step !== 'form') TG.step = 'form'
  const proxyBlock = `<label>代理（国内需要）<input id="tgProxy" type="text" spellcheck="false" value="${esc(st.proxy)}" placeholder="socks5://127.0.0.1:7890"></label>
    <div class="tg-note">${esc(TG_PROXY_HINT)}。当前：${esc(st.proxyDesc)}${st.via ? '；上次连接方式：' + esc(st.via) : ''}</div>`
  const enc = st.encryption ? '' : '<div class="err">这台电脑不能加密保存登录信息，关闭拾影后需要重新登录。</div>'
  let body
  if (st.loggedIn) {
    body = `<p class="tg-ok">✓ 已登录${st.name || st.username ? '：<b>' + esc(st.name || '') + '</b>' + (st.username ? ' @' + esc(st.username) : '') : ''}</p>
      <p>直接粘贴 Telegram 消息链接（右键消息 →「复制消息链接」）就能下载。登录状态加密保存在这台电脑上。</p>${enc}
      ${proxyBlock}
      <div class="row-btns"><button id="tgSaveProxy">保存代理</button><button id="tgTest" class="ghost">测试连接</button><span class="grow"></span><button id="tgLogout" class="danger">退出 Telegram 登录</button></div>`
  } else if (TG.step === 'code') {
    body = `<p>验证码已发到${TG.viaApp ? '你手机 / 电脑上的 <b>Telegram App</b>（「Telegram」官方账号的消息）' : '你的手机<b>短信</b>'}。</p>
      <label>验证码<input id="tgCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="5 位数字"></label>
      <div class="row-btns"><button id="tgBack" class="ghost">返回修改</button><button id="tgResend" class="ghost">重新发送验证码</button><span class="grow"></span><button id="tgSignIn" class="primary">登录</button></div>`
  } else if (TG.step === 'password') {
    body = `<p>这个账号开了<b>两步验证</b>，请输入两步验证密码（不是验证码）。${TG.hint ? '<br>密码提示：' + esc(TG.hint) : ''}</p>
      <label>两步验证密码<input id="tgPw" type="password" autocomplete="current-password"></label>
      <div class="row-btns"><button id="tgBack" class="ghost">返回</button><span class="grow"></span><button id="tgPwBtn" class="primary">登录</button></div>`
  } else {
    body = `<p>登录你自己的 Telegram 账号后，你账号能看到的消息（公开频道、私密频道、群组、评论）里的视频和图片都可以下载。</p>
      ${TG_GUIDE.replace("__TGDIR__", esc(S.os.telegramDir))}${enc}
      <label>api_id<input id="tgApiId" type="text" inputmode="numeric" spellcheck="false" value="${esc(st.apiId)}" placeholder="例如 1234567"></label>
      <label>api_hash<input id="tgApiHash" type="password" spellcheck="false" autocomplete="off" placeholder="${st.hasApiHash ? '已保存（不用重新填；要换就填新的）' : '32 位字母和数字'}"></label>
      <label>手机号<input id="tgPhone" type="tel" spellcheck="false" placeholder="+8613800138000（国内号码可以不写 +86）"></label>
      ${proxyBlock}
      <div class="row-btns"><button id="tgTest" class="ghost">测试连接</button><span class="grow"></span><button id="tgSend" class="primary">发送验证码</button></div>`
  }
  openModal(`<h2>Telegram 账号登录</h2><div id="tgBox" class="tg-form">${body}
    <div id="tgBusy" class="status hidden"><span class="spin"></span><span id="tgBusyText"></span></div>
    <div id="tgErr" class="err hidden"></div>
    <div class="row-btns small"><a href="#" id="tgBackLogin">← 返回登录列表</a></div></div>`)
  for (const a of document.querySelectorAll('#tgBox [data-url]')) a.onclick = e => { e.preventDefault(); api.openUrl(a.dataset.url) }
  $('tgBackLogin').onclick = e => { e.preventDefault(); openLogin() }
  const proxyVal = () => ($('tgProxy') ? $('tgProxy').value.trim() : undefined)
  const done = r => {
    if (!r.ok) { tgBusy(false); tgError(r.error); return false }
    return true
  }
  if ($('tgTest')) $('tgTest').onclick = async () => {
    tgBusy(true, '正在连接 Telegram…')
    const r = await api.tgTest(proxyVal())
    if (!done(r)) return
    tgBusy(false); toast('连接成功：' + r.via, 4000); openTelegram()
  }
  if ($('tgSaveProxy')) $('tgSaveProxy').onclick = async () => {
    const r = await api.tgSetProxy(proxyVal())
    if (!done(r)) return
    toast('已保存代理设置'); openTelegram()
  }
  if ($('tgLogout')) $('tgLogout').onclick = () => tgLogout()
  if ($('tgSend')) $('tgSend').onclick = async () => {
    const a = { apiId: $('tgApiId').value.trim(), apiHash: $('tgApiHash').value.trim(), phone: $('tgPhone').value.trim(), proxy: proxyVal() }
    if (!a.apiId) return tgError('请填 api_id（获取方法见上面的说明）')
    if (!a.apiHash && !st.hasApiHash) return tgError('请填 api_hash（获取方法见上面的说明）')
    if (!a.phone) return tgError('请填手机号')
    tgBusy(true, '正在连接 Telegram 并发送验证码…')
    const r = await api.tgSendCode(a)
    if (!done(r)) return
    TG.step = 'code'; TG.viaApp = r.viaApp
    await openTelegram(); $('tgCode')?.focus()
  }
  if ($('tgResend')) $('tgResend').onclick = async () => {
    tgBusy(true, '正在重新发送验证码…')
    const r = await api.tgResend()
    if (!done(r)) return
    tgBusy(false); TG.viaApp = r.viaApp; toast('已重新发送验证码')
  }
  const finish = r => { TG.step = 'form'; toast('Telegram 登录成功' + (r.name ? '：' + r.name : '') + (r.saved === false ? '（这台电脑不能加密保存，关闭拾影后需要重新登录）' : ''), 5000); openTelegram() }
  if ($('tgSignIn')) {
    const go = async () => {
      tgBusy(true, '正在登录…')
      const r = await api.tgSignIn($('tgCode').value)
      if (!done(r)) { if (r.kind === 'auth_code_expired') show('tgResend', true); return }
      if (r.step === 'password') { TG.step = 'password'; TG.hint = r.hint || ''; await openTelegram(); $('tgPw')?.focus(); return }
      finish(r)
    }
    $('tgSignIn').onclick = go
    $('tgCode').onkeydown = e => { if (e.key === 'Enter') go() }
  }
  if ($('tgPwBtn')) {
    const go = async () => {
      tgBusy(true, '正在验证两步验证密码…')
      const pw = $('tgPw').value
      $('tgPw').value = ''
      const r = await api.tgPassword(pw)
      if (!done(r)) return
      finish(r)
    }
    $('tgPwBtn').onclick = go
    $('tgPw').onkeydown = e => { if (e.key === 'Enter') go() }
  }
  if ($('tgBack')) $('tgBack').onclick = async () => { await api.tgCancelLogin(); TG.step = 'form'; openTelegram() }
}

// ------------------------------------------------------------------ 拾影本身的更新

const UP = { running: false, checking: false, info: null }
const UPD_MODE_TEXT = {
  'win-silent': '点「立即更新」后拾影会下载新版本并校验，然后自动关闭、在后台安装（保留登录状态、下载记录和设置），装好后自动重新打开。',
  'win-setup': '你用的是便携版：点「立即更新」会下载安装包并校验，然后打开安装程序（装好后用开始菜单里的拾影；数据和便携版共用，不会丢）。',
  mac: '点「立即更新」后拾影会下载新版本并校验，然后自动替换「应用程序」里的拾影并重新打开（保留登录状态、下载记录和设置）。',
}

/** 手动检查（manual=true）会显示「已是最新」或错误；自动检查的结果由主进程在有新版本时推送 */
async function checkUpdate(manual) {
  if (UP.running) { openUpdateProgress(); return }
  if (UP.checking) return
  UP.checking = true
  if (manual) toast('正在检查拾影新版本…')
  try {
    const r = await api.updateCheck()
    if (!r.ok) {
      if (manual) {
        openModal(`<h2>检查更新</h2><div class="err">${esc(r.error)}</div>
          <div class="row-btns upd-btns"><button class="ghost" id="updPage">打开拾影主页</button><button id="updRetry" class="primary">重试</button></div>`)
        wireUpdErr()
      }
      return
    }
    if (r.available) openUpdateDialog(r)
    else if (manual) {
      openModal(`<h2>检查更新</h2><p class="upd-ok">✓ 已是最新版本（${esc(r.current)}）</p>
        <p>更新信息中的最新版本：${esc(r.version)}${r.date ? '（' + esc(r.date) + '）' : ''}</p>
        <div class="row-btns upd-btns"><button class="primary" id="updOk">好</button></div>`)
      $('updOk').onclick = closeModal
    }
  } finally { UP.checking = false }
}

function wireUpdErr() {
  if ($('updPage')) $('updPage').onclick = () => api.updateOpenPage()
  if ($('updRetry')) $('updRetry').onclick = () => { closeModal(); checkUpdate(true) }
}

function openUpdateDialog(r) {
  UP.info = r
  const manual = r.mode === 'manual'
  let note = UPD_MODE_TEXT[r.mode] || ''
  if (manual) note = r.belowMin ? `这个版本不能从 ${esc(r.current)} 直接内置更新，请到拾影主页下载完整安装包。` : r.dev ? '开发模式下不能安装更新，点「打开下载页」手动下载。' : '这台电脑的系统没有对应的安装文件，请到拾影主页下载。'
  openModal(`<h2>发现拾影新版本</h2>
    <div class="upd-ver"><b>${esc(r.version)}</b><span>当前版本 ${esc(r.current)}${r.date ? ' · 发布于 ' + esc(r.date) : ''}${r.size ? ' · 大小 ' + fmtSize(r.size) : ''}</span></div>
    <h3>更新内容</h3>
    <div class="upd-notes">${esc(r.notes || '（没有更新说明）')}</div>
    <p style="font-size:13px">${note}</p>
    ${r.busy && !manual ? '<div class="upd-warn">有下载任务正在进行或排队，更新时拾影会关闭，这些任务会中断（之后可在下载记录里重新下载）。</div>' : ''}
    ${r.emulated ? '<div class="upd-warn">没有 Apple 芯片专用版，将安装 Intel 版（通过 Rosetta 运行）。</div>' : ''}
    <div class="row-btns upd-btns"><button class="ghost" id="updLater">以后再说</button><button class="primary big" id="updNow">${manual ? '打开下载页' : '立即更新'}</button></div>`)
  $('updLater').onclick = closeModal
  $('updNow').onclick = () => manual ? (api.updateOpenPage(), closeModal()) : startUpdate()
}

function openUpdateProgress(text) {
  openModal(`<h2>正在更新拾影${UP.info ? ' ' + esc(UP.info.version) : ''}</h2>
    <div class="progress"><div class="bar indet" id="updBarWrap"><i id="updBar"></i></div><div class="ptext"><span id="updText">${esc(text || '正在连接…')}</span><span id="updPct"></span></div></div>
    <div id="updErr" class="err hidden"></div>
    <div class="row-btns upd-btns"><button class="ghost" id="updCancel">取消</button></div>`)
  $('updCancel').onclick = () => { if (UP.running) { api.updateCancel(); $('updText').textContent = '正在取消…' } else closeModal() }
}

async function startUpdate() {
  UP.running = true
  openUpdateProgress()
  let r
  try { r = await api.updateStart() } finally { UP.running = false }
  if (r.opened) { closeModal(); return }
  if (r.cancelled) { closeModal(); toast('已取消更新，没下完的文件已删除'); return }
  if (!r.ok) {
    openModal(`<h2>更新失败</h2><div class="err">${esc(r.error)}</div>
      <p style="font-size:13px">也可以到拾影主页手动下载新版本安装（登录状态、下载记录和设置都会保留）。</p>
      <div class="row-btns upd-btns"><button class="ghost" id="updPage">打开拾影主页</button><button class="ghost" id="updClose">关闭</button><button id="updRetryDl" class="primary">重试</button></div>`)
    $('updPage').onclick = () => api.updateOpenPage(); $('updClose').onclick = closeModal; $('updRetryDl').onclick = () => startUpdate()
    return
  }
  if (r.manual) {
    openModal(`<h2>新版本已下载，请手动替换</h2><div class="upd-notes">${esc(r.message)}</div>
      <div class="row-btns upd-btns"><button class="ghost" id="updClose">以后再说</button><button class="primary" id="updQuit">退出拾影</button></div>`)
    $('updClose').onclick = closeModal; $('updQuit').onclick = () => api.quitApp()
    return
  }
  if (r.quitting && $('updText')) { $('updText').textContent = '安装中，拾影即将关闭并自动重新打开…'; show('updCancel', false) }
}

function onUpdateEvent(e) {
  if (e.phase === 'available') { if (!UP.running && $('modal').classList.contains('hidden')) openUpdateDialog(e); return }
  if (!$('updText')) return
  if (e.phase === 'progress') {
    const pct = e.total ? Math.min(100, e.done / e.total * 100) : 0
    $('updBarWrap').classList.toggle('indet', !e.total); $('updBar').style.width = pct.toFixed(1) + '%'
    $('updText').textContent = `正在下载 ${fmtSize(e.done) || '0 KB'} / ${fmtSize(e.total)}${e.speed ? ' · ' + fmtSize(e.speed) + '/秒' : ''}${e.source ? ' · ' + e.source : ''}`
    $('updPct').textContent = pct ? pct.toFixed(0) + '%' : ''
  } else if (e.phase === 'installing') {
    $('updBarWrap').classList.add('indet'); $('updText').textContent = e.text || '正在安装…'; $('updPct').textContent = ''
    show('updCancel', false)
  }
}

async function openAbout() {
  const [info, notice] = await Promise.all([api.engineInfo(), api.notice()])
  openModal(`<div class="about-head"><img src="icon.png" alt=""><div><h2 style="margin:0">拾影 电脑版</h2><div>版本 ${esc(S.version)} · ${esc(S.os.label)}</div></div></div>
    <div class="row-btns" style="margin-top:8px"><button id="aboutUpdate" class="ghost">检查更新</button></div>
    <h3>解析引擎</h3>
    <div class="kv"><span>yt-dlp</span><span>${esc(info.ytdlp || '未安装')}</span><span>ffmpeg</span><span>${esc(info.ffmpeg || '未安装')}</span>
      <span>Deno</span><span>${esc(info.deno || '未安装（只影响 YouTube）')}</span><span>位置</span><span style="word-break:break-all">${esc(info.binDir)}</span></div>
    <h3>支持平台</h3>
    <p><b>原生解析：</b>抖音、快手、小红书（视频 + 图集）<br><b>Telegram：</b>登录自己的账号后下载公开频道、私密频道、群组、评论里的视频 / 图片 / 相册（不登录时公开频道用 yt-dlp）；禁止保存内容的频道 / 聊天不下载<br><b>yt-dlp 解析：</b>哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo 及 yt-dlp 支持的其他网站<br><b>不支持：</b>视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容</p>
    <h3>使用须知</h3>
    <p>${esc(NOTICE_TEXT)}</p>
    <h3>许可证</h3>
    <p>GPL-3.0（使用 yt-dlp、ffmpeg 等组件，第三方组件见下）。</p>
    <pre>${esc(notice || '')}</pre>`)
  $('aboutUpdate').onclick = () => { closeModal(); checkUpdate(true) }
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('input').addEventListener('input', updateDetected)
  $('input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); doParse() } })
  $('input').addEventListener('paste', () => setTimeout(() => { S.lastClip = $('input').value; updateDetected(); doParse() }, 30))
  $('btnPaste').onclick = async () => { const c = await api.clipboard(); $('input').value = (c.text || '').trim(); S.lastClip = c.text; updateDetected(); if (c.text) doParse(); else toast('剪贴板是空的') }
  $('btnClear').onclick = () => { $('input').value = ''; updateDetected(); show('error', false); $('input').focus() }
  $('btnParse').onclick = doParse
  $('btnCancelParse').onclick = e => { e.preventDefault(); api.cancelParse(); show('status', false); S.parsing = false; $('btnParse').disabled = false }
  $('btnDownload').onclick = onDownloadClick
  $('btnShowDone').onclick = () => { const j = S.jobs[S.postJob]; if (j?.files?.[0]) api.showFile(j.files[0]) }
  $('btnCopyLink').onclick = async () => { if (S.post) { await api.copyText(S.post.link); toast('已复制链接') } }
  $('btnOpenPage').onclick = () => { if (S.post) api.openUrl(S.post.link) }
  $('pvQuality').onchange = () => { if (!S.post) return; const v = Number($('pvQuality').value); S.post.qualityOverride = v === S.post.shownHeight ? null : String(v); renderPreview() }
  $('btnErrDiag').onclick = async () => { const ok = await api.diagCopy(); toast(ok ? '已复制诊断日志（已隐藏 cookies 和令牌）' : '已复制基本信息（还没有解析引擎日志）') }
  $('btnErrLogin').onclick = openLogin
  $('btnChangeDir').onclick = async e => { e.preventDefault(); const d = await api.chooseSaveDir(); if (d) { S.settings.saveDir = d; renderSettings(); toast('之后的下载会保存到：' + d) } }
  $('btnOpenDir').onclick = async e => { e.preventDefault(); const err = await api.openSaveDir(); if (err) toast(err) }
  $('qualitySel').onchange = () => setQuality($('qualitySel').value)
  $('history').onclick = onHistoryClick
  $('btnHistClear').onclick = async e => { e.preventDefault(); if (confirm('清空全部下载记录？（不会删除已下载的文件）')) await api.historyClear() }
  $('setupRetry').onclick = () => api.engineUpdate()
  $('btnLogin').onclick = openLogin
  $('btnMenu').onclick = e => { e.stopPropagation(); $('menu').classList.toggle('hidden') }
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) show('menu', false) })
  $('menu').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return
    show('menu', false)
    if (b.dataset.q) return setQuality(b.dataset.q)
    switch (b.dataset.act) {
      case 'saveDir': $('btnChangeDir').click(); break
      case 'clip': S.settings = await api.setSetting('autoClipboard', !S.settings.autoClipboard); renderSettings(); toast(S.settings.autoClipboard ? '已开启：切回拾影时自动识别剪贴板链接' : '已关闭剪贴板自动识别'); break
      case 'update': { toast('正在检查解析引擎更新…'); const r = await api.engineUpdate(); toast(r.message || (r.ok ? '解析引擎已是最新' : '更新失败'), 6000); break }
      case 'diag': { const ok = await api.diagCopy(); toast(ok ? '已复制诊断日志（已隐藏 cookies 和令牌）' : '已复制基本信息（还没有解析引擎日志）'); break }
      case 'data': api.openDataDir(); break
      case 'checkUpdate': checkUpdate(true); break
      case 'autoUpdate': S.settings = await api.setSetting('updateAuto', S.settings.updateAuto === false); renderSettings(); toast(S.settings.updateAuto !== false ? '已开启：启动时自动检查拾影新版本（最多 6 小时一次）' : '已关闭启动时自动检查更新（仍可在菜单里手动检查）', 4000); break
      case 'about': openAbout(); break
    }
  }
  $('modalX').onclick = () => { if (!UP.running) closeModal() }
  $('modal').onclick = e => { if (e.target === $('modal') && !UP.running) closeModal() }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!UP.running) closeModal(); show('menu', false) } })
}

wire()
init()
