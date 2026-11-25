package com.louis.shiying.mtproto

import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Where the TCP connection goes. */
sealed class TgProxy {
    /** SOCKS5 (with optional user / password, RFC 1929). */
    data class Socks5(val host: String, val port: Int, val user: String? = null, val pass: String? = null) : TgProxy()
    /** MTProxy: [secret] = 16 bytes, or 17 bytes starting with 0xdd (padded intermediate). FakeTLS (0xee) is not supported. */
    class MtProxy(val host: String, val port: Int, val secret: ByteArray) : TgProxy() {
        val padded get() = secret.size == 17 && secret[0] == 0xdd.toByte()
        val key16: ByteArray get() = if (secret.size == 17) secret.copyOfRange(1, 17) else secret
    }
}

class ProxyFailure(msg: String) : IOException(msg)

/**
 * One TCP connection to a Telegram DC with the obfuscated2 transport (intermediate framing, or padded intermediate
 * for dd-MTProxies) – what official apps use, and the only thing MTProxies accept.
 */
class Transport(
    private val host: String, private val port: Int, private val dcId: Int, private val proxy: TgProxy?,
    private val connectTimeoutMs: Int = 15_000,
) {
    private var socket: Socket? = null
    private lateinit var ins: DataInputStream
    private lateinit var out: OutputStream
    private lateinit var enc: Crypto.Ctr
    private lateinit var dec: Crypto.Ctr
    private val padded = (proxy as? TgProxy.MtProxy)?.padded == true
    @Volatile var closed = false
        private set

    val describe: String get() = when (proxy) {
        null -> "直连"
        is TgProxy.Socks5 -> "SOCKS5 ${proxy.host}:${proxy.port}"
        is TgProxy.MtProxy -> "MTProxy ${proxy.host}:${proxy.port}"
    }

    fun connect() {
        val s = Socket()
        socket = s
        try {
            s.tcpNoDelay = true
            when (proxy) {
                null -> s.connect(InetSocketAddress(host, port), connectTimeoutMs)
                is TgProxy.MtProxy -> s.connect(InetSocketAddress(proxy.host, proxy.port), connectTimeoutMs)
                is TgProxy.Socks5 -> {
                    try { s.connect(InetSocketAddress(proxy.host, proxy.port), connectTimeoutMs) } catch (e: IOException) {
                        throw ProxyFailure("连不上代理 ${proxy.host}:${proxy.port}（${e.message ?: e.javaClass.simpleName}）")
                    }
                    s.soTimeout = connectTimeoutMs
                    socks5(s.getInputStream(), s.getOutputStream(), proxy)
                }
            }
            s.soTimeout = 0
            ins = DataInputStream(s.getInputStream().buffered(64 * 1024))
            out = s.getOutputStream()
            handshake()
        } catch (e: Exception) {
            close(); throw e
        }
    }

    private fun socks5(i: InputStream, o: OutputStream, p: TgProxy.Socks5) {
        val auth = !p.user.isNullOrEmpty()
        o.write(if (auth) byteArrayOf(5, 2, 0, 2) else byteArrayOf(5, 1, 0)); o.flush()
        val r = readN(i, 2)
        if (r[0].toInt() != 5) throw ProxyFailure("代理不是 SOCKS5（可能是 HTTP 代理端口）")
        when (r[1].toInt() and 0xff) {
            0 -> {}
            2 -> {
                val u = (p.user ?: "").toByteArray(); val pw = (p.pass ?: "").toByteArray()
                o.write(byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(pw.size.toByte()) + pw); o.flush()
                val a = readN(i, 2)
                if (a[1].toInt() != 0) throw ProxyFailure("SOCKS5 代理的用户名或密码不对")
            }
            0xff -> throw ProxyFailure(if (auth) "SOCKS5 代理不接受这个用户名 / 密码方式" else "SOCKS5 代理需要用户名和密码")
            else -> throw ProxyFailure("SOCKS5 代理握手失败")
        }
        val hb = host.toByteArray()
        val req = byteArrayOf(5, 1, 0, 3, hb.size.toByte()) + hb + byteArrayOf((port shr 8).toByte(), port.toByte())
        o.write(req); o.flush()
        val h = readN(i, 4)
        if (h[1].toInt() != 0) {
            throw ProxyFailure("SOCKS5 代理拒绝连接 Telegram（" + when (h[1].toInt()) {
                1 -> "代理内部错误"; 2 -> "规则不允许"; 3 -> "网络不可达"; 4 -> "主机不可达"; 5 -> "连接被拒绝"; 6 -> "超时"
                7 -> "不支持的命令"; 8 -> "不支持的地址类型"; else -> "错误 ${h[1]}"
            } + "）")
        }
        when (h[3].toInt()) { 1 -> readN(i, 4 + 2); 3 -> readN(i, (i.read() and 0xff) + 2); 4 -> readN(i, 16 + 2) }
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val b = ByteArray(n); var o = 0
        while (o < n) { val r = i.read(b, o, n - o); if (r < 0) throw ProxyFailure("代理断开了连接"); o += r }
        return b
    }

    private fun handshake() {
        val tag = if (padded) 0xdddddddd.toInt() else 0xeeeeeeee.toInt()
        var init: ByteArray
        while (true) {
            init = Crypto.randomBytes(64)
            val first = ByteBuffer.wrap(init, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
            val second = ByteBuffer.wrap(init, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            if (init[0] == 0xef.toByte() || second == 0) continue
            if (first in BAD_FIRST) continue
            break
        }
        ByteBuffer.wrap(init, 56, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(tag)
        ByteBuffer.wrap(init, 60, 2).order(ByteOrder.LITTLE_ENDIAN).putShort(dcId.toShort())
        val rev = init.copyOfRange(8, 56).reversedArray()
        var encKey = init.copyOfRange(8, 40); val encIv = init.copyOfRange(40, 56)
        var decKey = rev.copyOfRange(0, 32); val decIv = rev.copyOfRange(32, 48)
        (proxy as? TgProxy.MtProxy)?.let { mp ->
            encKey = Crypto.sha256(encKey, mp.key16)
            decKey = Crypto.sha256(decKey, mp.key16)
        }
        enc = Crypto.Ctr(encKey, encIv)
        dec = Crypto.Ctr(decKey, decIv)
        val encrypted = enc.update(init)
        System.arraycopy(encrypted, 56, init, 56, 8)
        out.write(init); out.flush()
    }

    @Synchronized
    fun send(payload: ByteArray) {
        if (closed) throw IOException("连接已关闭")
        val pad = if (padded) Crypto.randomBytes(Crypto.random.nextInt(16)) else ByteArray(0)
        val len = payload.size + pad.size
        val head = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(len).array()
        out.write(enc.update(head + payload + pad))
        out.flush()
    }

    /** Next packet (blocking). A 4-byte negative int is a transport error (-404 unknown auth key, -429 flood …). */
    fun recv(): ByteArray {
        val head = dec.update(readFully(4))
        val len = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN).int
        if (len <= 0 || len > 16 * 1024 * 1024) throw IOException("Telegram 传输层数据异常（长度 $len）")
        var body = dec.update(readFully(len))
        if (padded && len > 4) {
            // strip the random padding: encrypted MTProto packets are 24 + 16n bytes, plain ones carry their length
            body = if (body.size >= 8 && ByteBuffer.wrap(body, 0, 8).order(ByteOrder.LITTLE_ENDIAN).long == 0L && body.size >= 20) {
                val ml = ByteBuffer.wrap(body, 16, 4).order(ByteOrder.LITTLE_ENDIAN).int
                body.copyOf(minOf(body.size, 20 + ml))
            } else body.copyOf(24 + (body.size - 24) / 16 * 16)
        }
        if (body.size == 4) {
            val code = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN).int
            throw TransportError(code)
        }
        return body
    }

    private fun readFully(n: Int): ByteArray {
        val b = ByteArray(n)
        try { ins.readFully(b) } catch (e: IOException) { if (closed) throw IOException("连接已关闭"); throw e }
        return b
    }

    fun readTimeout(ms: Int) { runCatching { socket?.soTimeout = ms } }

    fun close() {
        closed = true
        runCatching { socket?.close() }
    }

    class TransportError(val code: Int) : IOException("Telegram 传输层错误 $code")

    companion object {
        private val BAD_FIRST = setOf(
            0x44414548, // HEAD
            0x54534f50, // POST
            0x20544547, // GET
            0x4954504f, // OPTI
            0xdddddddd.toInt(), 0xeeeeeeee.toInt(), 0x02010316,
        )
    }
}
