package com.louis.shiying

import com.louis.shiying.mtproto.ProxyFailure
import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgProxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** Telegram links, platform detection, proxy settings, error mapping, redaction, login input (ported from the PC version's telegram.test.js). */
class TgLinkTest {
    private fun reason(s: String): String? = try { TgSupport.parseLink(s); null } catch (e: TgLinkError) { e.reason }
    private fun msgOf(f: () -> Unit): String = try { f(); "" } catch (e: Exception) { e.message ?: "" }

    @Test fun publicChannelLinks() {
        var l = TgSupport.parseLink("https://t.me/durov/123")
        assertEquals("username", l.kind); assertEquals("durov", l.username); assertEquals(123, l.msgId)
        assertFalse(l.single); assertNull(l.topicId); assertTrue(l.publicFallback)
        assertEquals("https://t.me/durov/123", l.url)
        l = TgSupport.parseLink("https://telegram.me/Some_Channel/45?single")
        assertEquals("Some_Channel", l.username); assertEquals(45, l.msgId); assertTrue(l.single)
        assertEquals("https://t.me/Some_Channel/45?single", l.url)
        assertEquals("https://t.me/Some_Channel/45?single", l.fallbackUrl)
        assertEquals(7, TgSupport.parseLink("https://telegram.dog/abcde/7").msgId)
        assertEquals(8, TgSupport.parseLink("http://www.t.me/abcde/8").msgId)
        assertEquals(9, TgSupport.parseLink("t.me/abcde/9").msgId)
        l = TgSupport.parseLink("https://t.me/s/abcde/10")
        assertEquals("abcde", l.username); assertEquals(10, l.msgId)
        l = TgSupport.parseLink("https://abcde.t.me/11")
        assertEquals("abcde", l.username); assertEquals(11, l.msgId)
    }

    @Test fun privateTopicCommentThread() {
        var l = TgSupport.parseLink("https://t.me/c/1234567890/55")
        assertEquals("channel", l.kind); assertEquals("1234567890", l.channelId); assertEquals(55, l.msgId); assertFalse(l.publicFallback)
        l = TgSupport.parseLink("https://t.me/c/1234567890/3/77")
        assertEquals(3, l.topicId); assertEquals(77, l.msgId); assertEquals("https://t.me/c/1234567890/3/77", l.url)
        l = TgSupport.parseLink("https://t.me/c/1234567890/77?thread=3")
        assertEquals(3, l.threadId); assertEquals(77, l.msgId)
        l = TgSupport.parseLink("https://t.me/somechan/100?comment=2001")
        assertEquals(2001, l.commentId); assertEquals(100, l.msgId); assertFalse(l.publicFallback)
        l = TgSupport.parseLink("https://t.me/somegroup/5/900?single")
        assertEquals(5, l.topicId); assertEquals(900, l.msgId); assertTrue(l.single)
        l = TgSupport.parseLink("https://t.me/somechan/100?single&comment=3")
        assertTrue(l.single); assertEquals(3, l.commentId)
        assertEquals("https://t.me/somechan/100?single&comment=3", l.url)
    }

    @Test fun tgScheme() {
        var l = TgSupport.parseLink("tg://resolve?domain=durov&post=12&single")
        assertEquals("durov", l.username); assertEquals(12, l.msgId); assertTrue(l.single)
        l = TgSupport.parseLink("tg://privatepost?channel=1234567890&post=34&thread=2")
        assertEquals("channel", l.kind); assertEquals("1234567890", l.channelId); assertEquals(34, l.msgId); assertEquals(2, l.threadId)
        assertEquals("https://t.me/durov/12", TgSupport.tgSchemeToHttps("看这个 tg://resolve?domain=durov&post=12 "))
        assertEquals("invite", reason("tg://join?invite=AbCdEf"))
    }

    @Test fun notMessageLinks() {
        assertEquals("invite", reason("https://t.me/+AbCdEf123"))
        assertEquals("invite", reason("https://t.me/joinchat/AbCdEf"))
        assertEquals("no_message", reason("https://t.me/durov"))
        assertEquals("no_message", reason("https://t.me/c/1234567890"))
        assertEquals("not_message", reason("https://t.me/addstickers/Cats"))
        assertEquals("not_message", reason("https://t.me/proxy?server=1.2.3.4&port=443&secret=00"))
        assertEquals("bad", reason("https://t.me/durov/abc"))
        assertEquals("bad", reason("https://t.me/c/abc/1"))
        assertEquals("bad", reason("https://t.me/durov/1/2/3"))
        assertEquals("not_message", reason("https://example.com/durov/1"))
        assertEquals("bad", reason(""))
        assertTrue(msgOf { TgSupport.parseLink("https://t.me/+AbCdEf123") }.startsWith("这是 Telegram 的邀请链接"))
        assertTrue(msgOf { TgSupport.parseLink("https://t.me/durov") }.contains("复制消息链接"))
    }

    @Test fun platformDetection() {
        assertEquals(Platform.TELEGRAM, Platform.ofUrl("https://t.me/durov/1"))
        assertEquals(Platform.TELEGRAM, Platform.ofUrl("https://telegram.me/durov/1"))
        assertEquals(Platform.TELEGRAM, Platform.ofUrl("https://telegram.dog/durov/1"))
        assertEquals(Platform.TELEGRAM, Platform.ofUrl("https://abcde.t.me/11"))
        assertEquals("telegram", Platform.TELEGRAM.engine)
        assertEquals(Platform.TELEGRAM, Links.detect("看看这个 https://t.me/durov/123?single 不错"))
        assertEquals("https://t.me/durov/123?single", Links.findUrl("看看这个 https://t.me/durov/123?single，不错"))
        assertEquals(Platform.TELEGRAM, Links.detect("t.me/c/1234567890/55"))
        assertEquals("https://t.me/c/1234567890/55", Links.findUrl("t.me/c/1234567890/55"))
        assertEquals(Platform.TELEGRAM, Links.detect("tg://privatepost?channel=1234567890&post=34"))
        assertTrue(Links.looksSupported("https://t.me/durov/1"))
        assertEquals(Platform.BILIBILI, Links.detect("https://www.bilibili.com/video/BV1GJ411x7h7/"))
        assertFalse(Platform.loginable.contains(Platform.TELEGRAM)) // not a WebView login
    }

    @Test fun routing() {
        val saved = Extractor.telegram
        try {
            Extractor.telegram = null
            val r = Extractor.route("https://t.me/durov/123?single")
            assertTrue(r is Extractor.Route.Ytdlp)
            assertEquals("https://t.me/durov/123?single", (r as Extractor.Route.Ytdlp).url)
            assertEquals(Platform.TELEGRAM, r.platform)
            assertEquals(TgSupport.NEED_LOGIN, msgOf { Extractor.route("https://t.me/c/1234567890/55") })
            assertEquals(TgSupport.NEED_LOGIN, msgOf { Extractor.route("https://t.me/somechan/100?comment=2001") })
            assertTrue(msgOf { Extractor.route("https://t.me/+AbCdEf123") }.startsWith("这是 Telegram 的邀请链接"))
            var got: TgLink? = null
            Extractor.telegram = object : Extractor.Telegram {
                override fun loggedIn() = true
                override fun resolve(link: TgLink, log: (String) -> Unit): Post { got = link; throw UserError("x") }
            }
            assertEquals("x", msgOf { Extractor.route("分享 tg://privatepost?channel=1234567890&post=34") })
            assertEquals("1234567890", got?.channelId)
        } finally { Extractor.telegram = saved }
    }

    @Test fun proxySettings() {
        assertNull(TgSupport.parseProxy(""))
        var p = TgSupport.parseProxy("socks5://127.0.0.1:7890") as TgProxy.Socks5
        assertEquals("127.0.0.1", p.host); assertEquals(7890, p.port); assertNull(p.user)
        p = TgSupport.parseProxy("127.0.0.1:10808") as TgProxy.Socks5
        assertEquals(10808, p.port)
        p = TgSupport.parseProxy("socks5h://u%40x:p%3Aw@proxy.example.com:1080/") as TgProxy.Socks5
        assertEquals("u@x", p.user); assertEquals("p:w", p.pass); assertEquals("proxy.example.com", p.host); assertEquals(1080, p.port)
        val mt = TgSupport.parseProxy("tg://proxy?server=1.2.3.4&port=443&secret=dd0123456789abcdef0123456789abcdef") as TgProxy.MtProxy
        assertEquals("1.2.3.4", mt.host); assertEquals(443, mt.port); assertEquals(17, mt.secret.size); assertTrue(mt.padded)
        val mt2 = TgSupport.parseProxy("https://t.me/proxy?server=h.example&port=8443&secret=0123456789ABCDEF0123456789ABCDEF") as TgProxy.MtProxy
        assertEquals(16, mt2.secret.size); assertFalse(mt2.padded); assertEquals(0x01, mt2.key16[0].toInt())
        val b64 = TgSupport.parseProxy("tg://proxy?server=1.2.3.4&port=443&secret=ASNFZ4mrze8BI0VniavN7w") as TgProxy.MtProxy
        assertEquals(16, b64.secret.size); assertEquals(0xef.toByte(), b64.secret[15])
        assertEquals("a", (TgSupport.parseProxy("https://t.me/socks?server=1.2.3.4&port=1080&user=a&pass=b") as TgProxy.Socks5).user)
        assertTrue(msgOf { TgSupport.parseProxy("http://127.0.0.1:7890") }.contains("不支持 HTTP 代理"))
        assertTrue(msgOf { TgSupport.parseProxy("tg://proxy?server=1.2.3.4&port=443&secret=ee0123456789abcdef0123456789abcdef676f6f676c652e636f6d") }.contains("FakeTLS"))
        assertTrue(msgOf { TgSupport.parseProxy("socks5://127.0.0.1") }.contains("格式不对"))
        assertTrue(msgOf { TgSupport.parseProxy("ftp://1.2.3.4:21") }.contains("socks5"))
        assertEquals("直连", TgSupport.describeProxy(null))
        assertEquals("SOCKS5 127.0.0.1:7890", TgSupport.describeProxy(TgProxy.Socks5("127.0.0.1", 7890)))
    }

    @Test fun errorMapping() {
        fun rpc(m: String) = RpcError(400, m)
        var c = TgSupport.classify(RpcError(420, "FLOOD_WAIT_45"))
        assertEquals("flood", c.kind); assertTrue(c.message!!.contains("45 秒"))
        c = TgSupport.classify(RpcError(420, "FLOOD_WAIT_7200"))
        assertTrue(c.message!!.contains("7200 秒") && c.message!!.contains("2.0 小时"))
        assertTrue(TgSupport.classify(RpcError(420, "FLOOD_WAIT_150")).message!!.contains("3 分钟"))
        assertEquals("该频道/聊天禁止保存内容，拾影不下载这类内容", TgSupport.classify(rpc("CHAT_FORWARDS_RESTRICTED")).message)
        for (m in listOf("CHANNEL_PRIVATE", "USER_NOT_PARTICIPANT", "CHANNEL_INVALID", "PEER_ID_INVALID")) assertEquals(m, "no_access", TgSupport.classify(rpc(m)).kind)
        assertEquals("not_found", TgSupport.classify(rpc("USERNAME_NOT_OCCUPIED")).kind)
        assertEquals("deleted", TgSupport.classify(rpc("MSG_ID_INVALID")).kind)
        assertEquals("retry", TgSupport.classify(rpc("FILE_REFERENCE_EXPIRED")).kind)
        assertEquals("auth_api", TgSupport.classify(rpc("API_ID_INVALID")).kind)
        assertEquals("auth_api", TgSupport.classify(rpc("API_ID_PUBLISHED_FLOOD")).kind)
        assertEquals("auth_phone", TgSupport.classify(rpc("PHONE_NUMBER_INVALID")).kind)
        assertEquals("auth_code", TgSupport.classify(rpc("PHONE_CODE_INVALID")).kind)
        assertEquals("验证码不对，请再看一下 Telegram 发来的验证码", TgSupport.classify(rpc("PHONE_CODE_INVALID")).message)
        assertEquals("auth_code_expired", TgSupport.classify(rpc("PHONE_CODE_EXPIRED")).kind)
        assertEquals("auth_password", TgSupport.classify(rpc("PASSWORD_HASH_INVALID")).kind)
        assertEquals("两步验证密码不对", TgSupport.classify(rpc("PASSWORD_HASH_INVALID")).message)
        assertEquals("auth_need_password", TgSupport.classify(rpc("SESSION_PASSWORD_NEEDED")).kind)
        assertEquals("session", TgSupport.classify(RpcError(401, "AUTH_KEY_UNREGISTERED")).kind)
        assertEquals("session", TgSupport.classify(RpcError(401, "SESSION_REVOKED")).kind)
        assertTrue(TgSupport.classify(RpcError(401, "SESSION_REVOKED")).message!!.contains("请重新登录"))
        c = TgSupport.classify(java.net.ConnectException("Connection refused"), "login")
        assertEquals("net", c.kind); assertTrue(c.message!!.startsWith("连不上 Telegram 服务器，无法登录")); assertTrue(c.message!!.contains("SOCKS5"))
        assertEquals("net", TgSupport.classify(IOException("Telegram 服务器响应超时（timed out）")).kind)
        assertEquals("net", TgSupport.classify(java.net.SocketTimeoutException("connect timed out")).kind)
        c = TgSupport.classify(ProxyFailure("SOCKS5 代理的用户名或密码不对"))
        assertEquals("net", c.kind); assertTrue(c.message!!.startsWith("SOCKS5 代理的用户名或密码不对"))
        val le = runCatching { TgSupport.parseLink("https://t.me/+abc") }.exceptionOrNull()
        assertEquals("invalid", TgSupport.classify(le).kind)
        assertEquals("other", TgSupport.classify(rpc("SOMETHING_ODD")).kind)
        assertEquals("Telegram 出错了：SOMETHING_ODD", TgSupport.classify(rpc("SOMETHING_ODD")).message)
        val te = TgError("protected", TgSupport.PROTECTED_MSG)
        assertTrue(TgSupport.classify(te) === te)
    }

    @Test fun redaction() {
        val session = "{\"keys\":{\"2\":\"" + "ab".repeat(256) + "\"}}"
        val s = TgSupport.redact("session=$session apiHash: 0123456789abcdef0123456789abcdef phone +86 138 0013 8000 code=12345 pw hunter22 手机 13800138000",
            listOf("hunter22", "12345", "+8613800138000"))
        assertFalse(s.contains("abababab")); assertFalse(s.contains("0123456789abcdef")); assertFalse(s.contains("hunter22"))
        assertFalse(s.contains("12345")); assertFalse(s.contains("13800138000")); assertFalse(s.contains("138 0013"))
        assertEquals("连接 Telegram：直连", TgSupport.redact("连接 Telegram：直连"))
        assertTrue(TgSupport.redact("api_hash=deadbeef").contains("<已隐藏>"))
    }

    @Test fun loginInput() {
        assertEquals("+8613800138000", TgSupport.normalizePhone("138 0013-8000"))
        assertEquals("+8613800138000", TgSupport.normalizePhone("008613800138000"))
        assertEquals("+447700900123", TgSupport.normalizePhone("+44 7700 900123"))
        assertEquals("auth_phone", (runCatching { TgSupport.normalizePhone("abc") }.exceptionOrNull() as TgError).kind)
        assertEquals(12345 to "0123456789abcdef0123456789abcdef", TgSupport.checkApi(" 12345 ", "0123456789ABCDEF0123456789ABCDEF"))
        assertTrue(msgOf { TgSupport.checkApi("12a45", "0123456789abcdef0123456789abcdef") }.contains("api_id 应该是一串数字"))
        assertTrue(msgOf { TgSupport.checkApi("12345", "xyz") }.contains("api_hash 应该是 32 位"))
        assertTrue(msgOf { TgSupport.checkApi("99999999999", "0123456789abcdef0123456789abcdef") }.contains("api_id"))
    }
}
