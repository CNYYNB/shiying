'use strict'
/* 拾影电脑版界面（无框架）。所有能力经 preload 的 window.shiying 调用主进程。 */
const api = window.shiying
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const S = { version: '', settings: {}, qualities: [], post: null, jobs: {}, postJob: null, lastClip: '', parsing: false }

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
  renderSettings()
  renderHistory()
  api.onParseLog(t => { $('statusText').textContent = t })
  api.onJob(onJob)
  api.onSetup(onSetup)
  api.onHistoryChanged(() => renderHistory())
  api.onFocus(() => checkClipboard())
  setTimeout(checkClipboard, 400)
}

function renderSettings() {
  $('saveDir').textContent = S.settings.saveDir; $('saveDir').title = S.settings.saveDir
  const sel = $('qualitySel')
  sel.innerHTML = S.qualities.map(q => `<option value="${q.key}">${esc(qLabel(q.key))}</option>`).join('')
  sel.value = S.settings.quality
  $('menuQuality').innerHTML = S.qualities.map(q => `<button data-q="${q.key}" class="${q.key === S.settings.quality ? 'on' : ''}">${q.key === S.settings.quality ? '● ' : '○ '}${esc(q.label)}</button>`).join('')
  $('menuClip').textContent = (S.settings.autoClipboard ? '✓ ' : '　 ') + '自动识别剪贴板里的链接'
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
  $('pvPlatform').textContent = p.platformLabel + (p.source ? ' · ' + (p.engine === 'ytdlp' ? '解析引擎' : '原生解析（无水印）') : '')
  $('pvTitle').textContent = p.title
  $('pvAuthor').textContent = p.author ? '@' + p.author : ''
  $('pvBadge').textContent = p.isImages ? '图集' : (p.entries > 1 ? `${p.entries} 个视频` : '')
  $('pvDur').textContent = p.durationText || ''
  const meta = []
  if (p.isImages) { meta.push(`${p.images.length} 张图片`); if (p.liveCount) meta.push(`含 ${p.liveCount} 个实况`) }
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
  const st = await api.loginStatus()
  openModal(`<h2>登录平台账号（可选）</h2>
    <p>大部分作品不用登录就能下载。遇到「需要登录」「年龄限制」或想要 B 站 1080p 时再登录。登录状态只保存在这台电脑上。</p>
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
}

async function openAbout() {
  const [info, notice] = await Promise.all([api.engineInfo(), api.notice()])
  openModal(`<div class="about-head"><img src="icon.png" alt=""><div><h2 style="margin:0">拾影 电脑版</h2><div>版本 ${esc(S.version)} · Windows</div></div></div>
    <h3>解析引擎</h3>
    <div class="kv"><span>yt-dlp</span><span>${esc(info.ytdlp || '未安装')}</span><span>ffmpeg</span><span>${esc(info.ffmpeg || '未安装')}</span>
      <span>Deno</span><span>${esc(info.deno || '未安装（只影响 YouTube）')}</span><span>位置</span><span style="word-break:break-all">${esc(info.binDir)}</span></div>
    <h3>支持平台</h3>
    <p><b>原生解析：</b>抖音（无水印）、快手、小红书（视频 + 图集）<br><b>yt-dlp 解析：</b>哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo 及 yt-dlp 支持的其他网站<br><b>不支持：</b>视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容</p>
    <h3>使用须知</h3>
    <p>${esc(NOTICE_TEXT)}</p>
    <h3>许可证</h3>
    <p>GPL-3.0（使用 yt-dlp、ffmpeg 等组件，第三方组件见下）。</p>
    <pre>${esc(notice || '')}</pre>`)
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
      case 'about': openAbout(); break
    }
  }
  $('modalX').onclick = closeModal
  $('modal').onclick = e => { if (e.target === $('modal')) closeModal() }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); show('menu', false) } })
}

wire()
init()
