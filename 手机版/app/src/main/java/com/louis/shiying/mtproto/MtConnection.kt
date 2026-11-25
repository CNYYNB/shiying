package com.louis.shiying.mtproto

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** An RPC error from Telegram (error_code + error_message such as FLOOD_WAIT_30, CHANNEL_PRIVATE). */
class RpcError(val code: Int, val error: String) : Exception(error) {
    /** Seconds from FLOOD_WAIT_X / FLOOD_PREMIUM_WAIT_X / SLOWMODE_WAIT_X, else null. */
    val waitSeconds: Int? get() = Regex("""(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|TAKEOUT_INIT_DELAY)_(\d+)""").find(error)?.groupValues?.get(1)?.toIntOrNull()
    /** DC number from PHONE_MIGRATE_X / USER_MIGRATE_X / NETWORK_MIGRATE_X / FILE_MIGRATE_X / STATS_MIGRATE_X. */
    val migrateDc: Int? get() = Regex("""^(PHONE|USER|NETWORK|FILE|STATS)_MIGRATE_(\d+)$""").find(error)?.groupValues?.get(2)?.toIntOrNull()
}

/** Auth key (256 bytes) plus its id. */
class AuthKey(val key: ByteArray) {
    private val sha = Crypto.sha1(key)
    val id: Long = ByteBuffer.wrap(sha, 12, 8).order(ByteOrder.LITTLE_ENDIAN).long
    val auxHash: ByteArray = sha.copyOfRange(0, 8)
}

/**
 * One encrypted MTProto session on one TCP connection to one DC. Thread-safe: many [invoke]s can be in flight at once
 * (the downloader pipelines file parts). A reader thread dispatches responses; service messages
 * (bad_server_salt, bad_msg_notification, new_session_created, containers, gzip, acks) are handled here.
 */
class MtConnection(
    private val schema: TlSchema,
    val dc: Int,
    private val transportFactory: () -> Transport,
    var authKey: AuthKey?,
    private val log: (String) -> Unit = {},
) {
    private class Pending(val body: ByteArray, val returnType: String, val contentRelated: Boolean = true) {
        val latch = CountDownLatch(1)
        @Volatile var result: Any? = null
        @Volatile var error: Exception? = null
        @Volatile var msgId: Long = 0
    }

    private var transport: Transport? = null
    private val pending = ConcurrentHashMap<Long, Pending>()
    private val toAck = java.util.Collections.synchronizedList(ArrayList<Long>())
    @Volatile private var salt: Long = 0
    private var sessionId: Long = 0
    private var seq = 0
    private var lastMsgId = 0L
    @Volatile var timeOffset: Long = 0
    @Volatile private var reader: Thread? = null
    /** initConnection was sent on this TCP session. */
    @Volatile var initDone = false
    @Volatile var connectedVia: String = ""
        private set
    private val lock = Object()

    val isOpen: Boolean get() = transport?.closed == false

    /** Opens the TCP connection and creates the auth key when there is none yet (DH exchange). */
    fun open() {
        synchronized(lock) {
            if (isOpen) return
            val t = transportFactory()
            t.connect()
            connectedVia = t.describe
            if (authKey == null) {
                t.readTimeout(20_000)
                val r = try { Handshake(schema, t).run() } catch (e: java.net.SocketTimeoutException) {
                    t.close(); throw IOException("Telegram 握手超时（timed out），可能被网络拦截")
                } catch (e: Exception) { t.close(); throw e }
                t.readTimeout(0)
                authKey = r.first; timeOffset = r.second.toLong(); salt = r.third
            }
            transport = t
            sessionId = Crypto.random.nextLong()
            initDone = false
            seq = 0; lastMsgId = 0
            val th = Thread({ readLoop(t) }, "mtproto-dc$dc")
            th.isDaemon = true
            reader = th
            th.start()
        }
    }

    fun close() {
        synchronized(lock) {
            transport?.close(); transport = null
        }
        failAll(IOException("连接已关闭"))
    }

    private fun failAll(e: Exception) {
        val list = pending.values.toList(); pending.clear()
        for (p in list) { p.error = e; p.latch.countDown() }
    }

    // ------------------------------------------------------------------ sending

    private fun newMsgId(): Long {
        val nowMs = System.currentTimeMillis() + timeOffset * 1000
        val sec = nowMs / 1000
        val nanos = (nowMs % 1000) * 1_000_000 + Crypto.random.nextInt(1_000_000)
        var id = (sec shl 32) or ((nanos shl 2) and 0xfffffffcL)
        if (id <= lastMsgId) id = lastMsgId + 4
        lastMsgId = id
        return id
    }

    private fun nextSeq(contentRelated: Boolean): Int = if (contentRelated) (seq++ * 2 + 1) else seq * 2

    /** Encrypts and writes one message; returns its msg_id. */
    private fun sendMessage(body: ByteArray, contentRelated: Boolean, register: Pending?): Long {
        val t: Transport; val key: AuthKey; val packet: ByteArray; val msgId: Long
        synchronized(lock) {
            t = transport ?: throw IOException("连接已关闭")
            key = authKey ?: throw IOException("没有 auth key")
            msgId = newMsgId()
            val seqNo = nextSeq(contentRelated)
            if (register != null) { register.msgId = msgId; pending[msgId] = register }
            val plain = ByteBuffer.allocate(32 + body.size).order(ByteOrder.LITTLE_ENDIAN)
            plain.putLong(salt).putLong(sessionId).putLong(msgId).putInt(seqNo).putInt(body.size).put(body)
            packet = encrypt(key, plain.array())
            t.send(packet)
        }
        return msgId
    }

    private fun encrypt(key: AuthKey, data: ByteArray): ByteArray {
        val padLen = ((16 - (data.size + 12) % 16) % 16) + 12 + 16 * Crypto.random.nextInt(4)
        val padded = data + Crypto.randomBytes(padLen)
        val msgKeyLarge = Crypto.sha256(key.key.copyOfRange(88, 120), padded)
        val msgKey = msgKeyLarge.copyOfRange(8, 24)
        val (aesKey, aesIv) = kdf(key.key, msgKey, 0)
        val enc = Crypto.igeEncrypt(padded, aesKey, aesIv)
        val idb = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(key.id).array()
        return idb + msgKey + enc
    }

    private fun kdf(authKey: ByteArray, msgKey: ByteArray, x: Int): Pair<ByteArray, ByteArray> {
        val a = Crypto.sha256(msgKey, authKey.copyOfRange(x, x + 36))
        val b = Crypto.sha256(authKey.copyOfRange(40 + x, 76 + x), msgKey)
        val key = a.copyOfRange(0, 8) + b.copyOfRange(8, 24) + a.copyOfRange(24, 32)
        val iv = b.copyOfRange(0, 8) + a.copyOfRange(8, 24) + b.copyOfRange(24, 32)
        return key to iv
    }

    /** Sends [req] and waits for its result (an RPC error is thrown as [RpcError]). */
    fun invoke(req: TlObj, timeoutMs: Long = 30_000, returnType: String? = null): Any? {
        open()
        flushAcks()
        val p = Pending(schema.serialize(req), returnType ?: schema.returnType(req))
        sendMessage(p.body, true, p)
        if (!p.latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            pending.remove(p.msgId)
            log("dc$dc ${req.type} 等待超时，重新连接")
            close()
            throw IOException("Telegram 服务器响应超时（timed out）")
        }
        p.error?.let { throw it }
        return p.result
    }

    private fun flushAcks() {
        val ids: List<Long>
        synchronized(toAck) { if (toAck.isEmpty()) return; ids = toAck.toList(); toAck.clear() }
        runCatching { sendMessage(schema.serialize(TlObj.of("msgs_ack", "msg_ids" to ids)), false, null) }
    }

    private fun resend(oldId: Long) {
        val p = pending.remove(oldId) ?: return
        try { sendMessage(p.body, p.contentRelated, p) } catch (e: Exception) { p.error = e; p.latch.countDown() }
    }

    // ------------------------------------------------------------------ receiving

    private fun readLoop(t: Transport) {
        try {
            while (!t.closed) {
                val packet = t.recv()
                val key = authKey ?: break
                handlePacket(key, packet)
                if (toAck.size >= 8) flushAcks()
            }
        } catch (e: Exception) {
            if (!t.closed) log("dc$dc 连接断开：${e.message ?: e.javaClass.simpleName}")
            synchronized(lock) { if (transport === t) transport = null }
            t.close()
            failAll(if (e is Transport.TransportError && e.code == -404) IOException("Telegram 不认这个登录密钥（-404）") else
                if (e is IOException) e else IOException(e.message ?: "连接错误"))
        }
    }

    private fun handlePacket(key: AuthKey, packet: ByteArray) {
        if (packet.size < 24 + 32) throw IOException("Telegram 返回的数据太短")
        val keyId = ByteBuffer.wrap(packet, 0, 8).order(ByteOrder.LITTLE_ENDIAN).long
        if (keyId != key.id) throw IOException("Telegram 返回的 auth key id 不对")
        val msgKey = packet.copyOfRange(8, 24)
        val (aesKey, aesIv) = kdf(key.key, msgKey, 8)
        val plain = Crypto.igeDecrypt(packet.copyOfRange(24, packet.size), aesKey, aesIv)
        val check = Crypto.sha256(key.key.copyOfRange(96, 128), plain).copyOfRange(8, 24)
        if (!check.contentEquals(msgKey)) throw IOException("Telegram 返回的 msg_key 校验失败")
        val bb = ByteBuffer.wrap(plain).order(ByteOrder.LITTLE_ENDIAN)
        bb.long // salt
        val sid = bb.long
        if (sid != sessionId) return
        val msgId = bb.long
        val seqNo = bb.int
        val len = bb.int
        if (len < 0 || len > plain.size - 32) throw IOException("Telegram 返回的消息长度不对")
        handleMessage(msgId, seqNo, plain.copyOfRange(32, 32 + len))
    }

    private fun handleMessage(msgId: Long, seqNo: Int, body: ByteArray) {
        if (seqNo and 1 == 1) toAck += msgId
        val r = TlReader(schema, body)
        val id = r.int()
        when (id) {
            RPC_RESULT -> {
                val reqId = r.long()
                val p = pending.remove(reqId) ?: return
                val save = r.position
                val inner = r.int()
                if (inner == RPC_ERROR) {
                    val code = r.int(); val msg = String(r.tlBytes(), Charsets.UTF_8)
                    p.error = RpcError(code, msg)
                } else {
                    try {
                        val rr = TlReader(schema, body.copyOfRange(save, body.size))
                        p.result = rr.obj(p.returnType)
                    } catch (e: Exception) { p.error = IOException("解析 Telegram 返回的数据失败：${e.message}") }
                }
                p.latch.countDown()
            }
            MSG_CONTAINER -> {
                val n = r.int()
                repeat(n) {
                    val mid = r.long(); val s = r.int(); val l = r.int()
                    handleMessage(mid, s, r.raw(l))
                }
            }
            TlWriter.GZIP -> {
                val data = java.util.zip.GZIPInputStream(r.tlBytes().inputStream()).readBytes()
                handleMessage(msgId, seqNo and 1.inv(), data)
            }
            else -> {
                val c = schema.byId[id] ?: return // unknown update types are ignored
                val o = try { r.fields(c) } catch (e: Exception) { return }
                when (o.type) {
                    "bad_server_salt" -> { salt = o.long("new_server_salt") ?: salt; resend(o.long("bad_msg_id") ?: 0) }
                    "bad_msg_notification" -> {
                        val bad = o.long("bad_msg_id") ?: 0
                        when (o.int("error_code")) {
                            16, 17 -> { timeOffset = (msgId ushr 32) - System.currentTimeMillis() / 1000; synchronized(lock) { lastMsgId = 0 }; resend(bad) }
                            32 -> { synchronized(lock) { seq += 64 }; resend(bad) }
                            33 -> { synchronized(lock) { seq -= 16 }; resend(bad) }
                            else -> pending.remove(bad)?.let { it.error = IOException("Telegram bad_msg_notification ${o.int("error_code")}"); it.latch.countDown() }
                        }
                    }
                    "new_session_created" -> { salt = o.long("server_salt") ?: salt }
                    "pong" -> pending.remove(o.long("msg_id") ?: 0)?.let { it.result = o; it.latch.countDown() }
                    else -> {} // msgs_ack, updates*, msg_detailed_info … nothing to do
                }
            }
        }
    }

    companion object {
        const val RPC_RESULT = 0xf35c6d01.toInt()
        const val RPC_ERROR = 0x2144ca19
        const val MSG_CONTAINER = 0x73f1f8dc
    }
}

/** Plain (unencrypted) DH exchange that creates a permanent auth key. → (key, time offset, first salt) */
class Handshake(private val schema: TlSchema, private val t: Transport) {
    private var lastId = 0L

    private fun send(req: TlObj): TlObj {
        val body = schema.serialize(req)
        var id = (System.currentTimeMillis() / 1000 shl 32) or ((System.nanoTime() and 0x3fffffff) shl 2)
        if (id <= lastId) id = lastId + 4
        lastId = id
        val bb = ByteBuffer.allocate(20 + body.size).order(ByteOrder.LITTLE_ENDIAN)
        bb.putLong(0).putLong(id).putInt(body.size).put(body)
        t.send(bb.array())
        val resp = t.recv()
        val rb = ByteBuffer.wrap(resp).order(ByteOrder.LITTLE_ENDIAN)
        if (rb.long != 0L) throw IOException("握手时收到加密消息")
        rb.long
        val len = rb.int
        val r = TlReader(schema, resp.copyOfRange(20, 20 + len), rawStrings = true)
        return r.obj() as TlObj
    }

    fun run(): Triple<AuthKey, Int, Long> {
        val nonce = Crypto.randomBytes(16)
        val resPq = send(TlObj.of("req_pq_multi", "nonce" to nonce))
        if (resPq.type != "resPQ" || !nonce.contentEquals(resPq.bytes("nonce"))) throw IOException("握手第 1 步失败")
        val serverNonce = resPq.bytes("server_nonce")!!
        val pq = Crypto.big(resPq.bytes("pq")!!)
        val (p, q) = Crypto.factorize(pq)
        val newNonce = Crypto.randomBytes(32)
        val fps = resPq.list("server_public_key_fingerprints").map { (it as Number).toLong() }
        val key = Crypto.SERVER_KEYS.firstOrNull { it.fingerprint in fps } ?: throw IOException("握手失败：服务器公钥不认识")
        val inner = schema.serialize(TlObj.of("p_q_inner_data", "pq" to Crypto.toBytes(pq), "p" to Crypto.toBytes(p), "q" to Crypto.toBytes(q),
            "nonce" to nonce, "server_nonce" to serverNonce, "new_nonce" to newNonce))
        val encrypted = Crypto.rsaPad(inner, key)
        val dh = send(TlObj.of("req_DH_params", "nonce" to nonce, "server_nonce" to serverNonce, "p" to Crypto.toBytes(p), "q" to Crypto.toBytes(q),
            "public_key_fingerprint" to key.fingerprint, "encrypted_data" to encrypted))
        if (dh.type != "server_DH_params_ok") throw IOException("握手第 2 步失败（${dh.type}）")
        if (!nonce.contentEquals(dh.bytes("nonce")) || !serverNonce.contentEquals(dh.bytes("server_nonce"))) throw IOException("握手 nonce 不对")
        val h1 = Crypto.sha1(newNonce, serverNonce); val h2 = Crypto.sha1(serverNonce, newNonce); val h3 = Crypto.sha1(newNonce, newNonce)
        val tmpKey = h1 + h2.copyOfRange(0, 12)
        val tmpIv = h2.copyOfRange(12, 20) + h3 + newNonce.copyOfRange(0, 4)
        val ans = dh.bytes("encrypted_answer")!!
        if (ans.size % 16 != 0) throw IOException("握手数据长度不对")
        val plain = Crypto.igeDecrypt(ans, tmpKey, tmpIv)
        val ir = TlReader(schema, plain.copyOfRange(20, plain.size), rawStrings = true)
        val innerData = ir.obj() as TlObj
        val innerLen = ir.position
        if (!Crypto.sha1(plain.copyOfRange(20, 20 + innerLen)).contentEquals(plain.copyOfRange(0, 20))) throw IOException("握手数据校验失败")
        if (innerData.type != "server_DH_inner_data" || !nonce.contentEquals(innerData.bytes("nonce"))) throw IOException("握手第 3 步失败")
        val dhPrime = Crypto.big(innerData.bytes("dh_prime")!!)
        val g = java.math.BigInteger.valueOf(innerData.int("g")!!.toLong())
        val ga = Crypto.big(innerData.bytes("g_a")!!)
        checkDh(dhPrime, g, ga)
        val timeOffset = innerData.int("server_time")!! - (System.currentTimeMillis() / 1000).toInt()
        val one = java.math.BigInteger.ONE
        var b: java.math.BigInteger; var gb: java.math.BigInteger
        do {
            b = Crypto.big(Crypto.randomBytes(256))
            gb = g.modPow(b, dhPrime)
        } while (gb <= one || gb >= dhPrime.subtract(one))
        val gab = ga.modPow(b, dhPrime)
        val clientInner = schema.serialize(TlObj.of("client_DH_inner_data", "nonce" to nonce, "server_nonce" to serverNonce, "retry_id" to 0L, "g_b" to Crypto.toBytes(gb)))
        var data = Crypto.sha1(clientInner) + clientInner
        if (data.size % 16 != 0) data += Crypto.randomBytes(16 - data.size % 16)
        val res = send(TlObj.of("set_client_DH_params", "nonce" to nonce, "server_nonce" to serverNonce, "encrypted_data" to Crypto.igeEncrypt(data, tmpKey, tmpIv)))
        val authKey = AuthKey(Crypto.toBytes(gab, 256))
        val num = when (res.type) { "dh_gen_ok" -> 1; "dh_gen_retry" -> 2; else -> 3 }
        val expected = Crypto.sha1(newNonce, byteArrayOf(num.toByte()), authKey.auxHash).copyOfRange(4, 20)
        if (!expected.contentEquals(res.bytes("new_nonce_hash$num"))) throw IOException("握手 new_nonce_hash 不对")
        if (num != 1) throw IOException("握手第 3 步被拒绝（${res.type}）")
        val salt = ByteBuffer.wrap(Crypto.xor(newNonce.copyOfRange(0, 8), serverNonce.copyOfRange(0, 8))).order(ByteOrder.LITTLE_ENDIAN).long
        return Triple(authKey, timeOffset, salt)
    }

    private fun checkDh(p: java.math.BigInteger, g: java.math.BigInteger, ga: java.math.BigInteger) {
        if (p.bitLength() != 2048 || !p.isProbablePrime(20) || !p.subtract(java.math.BigInteger.ONE).shiftRight(1).isProbablePrime(20)) throw IOException("握手 DH 参数不安全")
        val one = java.math.BigInteger.ONE
        if (ga <= one || ga >= p.subtract(one)) throw IOException("握手 g_a 不安全")
        if (g.toInt() !in 2..7) throw IOException("握手 g 不对")
    }
}
