'use strict'
/**
 * Telegram 解析与下载（MTProto 用户登录，GramJS）。不依赖 Electron：客户端由主进程注入（测试里用假的）。
 *
 *   const tg = new TelegramService({ getClient, Api, bigInt })
 *   const post = await tg.resolve(TgS.parseLink(url), { log })
 *   const files = await tg.download(post, saveDir, { signal, onProgress })
 *
 * getClient()：返回已连接、已登录的 GramJS TelegramClient（没登录 / 连不上时抛错）。
 * 判断媒体类型只看 className，所以测试可以用普通对象模拟消息。
 */
const fs = require('fs')
const path = require('path')
const TgS = require('./telegram-support')
const { makePost, UserError, Cancelled } = require('./post')
const { fileBase } = require('./links')
const { uniquePath } = require('./downloader')

class TgError extends UserError {
  constructor(kind, msg) { super(msg); this.name = 'TgError'; this.tgKind = kind }
}

/** 任意错误 → TgError（中文）；Cancelled / 已经是 TgError 的原样返回 */
function wrap(e, stage) {
  if (e instanceof Cancelled || e instanceof UserError) return e
  const c = TgS.classifyError(e, stage)
  return new TgError(c.kind, c.message)
}

const chatRef = ent => {
  if (!ent) return null
  if (ent.className === 'Channel' || ent.className === 'ChannelForbidden') return ent.username ? { kind: 'username', username: ent.username, channelId: String(ent.id) } : { kind: 'channel', channelId: String(ent.id) }
  if (ent.className === 'User') return ent.username ? { kind: 'username', username: ent.username } : null
  return null
}

const chatTitle = ent => {
  if (!ent) return ''
  if (ent.title) return ent.title
  return [ent.firstName, ent.lastName].filter(Boolean).join(' ') || ent.username || ''
}

/** 缩略图：最大的、宽度 ≤ 800 的普通尺寸（没有就用最小的） */
function coverThumbType(sizes) {
  const ok = (sizes || []).filter(s => s && (s.className === 'PhotoSize' || s.className === 'PhotoCachedSize') && s.type)
  const small = ok.filter(s => (s.w || 0) <= 800).sort((a, b) => (b.w || 0) - (a.w || 0))
  if (small.length) return small[0].type
  if (ok.length) return ok.sort((a, b) => (a.w || 0) - (b.w || 0))[0].type
  return null
}

class TelegramService {
  /**
   * @param {object} o
   * @param {() => Promise<any>} o.getClient
   * @param {any} o.Api  GramJS 的 Api（PeerChannel、messages.GetDiscussionMessage）；或带 __lazy 标记的函数
   * @param {(s:string)=>any} o.bigInt
   * @param {(s:string)=>void} [o.log]  诊断日志（调用方负责脱敏）
   */
  constructor({ getClient, Api, bigInt, log }) {
    this.getClient = getClient
    this._api = Api
    this._bigInt = bigInt || (s => s)
    this.diag = log || (() => {})
  }

  /** Api / bigInt 可以是懒加载函数（主进程在第一次用到 Telegram 时才加载 GramJS） */
  get Api() { return this._api && this._api.__lazy ? this._api() : this._api }
  bigInt(s) { return this._bigInt.__lazy ? this._bigInt()(s) : this._bigInt(s) }

  async entityFor(client, ref, log = () => {}) {
    if (ref.kind === 'username') return client.getEntity(ref.username)
    const peer = new this.Api.PeerChannel({ channelId: this.bigInt(ref.channelId) })
    try { return await client.getEntity(peer) } catch (e) {
      const c = TgS.classifyError(e)
      if (c.kind === 'flood' || c.kind === 'net' || c.kind === 'session') throw e
      // 新登录的会话不认识这个私密频道：读一遍对话列表（里面有 access_hash）再试
      log('正在读取你的对话列表（私密频道 / 群组需要）…')
      this.diag(`getEntity(c/${ref.channelId}) 失败：${e?.errorMessage || e?.message}，读取对话列表后重试`)
      await client.getDialogs({ limit: 3000 })
      try { return await client.getEntity(peer) } catch (e2) {
        const c2 = TgS.classifyError(e2)
        if (c2.kind === 'flood' || c2.kind === 'net' || c2.kind === 'session') throw e2
        throw new TgError('no_access', '没有找到这个私密频道 / 群组：你的账号可能不在里面。请先用这个账号在 Telegram 里加入，再复制消息链接')
      }
    }
  }

  async fetchOne(client, chat, id) {
    const res = await client.getMessages(chat, { ids: [id] })
    const m = res && res[0]
    if (!m || m.className === 'MessageEmpty') throw new TgError('deleted', '这条消息不存在或已被删除（也可能是你的账号看不到它）')
    if (m.className === 'MessageService') throw new TgError('invalid', '这是一条系统消息，里面没有视频或图片')
    return m
  }

  /** 链接 → 作品（Post）。link 来自 TgS.parseLink */
  async resolve(link, { log = () => {} } = {}) {
    try {
      log('正在连接 Telegram…')
      const client = await this.getClient()
      log('正在读取消息…')
      let chat = await this.entityFor(client, link, log)
      this.diag(`解析：${link.kind === 'channel' ? 'c/' + link.channelId : '@' + link.username} 消息 ${link.msgId}${link.commentId ? ' 评论 ' + link.commentId : ''}${link.single ? ' single' : ''} → ${chat?.className}`)
      if (TgS.isProtected(null, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
      let msgId = link.msgId
      if (link.commentId) {
        log('正在读取评论区…')
        const d = await client.invoke(new this.Api.messages.GetDiscussionMessage({ peer: chat, msgId: link.msgId }))
        const top = (d.messages || [])[0]
        const gid = top?.peerId?.channelId != null ? String(top.peerId.channelId) : null
        const group = (d.chats || []).find(c => gid && String(c.id) === gid)
        if (!group) throw new TgError('no_access', '读不到这条帖子的评论区（评论区可能已关闭，或你没有权限）')
        chat = group
        if (TgS.isProtected(null, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
        msgId = link.commentId
      }
      const first = await this.fetchOne(client, chat, msgId)
      if (TgS.isProtected(first, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
      let msgs = [first]
      if (first.groupedId != null && !link.single) {
        log('正在读取相册…')
        const around = await client.getMessages(chat, { ids: TgS.albumWindow(msgId) })
        msgs = TgS.albumOf(first, [...(around || [])])
        if (msgs.some(m => TgS.isProtected(m, chat))) throw new TgError('protected', TgS.PROTECTED_MSG)
      }
      const items = msgs.flatMap(m => TgS.mediaItems(m))
      if (!items.length) throw new TgError('no_media', TgS.noMediaReason(first))
      const text = (msgs.find(m => m.message && m.message.trim()) || first).message || ''
      const ref = chatRef(chat) || (link.kind === 'channel' ? { kind: 'channel', channelId: link.channelId } : { kind: 'username', username: link.username })
      const slug = ref.kind === 'username' ? ref.username : 'c' + ref.channelId
      const videos = items.filter(i => i.kind === 'video' || i.kind === 'gif')
      const imgs = items.length - videos.length
      const summary = [imgs ? `${imgs} 张图片` : '', videos.length ? `${videos.length} 个视频` : ''].filter(Boolean).join(' + ')
      const totalSize = items.reduce((s, i) => s + (i.size || 0), 0)
      const v0 = videos[0]
      let cover = null
      try { cover = await this.coverOf(client, msgs.find(m => m.id === items[0].msgId)) } catch (e) { this.diag('封面下载失败：' + (e?.errorMessage || e?.message)) }
      this.diag(`找到 ${items.length} 个文件：${items.map(i => `${i.kind}${i.alt >= 0 ? '(alt' + i.alt + ')' : ''} ${i.size}B`).join(', ')}`)
      return makePost({
        id: `${slug}_${msgId}`, isImages: videos.length === 0, desc: text, author: chatTitle(chat) || slug, cover,
        durationMs: v0 ? Math.round(v0.duration * 1000) : 0, height: v0 ? Math.min(v0.w || v0.h, v0.h || v0.w) || 0 : 0,
        images: videos.length === 0 ? items.map(() => ({ urls: [], liveVideoUrls: [] })) : [],
        entries: items.length, source: 'telegram', platform: 'TELEGRAM', pageUrl: link.url, engine: 'telegram',
        tg: { chat: ref, msgIds: msgs.map(m => m.id), items, summary: (items.length > 1 ? '相册：' : '') + summary, totalSize },
      })
    } catch (e) { throw wrap(e, 'parse') }
  }

  async coverOf(client, msg) {
    if (!msg) return null
    const m = msg.media
    const sizes = m?.className === 'MessageMediaPhoto' ? m.photo?.sizes : m?.document?.thumbs
    const type = coverThumbType(sizes)
    if (!type) return null
    const buf = await client.downloadMedia(msg, { thumb: type })
    if (!buf || !Buffer.isBuffer(buf) || !buf.length || buf.length > 2 * 1024 * 1024) return null
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  }

  /**
   * 下载作品到 saveDir：单个文件 → saveDir/名.ext；多个（相册）→ saveDir/名/01.ext、02.ext…
   * onProgress({ pct, done, total, text })。取消：signal.abort() → 删掉这次写下的文件，抛 Cancelled。
   */
  async download(post, saveDir, { signal, onProgress = () => {} } = {}) {
    const tg = post.tg
    if (!tg || !tg.items?.length) throw new UserError('作品信息不完整，请重新解析')
    const written = []
    try {
      if (signal?.aborted) throw new Cancelled()
      const client = await this.getClient()
      const chat = await this.entityFor(client, tg.chat)
      if (TgS.isProtected(null, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
      // 重新取消息：文件引用（file_reference）会过期
      const res = await client.getMessages(chat, { ids: tg.msgIds })
      const byId = new Map([...(res || [])].filter(m => m && m.className === 'Message').map(m => [m.id, m]))
      // 先全部检查一遍（被删 / 禁止保存），再开始写文件
      for (let i = 0; i < tg.items.length; i++) {
        const msg = byId.get(tg.items[i].msgId)
        if (!msg) throw new TgError('deleted', `第 ${i + 1} 个文件所在的消息已被删除`)
        if (TgS.isProtected(msg, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
      }
      const base = fileBase(post.author, post.desc || '', post.id, 'Telegram')
      const multi = tg.items.length > 1
      let dir = saveDir
      if (multi) { dir = uniquePath(path.join(saveDir, base)); fs.mkdirSync(dir, { recursive: true }); written.push(dir) }
      const total = tg.totalSize || 0
      let doneBefore = 0
      for (let i = 0; i < tg.items.length; i++) {
        const it = tg.items[i]
        const msg = byId.get(it.msgId)
        if (!msg) throw new TgError('deleted', `第 ${i + 1} 个文件所在的消息已被删除`)
        if (TgS.isProtected(msg, chat)) throw new TgError('protected', TgS.PROTECTED_MSG)
        const fresh = TgS.mediaItems(msg)[0]
        if (!fresh) throw new TgError('deleted', `第 ${i + 1} 个文件已不存在`)
        const what = fresh.kind === 'video' || fresh.kind === 'gif' ? '视频' : '图片'
        const label = multi ? `正在下载${what}（${i + 1}/${tg.items.length}）` : `正在下载${what}`
        const dest = uniquePath(multi ? path.join(dir, String(i + 1).padStart(2, '0') + fresh.ext) : path.join(saveDir, base + fresh.ext))
        const media = fresh.alt >= 0 ? msg.media.altDocuments[fresh.alt] : msg
        await this.fetchFile(client, media, dest, fresh.kind === 'photo' ? 0 : fresh.size, {
          signal, onProgress: d => {
            const all = total || fresh.size || 0
            onProgress({ pct: all ? Math.min(100, (doneBefore + d) * 100 / all) : 0, done: doneBefore + d, total: all, text: label })
          },
        })
        written.push(dest)
        doneBefore += fresh.size || 0
      }
      onProgress({ pct: 100, done: total, total, text: '完成' })
      return written
    } catch (e) {
      const err = wrap(e, 'download')
      if (err instanceof Cancelled || signal?.aborted) {
        for (const f of written.reverse()) fs.rmSync(f, { recursive: true, force: true })
        throw new Cancelled()
      }
      // 失败：保留已下完的文件，只删空的相册文件夹
      if (written[0] && fs.existsSync(written[0]) && fs.statSync(written[0]).isDirectory() && !fs.readdirSync(written[0]).length) fs.rmSync(written[0], { recursive: true, force: true })
      throw err
    }
  }

  /** 下载一个媒体到 dest（先写 dest.part）。取消立即返回（不等当前分块） */
  async fetchFile(client, media, dest, size, { signal, onProgress }) {
    const part = dest + '.part'
    const fd = fs.openSync(part, 'w')
    let stopped = false, closed = false
    const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd) } catch {} } }
    const writer = {
      write: chunk => { if (stopped || signal?.aborted) throw new Cancelled(); fs.writeSync(fd, chunk) },
      close: () => {},
    }
    let onAbort
    const aborted = new Promise((_, rej) => {
      onAbort = () => { stopped = true; rej(new Cancelled()) }
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    })
    aborted.catch(() => {})
    try {
      let last = 0
      const job = client.downloadMedia(media, {
        outputFile: writer,
        progressCallback: done => {
          if (stopped || signal?.aborted) throw new Cancelled()
          const now = Date.now(); if (now - last > 200) { last = now; onProgress(TgS.num(done)) }
        },
      })
      job.catch(() => {})
      await Promise.race([job, aborted])
      stopped = true
      close()
      const got = fs.statSync(part).size
      if (!got) throw new TgError('other', '下载内容为空')
      if (size && got < size) throw new TgError('other', `下载不完整（${got}/${size} 字节），请重试`)
      onProgress(got)
      fs.renameSync(part, dest)
      return dest
    } catch (e) {
      stopped = true
      close()
      fs.rmSync(part, { force: true })
      throw e
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

module.exports = { TelegramService, TgError, wrap, coverThumbType, chatRef }
