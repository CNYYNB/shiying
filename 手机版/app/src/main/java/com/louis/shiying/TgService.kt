package com.louis.shiying

import com.louis.shiying.mtproto.TgApi
import com.louis.shiying.mtproto.TlObj
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Telegram part of a [Post]: where the messages are and what to download. */
data class TgPost(
    /** "username" (with [username]) or "channel" (with [channelId]); [userPeer] when the chat is a user (bot) instead of a channel. */
    val chatKind: String,
    val username: String?,
    val channelId: Long?,
    val userPeer: Boolean,
    val msgIds: List<Int>,
    val items: List<TgItem>,
    val summary: String,
    val totalSize: Long,
)

/** Where downloaded files go (MediaStore on Android, a directory in tests). One [open] per file, then [commit] or [discard]. */
interface TgSink {
    fun open(index: Int, item: TgItem, baseName: String): OutputStream
    fun commit(index: Int)
    fun discard(index: Int)
}

/**
 * Telegram link → [Post] and download, through an MTProto [TgApi] (logged in). Same flow as the PC version (telegram.js):
 * resolve chat (username / private channel via dialogs) → comments via the linked discussion group → message (+ album)
 * → refuse noforwards → largest media. Pure JVM; the API is injected (tests use a fake).
 */
class TgService(private val apiProvider: () -> TgApi, private val diag: (String) -> Unit = {}) {

    class Chat(val obj: TlObj, val isChannel: Boolean) {
        val id: Long get() = obj.long("id") ?: 0
        val accessHash: Long get() = obj.long("access_hash") ?: 0
        val title: String get() = obj.str("title") ?: listOfNotNull(obj.str("first_name"), obj.str("last_name")).joinToString(" ").ifBlank { obj.str("username") ?: "" }
        val username: String? get() = obj.str("username") ?: obj.objs("usernames").firstOrNull { it.flag("active") }?.str("username")
        fun inputChannel() = TlObj.of("inputChannel", "channel_id" to id, "access_hash" to accessHash)
        fun inputPeer() = if (isChannel) TlObj.of("inputPeerChannel", "channel_id" to id, "access_hash" to accessHash)
            else TlObj.of("inputPeerUser", "user_id" to id, "access_hash" to accessHash)
    }

    private fun remember(api: TgApi, chats: List<TlObj>, users: List<TlObj>) {
        for (c in chats) if (c.type == "channel" && c.flag("min").not()) c.long("access_hash")?.let { api.session.peers["c${c.long("id")}"] = it }
        for (u in users) if (u.type == "user" && u.flag("min").not()) u.long("access_hash")?.let { api.session.peers["u${u.long("id")}"] = it }
    }

    private fun chatOf(obj: TlObj?): Chat {
        if (obj == null) throw TgError("no_access", "没有权限看这条消息：你的账号不在这个频道 / 群组里，或已被移出 / 封禁。请先用这个账号在 Telegram 里加入，再复制消息链接")
        return when (obj.type) {
            "channel" -> Chat(obj, true)
            "user" -> Chat(obj, false)
            "channelForbidden", "chatForbidden" -> throw TgError("no_access", "没有权限看这条消息：你的账号不在这个频道 / 群组里，或已被移出 / 封禁。请先用这个账号在 Telegram 里加入，再复制消息链接")
            else -> throw TgError("invalid", "这个链接指向的聊天类型拾影不支持（${obj.type}）")
        }
    }

    private fun byUsername(api: TgApi, name: String): Chat {
        val r = api.call(TlObj.of("contacts.resolveUsername", "flags" to 0, "username" to name)) as TlObj
        remember(api, r.objs("chats"), r.objs("users"))
        val peer = r.obj("peer")
        return when (peer?.type) {
            "peerChannel" -> chatOf(r.objs("chats").firstOrNull { it.long("id") == peer.long("channel_id") })
            "peerUser" -> chatOf(r.objs("users").firstOrNull { it.long("id") == peer.long("user_id") })
            else -> throw TgError("invalid", "这个链接指向的聊天类型拾影不支持")
        }
    }

    private fun channelById(api: TgApi, id: Long): Chat? {
        val hash = api.session.peers["c$id"] ?: return null
        val r = api.call(TlObj.of("channels.getChannels", "id" to listOf(TlObj.of("inputChannel", "channel_id" to id, "access_hash" to hash)))) as TlObj
        remember(api, r.objs("chats"), emptyList())
        return chatOf(r.objs("chats").firstOrNull { it.long("id") == id })
    }

    /** Reads the dialog list (where private channels' access_hash comes from) until [id] is found. */
    private fun scanDialogs(api: TgApi, id: Long, log: (String) -> Unit): Boolean {
        log("正在读取你的对话列表（私密频道 / 群组需要）…")
        return scanFolder(api, id, null) || scanFolder(api, id, 1) // main list, then 已归档
    }

    private fun scanFolder(api: TgApi, id: Long, folder: Int?): Boolean {
        var offsetDate = 0; var offsetId = 0; var offsetPeer: TlObj = TlObj.of("inputPeerEmpty")
        for (page in 0 until 30) {
            val r = api.call(TlObj.of("messages.getDialogs", "folder_id" to folder, "offset_date" to offsetDate, "offset_id" to offsetId,
                "offset_peer" to offsetPeer, "limit" to 100, "hash" to 0L)) as TlObj
            val chats = r.objs("chats"); val users = r.objs("users")
            remember(api, chats, users)
            if (api.session.peers.containsKey("c$id")) return true
            val dialogs = r.objs("dialogs")
            if (r.type == "messages.dialogs" || dialogs.size < 100 || r.type == "messages.dialogsNotModified") return false
            val last = dialogs.last()
            val lp = last.obj("peer")
            val msgs = r.objs("messages")
            val lm = msgs.firstOrNull { it.int("id") == last.int("top_message") && samePeer(it.obj("peer_id"), lp) }
            offsetId = last.int("top_message") ?: 0
            offsetDate = lm?.int("date") ?: 0
            offsetPeer = when (lp?.type) {
                "peerChannel" -> TlObj.of("inputPeerChannel", "channel_id" to lp.long("channel_id"), "access_hash" to (api.session.peers["c${lp.long("channel_id")}"] ?: 0L))
                "peerUser" -> TlObj.of("inputPeerUser", "user_id" to lp.long("user_id"), "access_hash" to (api.session.peers["u${lp.long("user_id")}"] ?: 0L))
                "peerChat" -> TlObj.of("inputPeerChat", "chat_id" to lp.long("chat_id"))
                else -> TlObj.of("inputPeerEmpty")
            }
        }
        return false
    }

    private fun samePeer(a: TlObj?, b: TlObj?) = a != null && b != null && a.type == b.type && a.f.filterKeys { it != "flags" } == b.f.filterKeys { it != "flags" }

    private fun isFatal(e: Exception) = TgSupport.classify(e).kind in setOf("flood", "net", "session")

    fun entityFor(api: TgApi, kind: String, username: String?, channelId: Long?, log: (String) -> Unit = {}): Chat {
        if (kind == "username") return byUsername(api, username!!)
        val id = channelId!!
        try { channelById(api, id)?.let { return it } } catch (e: Exception) {
            if (e is TgError || isFatal(e)) throw e
            diag("getChannels(c/$id) 失败：${e.message}，读取对话列表后重试")
        }
        if (scanDialogs(api, id, log)) {
            try { channelById(api, id)?.let { return it } } catch (e: Exception) { if (e is TgError || isFatal(e)) throw e }
        }
        throw TgError("no_access", "没有找到这个私密频道 / 群组：你的账号可能不在里面。请先用这个账号在 Telegram 里加入，再复制消息链接")
    }

    fun getMessages(api: TgApi, chat: Chat, ids: List<Int>): List<TlObj> {
        val input = ids.map { TlObj.of("inputMessageID", "id" to it) }
        val r = if (chat.isChannel) api.call(TlObj.of("channels.getMessages", "channel" to chat.inputChannel(), "id" to input)) as TlObj
            else api.call(TlObj.of("messages.getMessages", "id" to input)) as TlObj
        remember(api, r.objs("chats"), r.objs("users"))
        return r.objs("messages")
    }

    private fun fetchOne(api: TgApi, chat: Chat, id: Int): TlObj {
        val m = getMessages(api, chat, listOf(id)).firstOrNull { it.int("id") == id }
        if (m == null || m.type == "messageEmpty") throw TgError("deleted", "这条消息不存在或已被删除（也可能是你的账号看不到它）")
        if (m.type == "messageService") throw TgError("invalid", "这是一条系统消息，里面没有视频或图片")
        return m
    }

    /** Link → Post. [saveCover] stores cover bytes and returns a loadable reference (or null). */
    fun resolve(link: TgLink, log: (String) -> Unit = {}, saveCover: (ByteArray) -> String? = { null }): Post {
        try {
            log("正在连接 Telegram…")
            val api = apiProvider()
            log("正在读取消息…")
            var chat = entityFor(api, link.kind, link.username, link.channelId?.toLongOrNull(), log)
            diag("解析：${if (link.kind == "channel") "c/" + link.channelId else "@" + link.username} 消息 ${link.msgId}" +
                (link.commentId?.let { " 评论 $it" } ?: "") + (if (link.single) " single" else "") + " → ${chat.obj.type}")
            if (TgSupport.isProtected(null, chat.obj)) throw TgError("protected", TgSupport.PROTECTED_MSG)
            var msgId = link.msgId
            if (link.commentId != null) {
                log("正在读取评论区…")
                val d = api.call(TlObj.of("messages.getDiscussionMessage", "peer" to chat.inputPeer(), "msg_id" to link.msgId)) as TlObj
                remember(api, d.objs("chats"), d.objs("users"))
                val top = d.objs("messages").firstOrNull()
                val gid = top?.obj("peer_id")?.takeIf { it.type == "peerChannel" }?.long("channel_id")
                val group = d.objs("chats").firstOrNull { gid != null && it.long("id") == gid }
                    ?: throw TgError("no_access", "读不到这条帖子的评论区（评论区可能已关闭，或你没有权限）")
                chat = chatOf(group)
                if (TgSupport.isProtected(null, chat.obj)) throw TgError("protected", TgSupport.PROTECTED_MSG)
                msgId = link.commentId
            }
            val first = fetchOne(api, chat, msgId)
            if (TgSupport.isProtected(first, chat.obj)) throw TgError("protected", TgSupport.PROTECTED_MSG)
            var msgs = listOf(first)
            if (first.long("grouped_id") != null && !link.single) {
                log("正在读取相册…")
                msgs = TgSupport.albumOf(first, getMessages(api, chat, TgSupport.albumWindow(msgId)))
                if (msgs.any { TgSupport.isProtected(it, chat.obj) }) throw TgError("protected", TgSupport.PROTECTED_MSG)
            }
            val items = msgs.flatMap { TgSupport.mediaItems(it) }
            if (items.isEmpty()) throw TgError("no_media", TgSupport.noMediaReason(first))
            val text = (msgs.firstOrNull { !it.str("message").isNullOrBlank() } ?: first).str("message") ?: ""
            val uname = chat.username
            val slug = uname ?: "c${chat.id}"
            val videos = items.filter { it.isVideo }
            val imgs = items.size - videos.size
            val summary = listOfNotNull(if (imgs > 0) "$imgs 张图片" else null, if (videos.isNotEmpty()) "${videos.size} 个视频" else null).joinToString(" + ")
            val total = items.sumOf { it.size }
            val v0 = videos.firstOrNull()
            val cover = try { coverOf(api, msgs.first { it.int("id") == items[0].msgId })?.let(saveCover) } catch (e: Exception) { diag("封面下载失败：${e.message}"); null }
            diag("找到 ${items.size} 个文件：" + items.joinToString(", ") { "${it.kind}${if (it.alt >= 0) "(alt${it.alt})" else ""} ${it.size}B" })
            val tg = TgPost(if (uname != null) "username" else "channel", uname, chat.id, !chat.isChannel, msgs.map { it.int("id") ?: 0 }, items,
                (if (items.size > 1) "相册：" else "") + summary, total)
            return Post(
                id = "${slug}_$msgId", isImages = videos.isEmpty(), desc = text, author = chat.title.ifBlank { slug }, cover = cover,
                durationMs = v0?.let { (it.duration * 1000).toLong() } ?: 0L, videoUrls = emptyList(),
                images = if (videos.isEmpty()) items.map { ImageItem(emptyList(), emptyList()) } else emptyList(),
                source = "Telegram 账号", platform = Platform.TELEGRAM, pageUrl = link.url, engine = "telegram", entries = items.size,
                height = v0?.let { minOf(if (it.w > 0) it.w else it.h, if (it.h > 0) it.h else it.w) } ?: 0, tg = tg,
            )
        } catch (e: Cancelled) { throw e } catch (e: Exception) { throw TgSupport.classify(e, "parse") }
    }

    private fun coverOf(api: TgApi, msg: TlObj): ByteArray? {
        val m = msg.obj("media") ?: return null
        val (owner, sizes, photo) = when (m.type) {
            "messageMediaPhoto" -> Triple(m.obj("photo"), m.obj("photo")?.objs("sizes"), true)
            "messageMediaDocument" -> Triple(m.obj("document"), m.obj("document")?.objs("thumbs"), false)
            else -> return null
        }
        owner ?: return null
        val ok = (sizes ?: emptyList()).filter { (it.type == "photoSize" || it.type == "photoCachedSize") && !it.str("type").isNullOrEmpty() }
        val pick = ok.filter { (it.int("w") ?: 0) <= 800 }.maxByOrNull { it.int("w") ?: 0 } ?: ok.minByOrNull { it.int("w") ?: 0 } ?: return null
        if (pick.type == "photoCachedSize") return pick.bytes("bytes")
        val loc = location(owner, photo, pick.str("type")!!)
        val out = java.io.ByteArrayOutputStream()
        var off = 0L
        while (out.size() < 2 * 1024 * 1024) {
            val part = getPart(api, loc, owner.int("dc_id"), off, CHUNK)
            out.write(part)
            if (part.size < CHUNK) break
            off += CHUNK
        }
        return out.toByteArray().takeIf { it.isNotEmpty() && it.size <= 2 * 1024 * 1024 }
    }

    private fun location(owner: TlObj, photo: Boolean, thumb: String): TlObj =
        if (photo) TlObj.of("inputPhotoFileLocation", "id" to owner.long("id"), "access_hash" to owner.long("access_hash"),
            "file_reference" to (owner.bytes("file_reference") ?: ByteArray(0)), "thumb_size" to thumb)
        else TlObj.of("inputDocumentFileLocation", "id" to owner.long("id"), "access_hash" to owner.long("access_hash"),
            "file_reference" to (owner.bytes("file_reference") ?: ByteArray(0)), "thumb_size" to thumb)

    private fun getPart(api: TgApi, loc: TlObj, dc: Int?, offset: Long, limit: Int): ByteArray {
        val r = api.call(TlObj.of("upload.getFile", "location" to loc, "offset" to offset, "limit" to limit), dc, 60_000) as TlObj
        if (r.type != "upload.file") throw TgError("other", "Telegram 要求从 CDN 下载这个文件（${r.type}），拾影暂不支持")
        return r.bytes("bytes") ?: ByteArray(0)
    }

    /**
     * Downloads every item of [post] into [sink]. Messages are fetched again first (file references expire) and checked for
     * deletion / noforwards before anything is written. Cancel → [Cancelled] after discarding the current file
     * (the caller rolls back the files already committed). progress(text, pct)
     */
    fun download(post: Post, sink: TgSink, cancelled: () -> Boolean, progress: (String, Int) -> Unit, parallel: Int = 4): Int {
        val tg = post.tg ?: throw UserError("作品信息不完整，请重新解析")
        if (tg.items.isEmpty()) throw UserError("作品信息不完整，请重新解析")
        val base = Links.fileBase(post.author, post.desc, post.id, "Telegram")
        try {
            if (cancelled()) throw Cancelled()
            val api = apiProvider()
            val chat = entityFor(api, tg.chatKind, tg.username, tg.channelId)
            if (TgSupport.isProtected(null, chat.obj)) throw TgError("protected", TgSupport.PROTECTED_MSG)
            val byId = getMessages(api, chat, tg.msgIds).filter { it.type == "message" }.associateBy { it.int("id") }
            tg.items.forEachIndexed { i, it ->
                val m = byId[it.msgId] ?: throw TgError("deleted", "第 ${i + 1} 个文件所在的消息已被删除")
                if (TgSupport.isProtected(m, chat.obj)) throw TgError("protected", TgSupport.PROTECTED_MSG)
            }
            val total = tg.totalSize
            var doneBefore = 0L
            val n = tg.items.size
            for ((i, it) in tg.items.withIndex()) {
                val msg = byId[it.msgId]!!
                val fresh = TgSupport.mediaItems(msg).firstOrNull() ?: throw TgError("deleted", "第 ${i + 1} 个文件已不存在")
                val what = if (fresh.isVideo) "视频" else "图片"
                val label = if (n > 1) "正在下载$what（${i + 1}/$n）" else "正在下载$what"
                val media = msg.obj("media")!!
                val (owner, isPhoto, thumb) = if (media.type == "messageMediaPhoto") {
                    val ph = media.obj("photo")!!; Triple(ph, true, TgSupport.bestPhotoSize(ph)!!.first)
                } else {
                    val d = if (fresh.alt >= 0) media.objs("alt_documents")[fresh.alt] else media.obj("document")!!
                    Triple(d, false, "")
                }
                val name = if (n > 1) "$base-${i + 1}" else base
                val os = sink.open(i, fresh, name)
                var ok = false
                try {
                    val got = os.use { o ->
                        fetchFile(api, location(owner, isPhoto, thumb), owner.int("dc_id"), if (isPhoto) 0 else fresh.size, o, cancelled, parallel) { d ->
                            val all = if (total > 0) total else fresh.size
                            progress("$label ${mbText(doneBefore + d, all)}", if (all > 0) ((doneBefore + d) * 100 / all).toInt().coerceIn(0, 100) else -1)
                        }
                    }
                    if (got == 0L) throw TgError("other", "下载内容为空")
                    if (!isPhoto && fresh.size > 0 && got < fresh.size) throw TgError("other", "下载不完整（$got/${fresh.size} 字节），请重试")
                    sink.commit(i); ok = true
                } finally { if (!ok) sink.discard(i) }
                doneBefore += fresh.size
            }
            progress("完成", 100)
            return n
        } catch (e: Cancelled) { throw e } catch (e: UserError) { throw e } catch (e: Exception) {
            if (cancelled()) throw Cancelled()
            throw TgSupport.classify(e, "download")
        }
    }

    /** Streams one file in 512 KB parts, [parallel] requests in flight (written in order). Returns bytes written. */
    private fun fetchFile(api: TgApi, loc: TlObj, dc: Int?, size: Long, out: OutputStream, cancelled: () -> Boolean, parallel: Int, onBytes: (Long) -> Unit): Long {
        val pool = Executors.newFixedThreadPool(if (size > 0) parallel.coerceAtLeast(1) else 1)
        try {
            val parts = if (size > 0) ((size + CHUNK - 1) / CHUNK).toInt() else Int.MAX_VALUE
            val inFlight = ArrayDeque<Future<ByteArray>>()
            var next = 0
            var written = 0L
            var lastTick = 0L
            fun submit() { val off = next.toLong() * CHUNK; inFlight.addLast(pool.submit(Callable { getPart(api, loc, dc, off, CHUNK) })); next++ }
            val window = if (size > 0) parallel.coerceAtLeast(1) else 1
            while (true) {
                if (cancelled()) throw Cancelled()
                while (inFlight.size < window && next < parts) submit()
                val f = inFlight.removeFirstOrNull() ?: break
                val bytes = try { f.get() } catch (e: ExecutionException) { throw (e.cause as? Exception) ?: e }
                if (cancelled()) throw Cancelled()
                out.write(bytes)
                written += bytes.size
                val now = System.currentTimeMillis()
                if (now - lastTick > 300) { lastTick = now; onBytes(written) }
                if (bytes.size < CHUNK) { inFlight.forEach { it.cancel(true) }; break }
                if (size in 1..written) { inFlight.forEach { it.cancel(true) }; break }
            }
            onBytes(written)
            return written
        } finally { pool.shutdownNow() }
    }

    private fun mbText(done: Long, total: Long): String {
        fun mb(b: Long) = "%.1f MB".format(b / 1048576.0)
        return if (total > 0) "${mb(done)} / ${mb(total)}" else mb(done)
    }

    companion object {
        const val CHUNK = 512 * 1024
    }
}
