package com.louis.shiying

import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgApi
import com.louis.shiying.mtproto.TgDevice
import com.louis.shiying.mtproto.TgSession
import com.louis.shiying.mtproto.TlObj
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.Collections

/** TgService resolve / download flows and TgAccount storage with a fake MTProto API (no network). */
class TgServiceTest {
    private val CH = 1987654321L
    private val GROUP = 1555L

    private fun channel(id: Long, title: String, username: String? = null, noforwards: Boolean = false, hash: Long = -55L) =
        TlObj.of("channel", "id" to id, "access_hash" to hash, "title" to title, "username" to username, "noforwards" to noforwards, "broadcast" to true)

    private fun photo(id: Long) = TlObj.of("photo", "id" to id, "access_hash" to 1L, "file_reference" to byteArrayOf(1), "date" to 0, "dc_id" to 4, "sizes" to listOf(
        TlObj.of("photoSize", "type" to "m", "w" to 320, "h" to 180, "size" to 1000),
        TlObj.of("photoSizeProgressive", "type" to "y", "w" to 1280, "h" to 720, "sizes" to listOf(100, 2000, 3000))))

    private fun doc(id: Long, size: Long, mime: String = "video/mp4", attrs: List<TlObj> = listOf(TlObj.of("documentAttributeVideo", "duration" to 9.0, "w" to 1920, "h" to 1080))) =
        TlObj.of("document", "id" to id, "access_hash" to 2L, "file_reference" to byteArrayOf(2), "date" to 0, "mime_type" to mime, "size" to size, "dc_id" to 5,
            "attributes" to attrs, "thumbs" to listOf(TlObj.of("photoSize", "type" to "m", "w" to 320, "h" to 180, "size" to 10)))

    private fun msg(id: Int, media: TlObj?, text: String = "", grouped: Long? = null, noforwards: Boolean = false, peer: Long = CH) =
        TlObj.of("message", "id" to id, "peer_id" to TlObj.of("peerChannel", "channel_id" to peer), "date" to 0, "message" to text,
            "media" to media, "grouped_id" to grouped, "noforwards" to noforwards)

    private fun photoMsg(id: Int, text: String = "", grouped: Long? = null, nf: Boolean = false) = msg(id, TlObj.of("messageMediaPhoto", "photo" to photo(id.toLong())), text, grouped, nf)
    private fun videoMsg(id: Int, size: Long, text: String = "", grouped: Long? = null) = msg(id, TlObj.of("messageMediaDocument", "document" to doc(id.toLong(), size)), text, grouped)

    /** Fake Telegram: one public channel @chan (+ private dialogs), a comment group, files served from [files]. */
    inner class FakeApi : TgApi {
        override val session = TgSession(2).apply { userId = 1; authorized += 2 }
        var chan = channel(CH, "测试频道", "chan")
        val messages = HashMap<Int, TlObj>()
        val groupMessages = HashMap<Int, TlObj>()
        val files = HashMap<Long, ByteArray>()
        val calls: MutableList<String> = Collections.synchronizedList(ArrayList())
        var dialogsHaveChannel = true
        var failGetFileAt: Long = -1
        var throwOnResolve: Exception? = null

        override fun call(req: TlObj, dc: Int?, timeoutMs: Long): Any? {
            calls += req.type + (dc?.let { "@$it" } ?: "")
            return when (req.type) {
                "contacts.resolveUsername" -> {
                    throwOnResolve?.let { throw it }
                    if (req.str("username") != "chan") throw RpcError(400, "USERNAME_NOT_OCCUPIED")
                    TlObj.of("contacts.resolvedPeer", "peer" to TlObj.of("peerChannel", "channel_id" to CH), "chats" to listOf(chan), "users" to emptyList<TlObj>())
                }
                "channels.getChannels" -> {
                    val ic = req.objs("id")[0]
                    val id = ic.long("channel_id")
                    val c = if (id == CH && ic.long("access_hash") == chan.long("access_hash")) chan else if (id == GROUP) channel(GROUP, "评论区") else throw RpcError(400, "CHANNEL_INVALID")
                    TlObj.of("messages.chats", "chats" to listOf(c))
                }
                "messages.getDialogs" -> TlObj.of("messages.dialogs", "dialogs" to emptyList<TlObj>(), "messages" to emptyList<TlObj>(),
                    "chats" to if (dialogsHaveChannel && req["folder_id"] == null) listOf(chan) else emptyList(), "users" to emptyList<TlObj>())
                "channels.getMessages" -> {
                    val src = if (req.obj("channel")?.long("channel_id") == GROUP) groupMessages else messages
                    TlObj.of("messages.channelMessages", "pts" to 1, "count" to 1, "topics" to emptyList<TlObj>(), "chats" to emptyList<TlObj>(), "users" to emptyList<TlObj>(),
                        "messages" to req.objs("id").map { src[it.int("id")] ?: TlObj.of("messageEmpty", "id" to it.int("id")) })
                }
                "messages.getDiscussionMessage" -> TlObj.of("messages.discussionMessage", "messages" to listOf(msg(900, null, "帖子", peer = GROUP)),
                    "unread_count" to 0, "chats" to listOf(channel(GROUP, "评论区"), chan), "users" to emptyList<TlObj>())
                "upload.getFile" -> {
                    val loc = req.obj("location")!!
                    val off = req.long("offset")!!; val lim = req.int("limit")!!
                    if (off == failGetFileAt) throw RpcError(420, "FLOOD_WAIT_120")
                    val data = if (loc.str("thumb_size") == "m") ByteArray(50) { 9 } else files[loc.long("id")] ?: ByteArray(0)
                    Thread.sleep(2)
                    TlObj.of("upload.file", "type" to TlObj.of("storage.filePartial"), "mtime" to 0,
                        "bytes" to data.copyOfRange(minOf(off.toInt(), data.size), minOf(data.size, (off + lim).toInt())))
                }
                else -> throw RpcError(400, "METHOD_NOT_FAKED_${req.type}")
            }
        }
    }

    class MemSink : TgSink {
        val open = HashMap<Int, ByteArrayOutputStream>()
        val committed = LinkedHashMap<Int, ByteArray>()
        val names = HashMap<Int, String>()
        val discarded = ArrayList<Int>()
        override fun open(index: Int, item: TgItem, baseName: String): OutputStream = ByteArrayOutputStream().also { open[index] = it; names[index] = baseName + item.ext }
        override fun commit(index: Int) { committed[index] = open[index]!!.toByteArray() }
        override fun discard(index: Int) { discarded += index; open.remove(index) }
    }

    private fun bytes(n: Int, seed: Int) = ByteArray(n) { ((it * 31 + seed) % 251).toByte() }

    @Test fun resolvePublicPhotoWithCover() {
        val api = FakeApi(); api.messages[10] = photoMsg(10, "一张图 #标签")
        var cover: ByteArray? = null
        val p = TgService({ api }).resolve(TgSupport.parseLink("https://t.me/chan/10"), saveCover = { cover = it; "file:///cover.jpg" })
        assertTrue(p.isImages); assertEquals(Platform.TELEGRAM, p.platform); assertEquals("telegram", p.engine)
        assertEquals("chan_10", p.id); assertEquals("测试频道", p.author); assertEquals("一张图 #标签", p.desc)
        assertEquals("file:///cover.jpg", p.cover); assertEquals(50, cover!!.size)
        assertEquals(1, p.images.size); assertEquals("1 张图片", p.tg!!.summary); assertEquals(3000L, p.tg!!.totalSize)
        assertEquals("https://t.me/chan/10", p.link)
        assertEquals(-55L, api.session.peers["c$CH"])
    }

    @Test fun albumSingleAndMixed() {
        val api = FakeApi()
        api.messages[20] = photoMsg(20, "相册说明", grouped = 7); api.messages[21] = videoMsg(21, 2_000_000, grouped = 7); api.messages[22] = photoMsg(22, grouped = 7)
        api.messages[23] = photoMsg(23, grouped = 8)
        val svc = TgService({ api })
        val p = svc.resolve(TgSupport.parseLink("https://t.me/chan/21"))
        assertEquals(listOf(20, 21, 22), p.tg!!.msgIds); assertEquals("相册：2 张图片 + 1 个视频", p.tg!!.summary)
        assertFalse(p.isImages); assertEquals("相册说明", p.desc); assertEquals(3, p.entries); assertEquals(9000L, p.durationMs); assertEquals(1080, p.height)
        val one = svc.resolve(TgSupport.parseLink("https://t.me/chan/21?single"))
        assertEquals(listOf(21), one.tg!!.msgIds); assertEquals("1 个视频", one.tg!!.summary)
    }

    @Test fun protectedContentRefused() {
        val api = FakeApi(); api.messages[30] = photoMsg(30)
        api.chan = channel(CH, "受保护频道", "chan", noforwards = true)
        val e = runCatching { TgService({ api }).resolve(TgSupport.parseLink("https://t.me/chan/30")) }.exceptionOrNull() as TgError
        assertEquals("protected", e.kind); assertEquals("该频道/聊天禁止保存内容，拾影不下载这类内容", e.message)
        val api2 = FakeApi(); api2.messages[31] = photoMsg(31, grouped = 5); api2.messages[32] = photoMsg(32, grouped = 5, nf = true)
        assertEquals(TgSupport.PROTECTED_MSG, runCatching { TgService({ api2 }).resolve(TgSupport.parseLink("https://t.me/chan/31")) }.exceptionOrNull()?.message)
        api2.messages[33] = photoMsg(33, nf = true)
        assertEquals(TgSupport.PROTECTED_MSG, runCatching { TgService({ api2 }).resolve(TgSupport.parseLink("https://t.me/chan/33")) }.exceptionOrNull()?.message)
        assertFalse(api.calls.any { it.startsWith("upload.getFile") })
    }

    @Test fun commentsViaDiscussionGroup() {
        val api = FakeApi(); api.messages[40] = msg(40, null, "帖子")
        api.groupMessages[901] = msg(901, TlObj.of("messageMediaPhoto", "photo" to photo(901)), "评论里的图", peer = GROUP)
        val p = TgService({ api }).resolve(TgSupport.parseLink("https://t.me/chan/40?comment=901"))
        assertEquals("评论里的图", p.desc); assertEquals("评论区", p.author); assertEquals(listOf(901), p.tg!!.msgIds)
        assertEquals("channel", p.tg!!.chatKind); assertEquals(GROUP, p.tg!!.channelId)
        assertTrue(api.calls.contains("messages.getDiscussionMessage"))
    }

    @Test fun privateChannelNeedsDialogScan() {
        val api = FakeApi(); api.messages[50] = photoMsg(50); api.chan = channel(CH, "私密频道", null)
        val logs = ArrayList<String>()
        val p = TgService({ api }).resolve(TgSupport.parseLink("https://t.me/c/$CH/50"), { logs += it })
        assertEquals("c${CH}_50", p.id); assertTrue(logs.any { it.contains("对话列表") })
        assertEquals(1, api.calls.count { it == "messages.getDialogs" })
        // second time: access hash cached, no scan
        TgService({ api }).resolve(TgSupport.parseLink("https://t.me/c/$CH/50"))
        assertEquals(1, api.calls.count { it == "messages.getDialogs" })
        val api2 = FakeApi(); api2.dialogsHaveChannel = false
        val e = runCatching { TgService({ api2 }).resolve(TgSupport.parseLink("https://t.me/c/$CH/50")) }.exceptionOrNull() as TgError
        assertEquals("no_access", e.kind); assertTrue(e.message!!.contains("私密频道"))
        assertEquals(2, api2.calls.count { it == "messages.getDialogs" }) // main list + archive
    }

    @Test fun errorsWhileResolving() {
        val api = FakeApi(); api.messages[60] = TlObj.of("messageService", "id" to 60); api.messages[61] = msg(61, null, "只有字")
        api.messages[62] = msg(62, TlObj.of("messageMediaDocument", "document" to doc(62, 10, "audio/ogg", listOf(TlObj.of("documentAttributeAudio", "duration" to 3)))))
        val svc = TgService({ api })
        fun err(u: String) = runCatching { svc.resolve(TgSupport.parseLink(u)) }.exceptionOrNull() as TgError
        assertEquals("deleted", err("https://t.me/chan/99").kind)
        assertEquals("invalid", err("https://t.me/chan/60").kind)
        assertEquals("no_media", err("https://t.me/chan/61").kind); assertTrue(err("https://t.me/chan/61").message!!.contains("只有文字"))
        assertTrue(err("https://t.me/chan/62").message!!.contains("音频"))
        assertEquals("not_found", err("https://t.me/nosuch/1").kind)
        api.throwOnResolve = RpcError(420, "FLOOD_WAIT_120")
        assertEquals("请求太频繁，Telegram 要求等待 120 秒（约 2 分钟）后再试", err("https://t.me/chan/1").message)
        api.throwOnResolve = java.net.SocketTimeoutException("timed out")
        assertEquals("net", err("https://t.me/chan/1").kind)
    }

    @Test fun downloadAlbumPipelined() {
        val api = FakeApi()
        val big = bytes(TgService.CHUNK * 5 + 1234, 3); val ph = bytes(3000, 7)
        api.files[70] = ph; api.files[71] = big
        api.messages[70] = photoMsg(70, "相册", grouped = 9); api.messages[71] = videoMsg(71, big.size.toLong(), grouped = 9)
        val svc = TgService({ api })
        val p = svc.resolve(TgSupport.parseLink("https://t.me/chan/70"))
        val sink = MemSink(); val pcts = ArrayList<Int>()
        assertEquals(2, svc.download(p, sink, { false }, { _, pct -> pcts += pct }))
        assertArrayEquals(ph, sink.committed[0]); assertArrayEquals(big, sink.committed[1])
        assertEquals("测试频道-相册-chan_70-1.jpg", sink.names[0]); assertEquals("测试频道-相册-chan_70-2.mp4", sink.names[1])
        assertEquals(100, pcts.last())
        assertTrue(api.calls.filter { it.startsWith("upload.getFile") }.all { it.endsWith("@4") || it.endsWith("@5") }) // file DCs
    }

    @Test fun downloadCancelDiscardsPartial() {
        val api = FakeApi(); val big = bytes(TgService.CHUNK * 6, 1); api.files[80] = big; api.messages[80] = videoMsg(80, big.size.toLong())
        val svc = TgService({ api }); val p = svc.resolve(TgSupport.parseLink("https://t.me/chan/80"))
        val sink = MemSink(); var ticks = 0
        val e = runCatching { svc.download(p, sink, { ticks >= 1 }, { _, _ -> ticks++ }, parallel = 1) }.exceptionOrNull()
        assertTrue("got $e", e is Cancelled)
        assertTrue(sink.committed.isEmpty()); assertEquals(listOf(0), sink.discarded)
    }

    @Test fun downloadRechecksMessages() {
        val api = FakeApi(); api.files[90] = bytes(100, 1); api.messages[90] = photoMsg(90)
        val svc = TgService({ api }); val p = svc.resolve(TgSupport.parseLink("https://t.me/chan/90"))
        api.messages.remove(90)
        var e = runCatching { svc.download(p, MemSink(), { false }, { _, _ -> }) }.exceptionOrNull() as TgError
        assertEquals("deleted", e.kind)
        api.messages[90] = photoMsg(90, nf = true)
        e = runCatching { svc.download(p, MemSink(), { false }, { _, _ -> }) }.exceptionOrNull() as TgError
        assertEquals(TgSupport.PROTECTED_MSG, e.message)
        api.messages[90] = photoMsg(90); api.failGetFileAt = 0
        val sink = MemSink()
        e = runCatching { svc.download(p, sink, { false }, { _, _ -> }) }.exceptionOrNull() as TgError
        assertEquals("flood", e.kind); assertEquals(listOf(0), sink.discarded)
    }

    @Test fun downloadSizeMismatch() {
        val api = FakeApi(); api.files[95] = bytes(1000, 1); api.messages[95] = videoMsg(95, 5000)
        val svc = TgService({ api }); val p = svc.resolve(TgSupport.parseLink("https://t.me/chan/95"))
        val sink = MemSink()
        val e = runCatching { svc.download(p, sink, { false }, { _, _ -> }) }.exceptionOrNull() as TgError
        assertTrue(e.message!!.contains("下载不完整")); assertTrue(sink.committed.isEmpty())
    }

    @Test fun accountStorageAndLogoutWithoutNetwork() {
        val store = MemoryTgStore()
        store.write("config", """{"apiId":12345,"apiHash":"0123456789abcdef0123456789abcdef","proxy":"socks5://127.0.0.1:9","name":"Luke","username":"luke"}""")
        val ses = TgSession(2).apply { userId = 5; authorized += 2; keys[2] = ByteArray(256) { 1 } }
        store.write("session", ses.toJson())
        val acc = TgAccount(store, { TgMtprotoTest.schema }, TgDevice("t", "t", "2.4"))
        assertTrue(acc.loggedIn())
        val st = acc.status()
        assertEquals("12345", st.apiId); assertEquals("SOCKS5 127.0.0.1:9", st.proxyDesc); assertEquals("Luke", st.name)
        assertEquals("proxy", (runCatching { acc.setProxy("http://1.2.3.4:80") }.exceptionOrNull() as TgError).kind)
        val e = runCatching { acc.api() }.exceptionOrNull() as TgError
        assertEquals("net", e.kind); assertTrue(e.message!!.contains("SOCKS5 127.0.0.1:9"))
        assertFalse(acc.logout()) // server unreachable → still logged out locally
        assertNull(store.read("session")); assertFalse(acc.loggedIn())
        assertTrue(store.read("config")!!.contains("12345")) // api_id kept for next login
        assertFalse(acc.diagText().contains("0123456789abcdef0123456789abcdef"))
        assertTrue(acc.diagText().startsWith("Telegram：未登录"))
        assertEquals("session", (runCatching { acc.api() }.exceptionOrNull() as TgError).kind)
        val e2 = runCatching { acc.sendCode("12345", "0123456789abcdef0123456789abcdef", "13800138000") }.exceptionOrNull() as TgError
        assertEquals("net", e2.kind)
        assertFalse(store.read("config")!!.contains("13800138000")) // phone number never stored
        assertFalse(acc.diagText().contains("13800138000"))
    }
}
