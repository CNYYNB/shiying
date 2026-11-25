package com.louis.shiying

import com.louis.shiying.mtproto.Crypto
import com.louis.shiying.mtproto.Hex
import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgSession
import com.louis.shiying.mtproto.TlObj
import com.louis.shiying.mtproto.TlReader
import com.louis.shiying.mtproto.TlSchema
import com.louis.shiying.mtproto.TlWriter
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.math.BigInteger
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * 拾影's own MTProto code against GramJS (fixtures from tools/tg-fixtures.js, layer 198): request bytes must be identical,
 * GramJS-serialized objects must parse (and re-serialize byte for byte), AES-IGE and the 2FA SRP check must give the same output.
 */
class TgMtprotoTest {
    companion object {
        val schema by lazy { TlSchema(File("src/main/assets/telegram/schema.tl").readText(), File("src/main/assets/telegram/api.tl").readText()) }
        val fx by lazy { JSONObject(File("src/test/resources/tg/gramjs-fixtures.json").readText()) }
        fun parse(hex: String): TlObj = TlReader(schema, Hex.dec(hex)).obj() as TlObj
    }

    private fun req(name: String) = fx.getJSONObject("requests").getString(name)

    @Test fun schemaLoaded() {
        assertTrue(schema.byName.size > 1500)
        assertEquals(0x8d52a951.toInt(), schema.combinator("auth.signIn").id)
        assertTrue(schema.combinator("upload.getFile").isFunction)
        assertEquals("upload.File", schema.returnType(TlObj.of("upload.getFile")))
        assertEquals("Vector<User>", schema.returnType(TlObj.of("users.getUsers")))
        assertEquals("Config", schema.returnType(TlObj.of("invokeWithLayer", "layer" to 198, "query" to TlObj.of("initConnection", "query" to TlObj.of("help.getConfig")))))
    }

    @Test fun requestsMatchGramJs() {
        fun ser(o: TlObj) = Hex.enc(schema.serialize(o))
        assertEquals(req("sendCode"), ser(TlObj.of("auth.sendCode", "phone_number" to "+8613800138000", "api_id" to 12345, "api_hash" to "0123456789abcdef0123456789abcdef", "settings" to TlObj.of("codeSettings"))))
        assertEquals(req("signIn"), ser(TlObj.of("auth.signIn", "phone_number" to "+8613800138000", "phone_code_hash" to "abc123", "phone_code" to "12345")))
        assertEquals(req("getFile"), ser(TlObj.of("upload.getFile", "location" to TlObj.of("inputDocumentFileLocation", "id" to 6002L, "access_hash" to 123456789012345L,
            "file_reference" to Hex.dec("aabb"), "thumb_size" to ""), "offset" to 1048576L, "limit" to 524288)))
        assertEquals(req("getPhoto"), ser(TlObj.of("upload.getFile", "location" to TlObj.of("inputPhotoFileLocation", "id" to 5001L, "access_hash" to -77L,
            "file_reference" to Hex.dec("0102030405"), "thumb_size" to "y"), "offset" to 0L, "limit" to 524288)))
        assertEquals(req("getMessages"), ser(TlObj.of("channels.getMessages", "channel" to TlObj.of("inputChannel", "channel_id" to 1987654321L, "access_hash" to -5555555555555L),
            "id" to listOf(TlObj.of("inputMessageID", "id" to 10), TlObj.of("inputMessageID", "id" to 11)))))
        assertEquals(req("getDialogs"), ser(TlObj.of("messages.getDialogs", "folder_id" to 1, "offset_date" to 0, "offset_id" to 0, "offset_peer" to TlObj.of("inputPeerEmpty"), "limit" to 100, "hash" to 0L)))
        assertEquals(req("discussion"), ser(TlObj.of("messages.getDiscussionMessage", "peer" to TlObj.of("inputPeerChannel", "channel_id" to 1987654321L, "access_hash" to -5555555555555L), "msg_id" to 42)))
        assertEquals(req("resolve"), ser(TlObj.of("contacts.resolveUsername", "username" to "shiying_test")))
        assertEquals(req("init"), ser(TlObj.of("invokeWithLayer", "layer" to 198, "query" to TlObj.of("initConnection", "api_id" to 12345, "device_model" to "Pixel 8",
            "system_version" to "Android 14", "app_version" to "2.4", "system_lang_code" to "zh-CN", "lang_pack" to "", "lang_code" to "zh", "query" to TlObj.of("help.getConfig")))))
        assertEquals(req("checkPassword"), ser(TlObj.of("auth.checkPassword", "password" to TlObj.of("inputCheckPasswordSRP", "srp_id" to 987654321L,
            "A" to Hex.dec("01".repeat(256)), "M1" to Hex.dec("02".repeat(32))))))
    }

    @Test fun objectsFromGramJsParseAndRoundTrip() {
        val objs = fx.getJSONObject("objects")
        val all = mutableListOf(objs.getString("channelMessages"), objs.getString("resolvedPeer"), objs.getString("uploadFile"))
        val msgs = objs.getJSONObject("messages"); msgs.keys().forEach { all += msgs.getString(it) }
        for (h in all) assertEquals(h, Hex.enc(schema.serialize(parse(h))))

        val cm = parse(objs.getString("channelMessages"))
        assertEquals("messages.channelMessages", cm.type)
        val ms = cm.objs("messages")
        assertEquals(listOf("message", "message", "messageEmpty"), ms.map { it.type })
        assertEquals("图集 #测试", ms[0].str("message")); assertEquals(777L, ms[0].long("grouped_id"))
        assertEquals(1987654321L, ms[0].obj("peer_id")?.long("channel_id"))
        val ch = cm.objs("chats")[0]
        assertEquals("channel", ch.type); assertTrue(ch.flag("noforwards")); assertTrue(ch.flag("broadcast")); assertFalse(ch.flag("megagroup"))
        assertEquals(-5555555555555L, ch.long("access_hash")); assertEquals("测试频道", ch.str("title")); assertEquals("shiying_test", ch.str("username"))
        val rp = parse(objs.getString("resolvedPeer"))
        assertEquals(1987654321L, rp.obj("peer")?.long("channel_id"))
        val uf = parse(objs.getString("uploadFile"))
        assertEquals("storage.fileMp4", uf.obj("type")?.type); assertEquals(12, uf.bytes("bytes")!!.size)
    }

    @Test fun mediaItemsFromRealTl() {
        val m = fx.getJSONObject("objects").getJSONObject("messages")
        var it = TgSupport.mediaItems(parse(m.getString("photo"))).single()
        assertEquals("photo", it.kind); assertEquals(81234L, it.size); assertEquals(1280, it.w); assertEquals(".jpg", it.ext)
        assertEquals("y", TgSupport.bestPhotoSize(parse(m.getString("photo")).obj("media")!!.obj("photo"))!!.first)
        it = TgSupport.mediaItems(parse(m.getString("video"))).single()
        assertEquals("video", it.kind); assertEquals(0, it.alt); assertEquals(5000000L, it.size); assertEquals(1080, it.h); assertEquals(12.5, it.duration, 0.0)
        it = TgSupport.mediaItems(parse(m.getString("gif"))).single()
        assertEquals("gif", it.kind); assertTrue(it.isVideo)
        it = TgSupport.mediaItems(parse(m.getString("imageFile"))).single()
        assertEquals("image", it.kind); assertEquals(".png", it.ext); assertEquals(4000, it.w)
        assertTrue(TgSupport.mediaItems(parse(m.getString("sticker"))).isEmpty())
        assertTrue(TgSupport.noMediaReason(parse(m.getString("sticker"))).contains("贴纸"))
        assertTrue(TgSupport.noMediaReason(parse(m.getString("text"))).contains("只有文字"))
        assertTrue(TgSupport.isProtected(parse(m.getString("protected")), null))
        assertFalse(TgSupport.isProtected(parse(m.getString("photo")), null))
    }

    @Test fun igeMatchesGramJs() {
        val g = fx.getJSONObject("ige")
        val enc = Crypto.igeEncrypt(Hex.dec(g.getString("plain")), Hex.dec(g.getString("key")), Hex.dec(g.getString("iv")))
        assertEquals(g.getString("enc"), Hex.enc(enc))
        assertEquals(g.getString("plain"), Hex.enc(Crypto.igeDecrypt(enc, Hex.dec(g.getString("key")), Hex.dec(g.getString("iv")))))
    }

    @Test fun srpMatchesGramJs() {
        val s = fx.getJSONObject("srp")
        val a = Crypto.srpCheck(Hex.dec(s.getString("salt1")), Hex.dec(s.getString("salt2")), s.getInt("g"), Hex.dec(s.getString("p")),
            Hex.dec(s.getString("srpB")), s.getString("srpId").toLong(), s.getString("password")) { Hex.dec(s.getString("a")) }
        assertEquals(s.getString("A"), Hex.enc(a.a))
        assertEquals(s.getString("M1"), Hex.enc(a.m1))
        val bad = runCatching { Crypto.srpCheck(ByteArray(8), ByteArray(8), 3, ByteArray(256) { 1 }, ByteArray(256) { 2 }, 1, "x") }.exceptionOrNull()
        assertTrue(bad is Crypto.PasswordError)
    }

    @Test fun pbkdf2MatchesJca() {
        val pw = "密码".toByteArray(); val salt = "salt123".toByteArray()
        val jca = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA512").generateSecret(PBEKeySpec(String(pw).toCharArray(), salt, 1000, 512)).encoded
        assertArrayEquals(jca, Crypto.pbkdf2Sha512(pw, salt, 1000))
    }

    @Test fun rsaFingerprints() {
        for (k in Crypto.SERVER_KEYS) {
            val w = TlWriter(schema)
            w.tlBytes(Crypto.toBytes(k.n)); w.tlBytes(Crypto.toBytes(k.e))
            val sha = Crypto.sha1(w.bytes())
            val fp = java.nio.ByteBuffer.wrap(sha, 12, 8).order(java.nio.ByteOrder.LITTLE_ENDIAN).long
            assertEquals(k.fingerprint, fp)
        }
    }

    @Test fun factorize() {
        val p = BigInteger("1229739323"); val q = BigInteger("1402015859")
        assertEquals(p to q, Crypto.factorize(p.multiply(q)))
        assertEquals(BigInteger.valueOf(2) to BigInteger.valueOf(21), Crypto.factorize(BigInteger.valueOf(42)))
    }

    @Test fun tlBytesPadding() {
        for (n in listOf(0, 1, 3, 253, 254, 300, 1000)) {
            val w = TlWriter(schema); val b = ByteArray(n) { it.toByte() }; w.tlBytes(b); w.int(7)
            val out = w.bytes()
            assertEquals(0, (out.size - 4) % 4)
            val r = TlReader(schema, out)
            assertArrayEquals(b, r.tlBytes()); assertEquals(7, r.int())
        }
    }

    @Test fun rpcErrorHelpers() {
        assertEquals(30, RpcError(420, "FLOOD_WAIT_30").waitSeconds)
        assertEquals(4, RpcError(303, "FILE_MIGRATE_4").migrateDc)
        assertEquals(5, RpcError(303, "PHONE_MIGRATE_5").migrateDc)
        assertEquals(null, RpcError(400, "CHANNEL_PRIVATE").migrateDc)
    }

    @Test fun sessionJsonRoundTrip() {
        val s = TgSession(4)
        s.keys[4] = Crypto.randomBytes(256); s.keys[2] = Crypto.randomBytes(256)
        s.authorized += 4; s.userId = 777; s.peers["c123"] = -5L
        val t = TgSession.fromJson(s.toJson())
        assertEquals(4, t.mainDc); assertArrayEquals(s.keys[4], t.keys[4]); assertArrayEquals(s.keys[2], t.keys[2])
        assertTrue(t.loggedIn); assertEquals(-5L, t.peers["c123"]); assertFalse(t.test)
        assertFalse(TgSession().loggedIn)
    }
}
