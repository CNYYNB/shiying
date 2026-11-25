package com.louis.shiying

import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgClient
import com.louis.shiying.mtproto.TgDevice
import com.louis.shiying.mtproto.TgSession
import com.louis.shiying.mtproto.TlObj
import com.louis.shiying.mtproto.TlSchema
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Live MTProto test against Telegram's production servers, opt-in: SHIYING_TG_LIVE=1 gradle :app:testReleaseUnitTest --tests '*TgLiveTest*'.
 * SHIYING_TG_PROXY=socks5://… or tg://proxy?… runs it through that proxy. No account / api_id needed: it creates a real auth key (DH exchange, RSA_PAD), sends encrypted RPCs, and expects
 * API_ID_INVALID for a made-up api_id – which proves transport, handshake, encryption, msg_id/salt handling and TL parsing work.
 */
class TgLiveTest {
    private fun schema() = TlSchema(File("src/main/assets/telegram/schema.tl").readText(), File("src/main/assets/telegram/api.tl").readText())

    @Test fun handshakeAndRpcError() {
        assumeTrue(System.getenv("SHIYING_TG_LIVE") == "1")
        val ses = TgSession()
        val proxy = TgSupport.parseProxy(System.getenv("SHIYING_TG_PROXY"))
        println("proxy: ${TgSupport.describeProxy(proxy)}")
        val c = TgClient(schema(), 1, "0".repeat(32), ses, proxy, TgDevice("JVM test", "Linux", "2.4"), log = { println("[tg] $it") })
        try {
            val via = c.ping()
            println("connected: $via, key ${ses.keys[2]?.size} bytes")
            assertEquals(256, ses.keys[2]?.size)
            val nearest = runCatching { c.call(TlObj.of("help.getNearestDc")) }
            println("help.getNearestDc → ${nearest.getOrNull() ?: nearest.exceptionOrNull()}")
            val e = runCatching { c.call(TlObj.of("auth.sendCode", "phone_number" to "+8613800138000", "api_id" to 1, "api_hash" to "0".repeat(32), "settings" to TlObj.of("codeSettings"))) }
            println("auth.sendCode → ${e.exceptionOrNull()}")
            val err = e.exceptionOrNull()
            assertTrue("expected RpcError, got $err", err is RpcError)
            assertTrue((err as RpcError).error, err.error.startsWith("API_ID") || err.error.contains("MIGRATE"))
            println("classified: " + TgSupport.classify(err, "login").message)
        } finally { c.close() }
    }
}
