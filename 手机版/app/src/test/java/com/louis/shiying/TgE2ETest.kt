package com.louis.shiying

import com.louis.shiying.mtproto.Crypto
import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgClient
import com.louis.shiying.mtproto.TgDevice
import com.louis.shiying.mtproto.TgSession
import com.louis.shiying.mtproto.TlObj
import com.louis.shiying.mtproto.TlSchema
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.OutputStream
import java.nio.file.Files

/**
 * End-to-end test on Telegram's TEST servers (separate from production, no real account involved), opt-in:
 *   SHIYING_TG_E2E=1 gradle :app:testReleaseUnitTest --tests '*TgE2ETest*'
 * Test numbers 99966 2 xxxx always accept the code 22222 (the DC digit repeated to the code length). Uses the api_id / api_hash that TDLib publishes in its examples for testing
 * (test DC only; the app itself ships no api_id).
 * Setup (raw client): sign up, create a private channel with photo / video / album posts, a noforwards channel and a channel with comments.
 * Then exactly what the app does: TgAccount login with a fresh session → TgService resolve (private t.me/c links → dialogs scan) →
 * pipelined download, byte-compared with what was uploaded → logout (server-side, local session gone, old key rejected).
 */
class TgE2ETest {
    private val apiId = 94575
    private val apiHash = "a3406de8d171bb422bb6ddf3bbd800e2"
    private val dev = TgDevice("拾影 E2E", "JVM", "2.4")
    private val schema by lazy { TlSchema(File("src/main/assets/telegram/schema.tl").readText(), File("src/main/assets/telegram/api.tl").readText()) }

    private fun ffmpeg(vararg args: String) {
        val p = ProcessBuilder(listOf("ffmpeg", "-y", "-loglevel", "error") + args).redirectErrorStream(true).start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        check(p.waitFor() == 0) { out }
    }

    private fun upload(c: TgClient, bytes: ByteArray, name: String): TlObj {
        val id = Crypto.random.nextLong()
        val part = 512 * 1024
        val parts = (bytes.size + part - 1) / part
        for (i in 0 until parts) {
            val r = c.call(TlObj.of("upload.saveFilePart", "file_id" to id, "file_part" to i, "bytes" to bytes.copyOfRange(i * part, minOf(bytes.size, (i + 1) * part))))
            check(r == true)
        }
        return TlObj.of("inputFile", "id" to id, "parts" to parts, "name" to name, "md5_checksum" to "")
    }

    private fun photoMedia(c: TgClient, b: ByteArray) = TlObj.of("inputMediaUploadedPhoto", "file" to upload(c, b, "p.jpg"))
    private fun videoMedia(c: TgClient, b: ByteArray) = TlObj.of("inputMediaUploadedDocument", "file" to upload(c, b, "v.mp4"), "mime_type" to "video/mp4",
        "attributes" to listOf(TlObj.of("documentAttributeVideo", "supports_streaming" to true, "duration" to 6.0, "w" to 1280, "h" to 720)))

    private fun msgIds(u: Any?): List<Int> = ((u as TlObj).objs("updates"))
        .filter { it.type == "updateNewChannelMessage" || it.type == "updateNewMessage" }.mapNotNull { it.obj("message")?.int("id") }.sorted()

    private fun peer(ch: TlObj) = TlObj.of("inputPeerChannel", "channel_id" to ch.long("id"), "access_hash" to ch.long("access_hash"))
    private fun input(ch: TlObj) = TlObj.of("inputChannel", "channel_id" to ch.long("id"), "access_hash" to ch.long("access_hash"))

    private fun send(c: TgClient, ch: TlObj, media: TlObj, text: String, replyTo: Int? = null): Int = msgIds(c.call(TlObj.of("messages.sendMedia", "peer" to peer(ch),
        "media" to media, "message" to text, "random_id" to Crypto.random.nextLong(),
        "reply_to" to replyTo?.let { TlObj.of("inputReplyToMessage", "reply_to_msg_id" to it) }))).first()

    private fun newChannel(c: TgClient, title: String, megagroup: Boolean = false): TlObj =
        (c.call(TlObj.of("channels.createChannel", "broadcast" to !megagroup, "megagroup" to megagroup, "title" to title, "about" to "")) as TlObj)
            .objs("chats").first { it.type == "channel" }

    private class DirSink(val dir: File) : TgSink {
        val files = HashMap<Int, File>()
        val committed = ArrayList<File>()
        override fun open(index: Int, item: TgItem, baseName: String): OutputStream { val f = File(dir, "$baseName${item.ext}"); files[index] = f; return f.outputStream() }
        override fun commit(index: Int) { committed += files[index]!! }
        override fun discard(index: Int) { files[index]?.delete() }
    }

    @Test fun loginResolveDownloadLogout() {
        assumeTrue(System.getenv("SHIYING_TG_E2E") == "1")
        val log: (String) -> Unit = { println("[tg] $it") }
        val tmp = Files.createTempDirectory("tg-e2e").toFile()
        ffmpeg("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1", "-q:v", "3", File(tmp, "p1.jpg").path)
        ffmpeg("-f", "lavfi", "-i", "testsrc2=size=960x540:rate=1", "-frames:v", "1", "-q:v", "3", File(tmp, "p2.jpg").path)
        ffmpeg("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-vf", "noise=alls=60:allf=t", "-t", "6", "-c:v", "libx264", "-b:v", "4M", "-pix_fmt", "yuv420p", File(tmp, "v.mp4").path)
        val p1 = File(tmp, "p1.jpg").readBytes(); val p2 = File(tmp, "p2.jpg").readBytes(); val vid = File(tmp, "v.mp4").readBytes()
        println("video ${vid.size} bytes")
        val phone = "999662" + "%04d".format(Crypto.random.nextInt(10000))

        // ---- setup with a raw client
        val ses0 = TgSession(test = true)
        val c = TgClient(schema, apiId, apiHash, ses0, null, dev, log)
        val sent = c.call(TlObj.of("auth.sendCode", "phone_number" to phone, "api_id" to apiId, "api_hash" to apiHash, "settings" to TlObj.of("codeSettings"))) as TlObj
        val hash = sent.str("phone_code_hash")!!
        (c.call(TlObj.of("help.getConfig")) as TlObj).let { println("config: test_mode=${it["test_mode"]} this_dc=${it["this_dc"]}") }
        println("sentCode: ${sent.f} type=${sent.obj("type")?.f} next=${sent.obj("next_type")}")
        var auth = try {
            c.call(TlObj.of("auth.signIn", "phone_number" to phone, "phone_code_hash" to hash, "phone_code" to "2".repeat(sent.obj("type")?.int("length") ?: 5))) as TlObj
        } catch (e: RpcError) {
            // Nov 2026: the test DC answers PHONE_CODE_INVALID for test numbers (GramJS gets the same) → can't log in, skip.
            c.close(); assumeTrue("test DC rejected the test-number code: ${e.error}", false); return
        }
        if (auth.type == "auth.authorizationSignUpRequired") {
            auth = c.call(TlObj.of("auth.signUp", "phone_number" to phone, "phone_code_hash" to hash, "first_name" to "拾影", "last_name" to "测试")) as TlObj
        }
        ses0.userId = auth.obj("user")!!.long("id")!!; ses0.authorized += ses0.mainDc
        println("setup account ok on dc ${ses0.mainDc}")
        val ch = newChannel(c, "拾影测试频道")
        val photoMsg = send(c, ch, photoMedia(c, p1), "单张图片 #测试")
        val videoMsg = send(c, ch, videoMedia(c, vid), "测试视频")
        val m1 = c.call(TlObj.of("messages.uploadMedia", "peer" to peer(ch), "media" to photoMedia(c, p1))) as TlObj
        val m2 = c.call(TlObj.of("messages.uploadMedia", "peer" to peer(ch), "media" to photoMedia(c, p2))) as TlObj
        val m3 = c.call(TlObj.of("messages.uploadMedia", "peer" to peer(ch), "media" to videoMedia(c, vid))) as TlObj
        fun inPhoto(m: TlObj) = TlObj.of("inputMediaPhoto", "id" to m.obj("photo")!!.let { TlObj.of("inputPhoto", "id" to it.long("id"), "access_hash" to it.long("access_hash"), "file_reference" to it.bytes("file_reference")) })
        fun inDoc(m: TlObj) = TlObj.of("inputMediaDocument", "id" to m.obj("document")!!.let { TlObj.of("inputDocument", "id" to it.long("id"), "access_hash" to it.long("access_hash"), "file_reference" to it.bytes("file_reference")) })
        val album = msgIds(c.call(TlObj.of("messages.sendMultiMedia", "peer" to peer(ch), "multi_media" to listOf(
            TlObj.of("inputSingleMedia", "media" to inPhoto(m1), "random_id" to Crypto.random.nextLong(), "message" to "相册"),
            TlObj.of("inputSingleMedia", "media" to inPhoto(m2), "random_id" to Crypto.random.nextLong(), "message" to ""),
            TlObj.of("inputSingleMedia", "media" to inDoc(m3), "random_id" to Crypto.random.nextLong(), "message" to "")))))
        println("album ids $album")
        val prot = newChannel(c, "禁止保存测试")
        val protMsg = send(c, prot, photoMedia(c, p1), "受保护")
        c.call(TlObj.of("messages.toggleNoForwards", "peer" to peer(prot), "enabled" to true))
        val group = newChannel(c, "评论区", megagroup = true)
        assertEquals(true, c.call(TlObj.of("channels.setDiscussionGroup", "broadcast" to input(ch), "group" to input(group))))
        val postMsg = msgIds(c.call(TlObj.of("messages.sendMessage", "peer" to peer(ch), "message" to "带评论的帖子", "random_id" to Crypto.random.nextLong()))).first()
        Thread.sleep(1500)
        val disc = c.call(TlObj.of("messages.getDiscussionMessage", "peer" to peer(ch), "msg_id" to postMsg)) as TlObj
        val groupTop = disc.objs("messages").first().int("id")!!
        val commentMsg = send(c, group, photoMedia(c, p2), "评论里的图片", replyTo = groupTop)
        c.close()
        val chId = ch.long("id")!!

        // ---- the app's flow
        val store = MemoryTgStore()
        val acc = TgAccount(store, { schema }, dev, clientFactory = { s, id, h, p -> s.test = true; TgClient(schema, id, h, s, p, dev, log) })
        val st = acc.sendCode(apiId.toString(), apiHash, phone.removePrefix("+"))
        println("sendCode → ${st.step} viaApp=${st.viaApp}")
        val done = acc.signIn("2".repeat(st.codeLength.takeIf { it > 0 } ?: 5))
        assertEquals("done", done.step)
        assertTrue(acc.loggedIn())
        assertTrue(store.read("session")!!.contains("\"keys\""))
        assertFalse(store.read("config")!!.contains(phone.removePrefix("+")))
        val svc = TgService({ acc.api() }, log)
        val sink = { DirSink(File(tmp, "out-${System.nanoTime()}").apply { mkdirs() }) }

        val photo = svc.resolve(TgSupport.parseLink("https://t.me/c/$chId/$photoMsg"), log)
        assertTrue(photo.isImages); assertEquals(1, photo.tg!!.items.size)
        sink().let { s -> assertEquals(1, svc.download(photo, s, { false }, { _, _ -> })); val b = s.committed[0].readBytes(); assertTrue(b[0] == 0xff.toByte() && b[1] == 0xd8.toByte()) }

        val video = svc.resolve(TgSupport.parseLink("tg://privatepost?channel=$chId&post=$videoMsg"), log)
        assertFalse(video.isImages); assertEquals("video", video.tg!!.items[0].kind); assertEquals(vid.size.toLong(), video.tg!!.items[0].size)
        sink().let { s -> svc.download(video, s, { false }, { t, p -> if (p % 25 == 0) println("  $t $p%") }); assertArrayEquals(Crypto.sha256(vid), Crypto.sha256(s.committed[0].readBytes())) }

        val alb = svc.resolve(TgSupport.parseLink("https://t.me/c/$chId/${album[1]}"), log)
        assertEquals(3, alb.tg!!.items.size); assertEquals("相册：2 张图片 + 1 个视频", alb.tg!!.summary)
        sink().let { s -> assertEquals(3, svc.download(alb, s, { false }, { _, _ -> })); assertEquals(3, s.committed.size); assertArrayEquals(Crypto.sha256(vid), Crypto.sha256(s.committed[2].readBytes())) }
        val one = svc.resolve(TgSupport.parseLink("https://t.me/c/$chId/${album[1]}?single"), log)
        assertEquals(1, one.tg!!.items.size)

        // cancel mid-download: partial file discarded
        sink().let { s ->
            var n = 0
            val r = runCatching { svc.download(video, s, { n > 2 }, { _, _ -> n++ }, parallel = 1) }
            assertTrue("expected Cancelled, got ${r.exceptionOrNull()}", r.exceptionOrNull() is Cancelled)
            assertTrue(s.committed.isEmpty()); assertTrue(s.dir.listFiles()!!.isEmpty())
        }

        val pe = runCatching { svc.resolve(TgSupport.parseLink("https://t.me/c/${prot.long("id")}/$protMsg"), log) }.exceptionOrNull()
        assertEquals(TgSupport.PROTECTED_MSG, pe?.message)

        val cm = svc.resolve(TgSupport.parseLink("https://t.me/c/$chId/$postMsg?comment=$commentMsg"), log)
        assertEquals(1, cm.tg!!.items.size); assertEquals("评论里的图片", cm.desc)

        val de = runCatching { svc.resolve(TgSupport.parseLink("https://t.me/c/$chId/99999"), log) }.exceptionOrNull() as TgError
        assertEquals("deleted", de.kind)
        val ne = runCatching { svc.resolve(TgSupport.parseLink("https://t.me/c/1234567/5"), log) }.exceptionOrNull() as TgError
        assertEquals("no_access", ne.kind)
        println("diag:\n" + acc.diagText())
        assertFalse(acc.diagText().contains(apiHash)); assertFalse(acc.diagText().contains(phone.removePrefix("+")))

        // ---- logout: server-side + local
        val oldSession = store.read("session")!!
        assertTrue(acc.logout())
        assertEquals(null, store.read("session")); assertFalse(acc.loggedIn())
        val old = TgSession.fromJson(oldSession)
        val c2 = TgClient(schema, apiId, apiHash, old, null, dev, log)
        val err = runCatching { c2.call(TlObj.of("users.getUsers", "id" to listOf(TlObj.of("inputUserSelf")))) }.exceptionOrNull()
        println("old session after logout → $err")
        assertTrue(err is RpcError && TgSupport.classify(err).kind == "session")
        c2.close()
        tmp.deleteRecursively()
    }
}
