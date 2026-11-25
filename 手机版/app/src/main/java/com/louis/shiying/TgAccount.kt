package com.louis.shiying

import com.louis.shiying.mtproto.Crypto
import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgApi
import com.louis.shiying.mtproto.TgClient
import com.louis.shiying.mtproto.TgDevice
import com.louis.shiying.mtproto.TgProxy
import com.louis.shiying.mtproto.TgSession
import com.louis.shiying.mtproto.TlObj
import com.louis.shiying.mtproto.TlSchema
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Encrypted key/value storage for the Telegram session and settings (Android Keystore on the phone, memory in tests). */
interface TgStore {
    val available: Boolean
    fun read(name: String): String?
    fun write(name: String, value: String): Boolean
    fun delete(name: String)
}

class MemoryTgStore : TgStore {
    val map = HashMap<String, String>()
    override val available = true
    override fun read(name: String) = map[name]
    override fun write(name: String, value: String): Boolean { map[name] = value; return true }
    override fun delete(name: String) { map.remove(name) }
}

/**
 * The user's Telegram account: login (own api_id / api_hash → phone → code → 2FA password), encrypted session, proxy, logout.
 * Same steps and wording as the PC version (telegram-account.js). Stored (encrypted): "config" = {apiId, apiHash, proxy, name, username}
 * (no phone number), "session" = auth keys + home DC. Without encryption nothing is written and the login lasts until the app is closed.
 */
class TgAccount(
    private val store: TgStore,
    private val schemaProvider: () -> TlSchema,
    private val device: TgDevice,
    /** Android's system proxy (host, port) if any: tried as SOCKS5 first (Clash / v2rayNG mixed ports). */
    private val systemProxy: () -> Pair<String, Int>? = { null },
    private val clientFactory: ((TgSession, Int, String, TgProxy?) -> TgClient)? = null,
) {
    private val lines = ArrayList<String>()
    private val storeLock = Any()
    private val secrets = LinkedHashSet<String>()
    private var cfg = JSONObject()
    private var memSession: TgSession? = null
    @Volatile private var client: TgClient? = null
    @Volatile private var checked = false
    private var pending: Pending? = null
    @Volatile var via: String = ""
        private set

    private class Pending(val client: TgClient, val phone: String, val apiId: Int, val apiHash: String) {
        var phoneCodeHash: String? = null
        var step = "code"
    }

    init {
        cfg = store.read("config")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        cfg.optString("apiHash").takeIf { it.isNotEmpty() }?.let { secrets += it }
    }

    // ---------------------------------------------------------------- storage

    private fun saveCfg() { store.write("config", cfg.toString()) }

    fun session(): TgSession? = synchronized(storeLock) {
        memSession?.let { return it }
        val s = store.read("session")?.let { runCatching { TgSession.fromJson(it) }.getOrNull() }
        memSession = s
        s
    }

    private fun saveSession(s: TgSession) = synchronized(storeLock) {
        memSession = s
        store.write("session", s.toJson())
    }

    private fun clearSession() = synchronized(storeLock) {
        memSession = null
        store.delete("session")
    }

    // ---------------------------------------------------------------- diag

    fun log(s: String) = synchronized(lines) {
        val t = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        lines += "$t ${TgSupport.redact(s, secrets)}"
        if (lines.size > 300) lines.subList(0, lines.size - 300).clear()
    }

    private fun addSecret(v: String) = synchronized(lines) { secrets += v }

    fun diagText(): String = synchronized(lines) {
        val st = status()
        (listOf("Telegram：${if (st.loggedIn) "已登录" else "未登录"} · api_id ${if (st.apiIdSet) "已填" else "未填"} · 代理设置 ${st.proxyDesc} · " +
            "上次连接方式 ${via.ifEmpty { "（还没连过）" }} · 加密保存 ${if (st.encryption) "可用" else "不可用"}") +
            lines.map { TgSupport.redact(it, secrets) }).joinToString("\n")
    }

    // ---------------------------------------------------------------- status

    class Status(val loggedIn: Boolean, val apiIdSet: Boolean, val apiId: String, val hasApiHash: Boolean, val name: String, val username: String,
                 val proxy: String, val proxyDesc: String, val encryption: Boolean, val pending: String?, val via: String)

    fun loggedIn(): Boolean = session()?.loggedIn == true && cfg.optInt("apiId", 0) != 0 && cfg.optString("apiHash").isNotEmpty()

    fun status(): Status {
        val proxy = cfg.optString("proxy")
        val desc = if (proxy.isEmpty()) "跟随系统（直连 / VPN）" else runCatching { TgSupport.describeProxy(TgSupport.parseProxy(proxy)) }.getOrDefault("格式不对")
        return Status(loggedIn(), cfg.optInt("apiId", 0) != 0, cfg.optInt("apiId", 0).takeIf { it != 0 }?.toString() ?: "",
            cfg.optString("apiHash").isNotEmpty(), cfg.optString("name"), cfg.optString("username"), proxy, desc, store.available, pending?.step, via)
    }

    // ---------------------------------------------------------------- connect

    private fun candidates(): List<Pair<TgProxy?, String>> {
        val text = cfg.optString("proxy")
        if (text.isNotEmpty()) {
            val p = try { TgSupport.parseProxy(text) } catch (e: IllegalArgumentException) { throw TgError("net", "Telegram 代理设置格式不对：${e.message}") }
            return listOf(p to "拾影设置的 ${TgSupport.describeProxy(p)}")
        }
        val out = ArrayList<Pair<TgProxy?, String>>()
        systemProxy()?.let { (h, p) -> out += TgProxy.Socks5(h, p) to "系统代理端口 $h:$p（按 SOCKS5 / 混合端口试）" }
        out += null to "直连（或 VPN）"
        return out
    }

    private fun newClient(ses: TgSession, apiId: Int, apiHash: String, proxy: TgProxy?): TgClient =
        clientFactory?.invoke(ses, apiId, apiHash, proxy) ?: TgClient(schemaProvider(), apiId, apiHash, ses, proxy, device, log = { log(it) },
            onSessionChanged = { if (ses.loggedIn) synchronized(storeLock) { if (memSession === ses) saveSession(ses) } })

    /** Connects (trying the proxy candidates in order) and returns the client. */
    private fun connectNew(ses: TgSession, apiId: Int, apiHash: String): TgClient {
        val tried = ArrayList<String>()
        var last: Exception? = null
        for ((p, label) in candidates()) {
            log("连接 Telegram：$label")
            val c = newClient(ses, apiId, apiHash, p)
            try {
                withTimeout(CONNECT_TIMEOUT_MS) { c.ping() }
                via = label
                log("已连接：$label")
                return c
            } catch (e: Exception) {
                last = e; tried += label
                log("连接失败（$label）：${e.message ?: e.javaClass.simpleName}")
                c.close()
            }
        }
        val k = TgSupport.classify(last, "login")
        if (k.kind != "net") throw k
        throw TgError("net", "连不上 Telegram 服务器（试过：${tried.joinToString("、")}）。\n在国内需要代理：在「登录 → Telegram 账号登录」的「代理」里填 SOCKS5（例如 socks5://127.0.0.1:7890，Clash / v2rayN 的 SOCKS 或混合端口）或 MTProxy 链接，再试。")
    }

    private fun <T> withTimeout(ms: Long, f: () -> T): T {
        val ex = Executors.newSingleThreadExecutor()
        try {
            return ex.submit(Callable { f() }).get(ms, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            throw java.io.IOException("Connection to telegram failed: timed out")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw (e.cause as? Exception) ?: e
        } finally { ex.shutdownNow() }
    }

    /** Connected, logged-in client (used by parsing / downloading). */
    @Synchronized fun api(): TgApi {
        client?.takeIf { !it.closed && checked }?.let { return it }
        val ses = session()
        val apiId = cfg.optInt("apiId", 0); val apiHash = cfg.optString("apiHash")
        if (ses == null || !ses.loggedIn || apiId == 0 || apiHash.isEmpty()) throw TgError("session", "还没有登录 Telegram：点右上角「登录」→「Telegram 账号登录」")
        val c = client?.takeIf { !it.closed } ?: connectNew(ses, apiId, apiHash)
        client = c
        if (!checked) {
            try {
                val me = (c.call(TlObj.of("users.getUsers", "id" to listOf(TlObj.of("inputUserSelf")))) as? List<*>)?.firstOrNull() as? TlObj
                if (me == null || me.type != "user") throw RpcError(401, "AUTH_KEY_UNREGISTERED")
                setMe(me)
                checked = true
            } catch (e: Exception) {
                val k = TgSupport.classify(e)
                if (k.kind == "session") {
                    c.close(); client = null
                    log("会话已失效，清除本地登录")
                    clearSession()
                    throw TgError("session", "Telegram 登录已失效（可能在手机 Telegram 的「设备」里结束了这个会话），请重新登录")
                }
                throw k
            }
        }
        return c
    }

    private fun setMe(me: TlObj) {
        cfg.put("name", listOfNotNull(me.str("first_name"), me.str("last_name")).joinToString(" "))
        cfg.put("username", me.str("username") ?: "")
        saveCfg()
    }

    /** The saved api_hash (so the login form does not have to show or re-ask it). */
    fun savedApiHash(): String = cfg.optString("apiHash")

    @Synchronized fun dropClient() { client?.close(); client = null; checked = false }

    // ---------------------------------------------------------------- login

    class Step(val step: String, val viaApp: Boolean = false, val codeLength: Int = 0, val hint: String = "", val name: String = "", val username: String = "", val saved: Boolean = true)

    /** Step 1: save api_id / api_hash (/ proxy), send the login code. */
    fun sendCode(apiId: String, apiHash: String, phone: String, proxy: String? = null): Step {
        try {
            val (id, hash) = TgSupport.checkApi(apiId, apiHash)
            val ph = TgSupport.normalizePhone(phone)
            addSecret(hash); addSecret(ph); addSecret(ph.removePrefix("+"))
            if (proxy != null) setProxyText(proxy)
            cfg.put("apiId", id); cfg.put("apiHash", hash)
            saveCfg()
            cancelLogin()
            log("登录：发送验证码")
            // a fresh session for the login (an old one stays until the new login succeeds)
            val ses = TgSession()
            val c = connectNew(ses, id, hash)
            val p = Pending(c, ph, id, hash)
            synchronized(this) { pending = p }
            val r = c.call(TlObj.of("auth.sendCode", "phone_number" to ph, "api_id" to id, "api_hash" to hash, "settings" to TlObj.of("codeSettings"))) as TlObj
            if (r.type == "auth.sentCodeSuccess") return finish(p, r.obj("authorization"))
            p.phoneCodeHash = r.str("phone_code_hash")
            val viaApp = r.obj("type")?.type == "auth.sentCodeTypeApp"
            log("验证码已发送（${if (viaApp) "Telegram App 内" else r.obj("type")?.type?.removePrefix("auth.sentCodeType") ?: "短信"}）")
            if (r.obj("type")?.type == "auth.sentCodeTypeSetUpEmailRequired") throw TgError("auth_phone", "Telegram 要求这个账号先绑定邮箱才能在新设备登录，请先在手机 Telegram 里设置登录邮箱")
            return Step("code", viaApp, r.obj("type")?.int("length") ?: 0)
        } catch (e: Exception) {
            log("发送验证码失败：${e.message}")
            if (pending?.phoneCodeHash == null) cancelLogin()
            throw TgSupport.classify(e, "login")
        }
    }

    fun resendCode(): Step {
        val p = pending ?: throw TgError("auth_state", "请重新填写手机号并发送验证码")
        return sendCode(p.apiId.toString(), p.apiHash, p.phone)
    }

    /** Step 2: the code. → done, or password (2FA). */
    fun signIn(code: String): Step {
        val p = pending?.takeIf { it.phoneCodeHash != null } ?: throw TgError("auth_state", "请先发送验证码")
        val c = code.filter { it.isDigit() }
        if (c.isEmpty()) throw TgError("auth_code", "请输入验证码")
        addSecret(c)
        try {
            log("登录：提交验证码")
            val r = p.client.call(TlObj.of("auth.signIn", "phone_number" to p.phone, "phone_code_hash" to p.phoneCodeHash, "phone_code" to c)) as TlObj
            if (r.type == "auth.authorizationSignUpRequired") throw TgError("auth_phone", "这个手机号还没有注册 Telegram。请先在手机上注册")
            return finish(p, r)
        } catch (e: Exception) {
            val k = TgSupport.classify(e, "login")
            if (k.kind == "auth_need_password") {
                val hint = runCatching { (p.client.call(TlObj.of("account.getPassword")) as TlObj).str("hint") ?: "" }.getOrDefault("")
                p.step = "password"
                log("需要两步验证密码")
                return Step("password", hint = hint)
            }
            log("验证码登录失败：${e.message}")
            throw k
        }
    }

    /** Step 3: the 2FA password (SRP). */
    fun password(pw: String): Step {
        val p = pending?.takeIf { it.step == "password" } ?: throw TgError("auth_state", "请先输入验证码")
        if (pw.isEmpty()) throw TgError("auth_password", "请输入两步验证密码")
        addSecret(pw)
        try {
            log("登录：提交两步验证密码")
            val info = p.client.call(TlObj.of("account.getPassword")) as TlObj
            val algo = info.obj("current_algo") ?: throw TgError("auth_password", "这个账号没有设置两步验证密码")
            if (algo.type != "passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow") throw TgError("other", "Telegram 用了拾影不认识的密码算法（${algo.type}）")
            val a = Crypto.srpCheck(algo.bytes("salt1")!!, algo.bytes("salt2")!!, algo.int("g")!!, algo.bytes("p")!!, info.bytes("srp_B")!!, info.long("srp_id")!!, pw)
            val r = p.client.call(TlObj.of("auth.checkPassword", "password" to TlObj.of("inputCheckPasswordSRP", "srp_id" to a.srpId, "A" to a.a, "M1" to a.m1))) as TlObj
            return finish(p, r)
        } catch (e: Exception) {
            log("两步验证失败：${e.message}")
            throw TgSupport.classify(e, "login")
        }
    }

    @Synchronized private fun finish(p: Pending, auth: TlObj?): Step {
        val user = auth?.obj("user") ?: throw TgError("other", "Telegram 没有返回账号信息")
        val ses = p.client.session
        ses.userId = user.long("id") ?: 0
        ses.authorized += ses.mainDc
        client?.takeIf { it !== p.client }?.close()
        saveSession(ses)
        setMe(user)
        client = p.client; checked = true
        pending = null
        log("登录成功")
        return Step("done", name = cfg.optString("name"), username = cfg.optString("username"), saved = store.available)
    }

    @Synchronized fun cancelLogin() {
        val p = pending; pending = null
        if (p != null && p.client !== client) p.client.close()
    }

    /** Ends the session on Telegram's side (best effort) and deletes it locally. api_id / api_hash / proxy stay. */
    fun logout(forgetApi: Boolean = false): Boolean {
        cancelLogin()
        var remote = false
        if (session() != null) {
            try {
                val c = withTimeout(20_000) { api() } as TgClient
                withTimeout(10_000) { c.call(TlObj.of("auth.logOut")) }
                remote = true
            } catch (e: Exception) { log("通知服务器退出失败（本地仍会删除会话）：${e.message}") }
        }
        dropClient()
        synchronized(this) {
            clearSession()
            cfg.put("name", ""); cfg.put("username", "")
            if (forgetApi) { cfg.remove("apiId"); cfg.remove("apiHash") }
            saveCfg()
        }
        log("已退出 Telegram 登录")
        return remote
    }

    private fun setProxyText(text: String) {
        val t = text.trim()
        if (t.isNotEmpty()) TgSupport.parseProxy(t)
        cfg.put("proxy", t)
    }

    /** Saves the proxy setting (empty = system / direct) and reconnects on next use. */
    fun setProxy(text: String) {
        try { setProxyText(text) } catch (e: IllegalArgumentException) { throw TgError("proxy", e.message ?: "代理格式不对") }
        saveCfg()
        dropClient()
    }

    /** Connection test without login (TCP + MTProto handshake on DC 2). → how it connected. */
    fun testConnection(proxyText: String? = null): String {
        if (proxyText != null) {
            try { setProxyText(proxyText) } catch (e: IllegalArgumentException) { throw TgError("proxy", e.message ?: "代理格式不对") }
            saveCfg()
        }
        val c = connectNew(TgSession(), cfg.optInt("apiId", 0).takeIf { it != 0 } ?: 1, cfg.optString("apiHash").ifEmpty { "0".repeat(32) })
        c.close()
        return via
    }

    companion object { const val CONNECT_TIMEOUT_MS = 25_000L }
}
