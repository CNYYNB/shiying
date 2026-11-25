package com.louis.shiying.mtproto

import org.json.JSONObject
import java.io.IOException

/** What the app keeps between runs (encrypted by the caller). Auth keys per DC, the home DC and peer access hashes. */
class TgSession(
    var mainDc: Int = 2,
    val keys: MutableMap<Int, ByteArray> = HashMap(),
    /** DCs where this account is authorized (home DC + DCs we imported the authorization to). */
    val authorized: MutableSet<Int> = HashSet(),
    var userId: Long = 0,
    /** "c<channelId>" / "u<userId>" → access_hash. */
    val peers: MutableMap<String, Long> = HashMap(),
    var test: Boolean = false,
) {
    val loggedIn get() = userId != 0L && authorized.contains(mainDc)

    fun toJson(): String = JSONObject().apply {
        put("v", 1); put("dc", mainDc); put("user", userId); put("test", test)
        put("keys", JSONObject().apply { keys.forEach { (d, k) -> put(d.toString(), Hex.enc(k)) } })
        put("auth", org.json.JSONArray(authorized.toList()))
        put("peers", JSONObject().apply { peers.entries.toList().takeLast(2000).forEach { (k, v) -> put(k, v.toString()) } })
    }.toString()

    companion object {
        fun fromJson(s: String): TgSession {
            val o = JSONObject(s)
            val ses = TgSession(o.optInt("dc", 2), test = o.optBoolean("test", false))
            ses.userId = o.optLong("user", 0)
            o.optJSONObject("keys")?.let { k -> k.keys().forEach { d -> ses.keys[d.toInt()] = Hex.dec(k.getString(d)) } }
            o.optJSONArray("auth")?.let { a -> for (i in 0 until a.length()) ses.authorized += a.getInt(i) }
            o.optJSONObject("peers")?.let { p -> p.keys().forEach { k -> p.optString(k).toLongOrNull()?.let { ses.peers[k] = it } } }
            return ses
        }
    }
}

/** Device info sent in initConnection (shown in Telegram → 设置 → 设备). */
class TgDevice(val model: String, val system: String, val appVersion: String, val langCode: String = "zh", val systemLang: String = "zh-CN")

/** Calls Telegram methods. [call] runs on the home DC unless [dc] is given (file downloads use the file's DC). */
interface TgApi {
    fun call(req: TlObj, dc: Int? = null, timeoutMs: Long = 30_000): Any?
    val session: TgSession
}

/**
 * MTProto client: one [MtConnection] per DC, initConnection/invokeWithLayer on every new connection, *_MIGRATE handling,
 * authorization export/import for file DCs, short FLOOD_WAIT sleeps (≤ [floodSleepMax] s, like GramJS floodSleepThreshold).
 */
class TgClient(
    val schema: TlSchema,
    private val apiId: Int,
    private val apiHash: String,
    override val session: TgSession,
    private val proxy: TgProxy?,
    private val device: TgDevice,
    private val log: (String) -> Unit = {},
    private val floodSleepMax: Int = 15,
    private val onSessionChanged: () -> Unit = {},
) : TgApi {
    private val conns = HashMap<Int, MtConnection>()
    @Volatile var closed = false
        private set

    val via: String get() = conns.values.firstOrNull { it.isOpen }?.connectedVia ?: (proxy?.let { describe(it) } ?: "直连")

    private fun describe(p: TgProxy) = when (p) { is TgProxy.Socks5 -> "SOCKS5 ${p.host}:${p.port}"; is TgProxy.MtProxy -> "MTProxy ${p.host}:${p.port}" }

    @Synchronized
    private fun conn(dc: Int): MtConnection {
        if (closed) throw IOException("客户端已关闭")
        conns[dc]?.let { return it }
        val (host, port) = address(dc, session.test)
        val c = MtConnection(schema, dc, {
            Transport(host, port, if (session.test) 10000 + dc else dc, proxy)
        }, session.keys[dc]?.let { AuthKey(it) }, log)
        conns[dc] = c
        return c
    }

    /** Opens the connection to [dc] (creating its auth key if needed). */
    fun connect(dc: Int = session.mainDc) {
        val c = conn(dc)
        val hadKey = c.authKey != null
        c.open()
        if (!hadKey) { session.keys[dc] = c.authKey!!.key; onSessionChanged() }
    }

    private fun wrapInit(req: TlObj): TlObj = TlObj.of("invokeWithLayer", "layer" to LAYER, "query" to TlObj.of("initConnection",
        "api_id" to apiId, "device_model" to device.model, "system_version" to device.system, "app_version" to device.appVersion,
        "system_lang_code" to device.systemLang, "lang_pack" to "", "lang_code" to device.langCode, "query" to req))

    private fun rawCall(dc: Int, req: TlObj, timeoutMs: Long): Any? {
        connect(dc)
        val c = conn(dc)
        val first = !c.initDone
        val r = c.invoke(if (first) wrapInit(req) else req, timeoutMs, schema.returnType(req))
        if (first) c.initDone = true
        return r
    }

    override fun call(req: TlObj, dc: Int?, timeoutMs: Long): Any? {
        var target = dc ?: session.mainDc
        var netRetries = 0
        var floodRetries = 0
        while (true) {
            if (target != session.mainDc && session.loggedIn && target !in session.authorized) importAuth(target)
            try {
                return rawCall(target, req, timeoutMs)
            } catch (e: RpcError) {
                val mig = e.migrateDc
                if (mig != null && mig != target) {
                    log("${req.type}：${e.error}，换到 DC $mig")
                    if (e.error.startsWith("FILE_") || e.error.startsWith("STATS_")) { target = mig; continue }
                    if (!session.loggedIn) { session.mainDc = mig; onSessionChanged() }
                    target = mig; continue
                }
                val w = e.waitSeconds
                if (w != null && w <= floodSleepMax && floodRetries < 2) { floodRetries++; log("${req.type}：等待 $w 秒（FLOOD_WAIT）"); Thread.sleep(w * 1000L + 500); continue }
                if (e.error == "AUTH_KEY_UNREGISTERED" && target != session.mainDc && session.loggedIn && target in session.authorized) {
                    session.authorized -= target; onSessionChanged(); continue
                }
                throw e
            } catch (e: IOException) {
                if (closed) throw e
                if (e.message?.contains("-404") == true) {
                    // auth key forgotten by the server: drop it (the session on that DC is gone)
                    synchronized(this) { conns.remove(target)?.close() }
                    session.keys.remove(target); session.authorized -= target
                    onSessionChanged()
                    if (target == session.mainDc) throw RpcError(401, "AUTH_KEY_UNREGISTERED")
                }
                if (netRetries++ >= 1) throw e
                log("${req.type}：${e.message}，重试")
                synchronized(this) { conns.remove(target)?.close() }
            }
        }
    }

    private val authLock = Any()

    private fun importAuth(dc: Int) { synchronized(authLock) {
        if (dc in session.authorized) return
        log("把登录状态带到 DC $dc")
        val exp = rawCall(session.mainDc, TlObj.of("auth.exportAuthorization", "dc_id" to dc), 30_000) as TlObj
        rawCall(dc, TlObj.of("auth.importAuthorization", "id" to exp.long("id"), "bytes" to exp.bytes("bytes")), 30_000)
        session.authorized += dc
        onSessionChanged()
    } }


    /** Cheap connectivity check: TCP + transport (+ DH when there is no key yet) on the home DC. */
    fun ping(): String {
        val had = session.keys.containsKey(session.mainDc)
        connect(session.mainDc)
        val c = conn(session.mainDc)
        if (had) c.invoke(TlObj.of("ping", "ping_id" to Crypto.random.nextLong()), 15_000)
        return c.connectedVia
    }

    fun close() {
        closed = true
        synchronized(this) { conns.values.forEach { it.close() }; conns.clear() }
    }

    companion object {
        const val LAYER = 198

        /** Production / test DC addresses (IPv4), as in Telegram clients. */
        fun address(dc: Int, test: Boolean): Pair<String, Int> = if (test) when (dc) {
            1 -> "149.154.175.10"; 3 -> "149.154.175.117"; else -> "149.154.167.40"
        } to 443 else when (dc) {
            1 -> "149.154.175.53"; 2 -> "149.154.167.51"; 3 -> "149.154.175.100"; 4 -> "149.154.167.91"; 5 -> "91.108.56.130"
            else -> "149.154.167.51"
        } to 443
    }
}

object Hex {
    fun enc(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    fun dec(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
