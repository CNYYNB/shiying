package com.louis.shiying

import com.louis.shiying.mtproto.ProxyFailure
import com.louis.shiying.mtproto.RpcError
import com.louis.shiying.mtproto.TgProxy
import com.louis.shiying.mtproto.TlObj
import java.io.IOException
import java.net.URLDecoder

/** A parsed Telegram message link. kind = "username" (public @name) or "channel" (t.me/c/<id>, channelId without -100). */
data class TgLink(
    val kind: String,
    val username: String? = null,
    val channelId: String? = null,
    val msgId: Int,
    val topicId: Int? = null,
    val threadId: Int? = null,
    val commentId: Int? = null,
    val single: Boolean = false,
) {
    /** Canonical https://t.me/… link. */
    val url: String get() {
        val q = mutableListOf<String>()
        if (single) q += "single"
        commentId?.let { q += "comment=$it" }
        threadId?.let { q += "thread=$it" }
        val path = if (kind == "channel") "c/$channelId" else username
        return "https://t.me/$path/${topicId?.let { "$it/" } ?: ""}$msgId${if (q.isNotEmpty()) "?" + q.joinToString("&") else ""}"
    }
    /** Without login only public channel posts can go to yt-dlp. */
    val publicFallback: Boolean get() = kind == "username" && commentId == null
    /** yt-dlp only understands t.me/<channel>/<id>. */
    val fallbackUrl: String get() = "https://t.me/$username/$msgId${if (single) "?single" else ""}"
}

class TgLinkError(val reason: String, message: String) : Exception(message)

/** Telegram error turned into a Chinese message. kind: protected / flood / no_access / deleted / not_found / invalid / net / auth_* / session / retry / no_media / other. */
class TgError(val kind: String, message: String) : Exception(message)

/** One file to download from one message. alt = index in alt_documents (-1 = the main document / photo). */
data class TgItem(
    val msgId: Int, val kind: String, val alt: Int, val size: Long, val ext: String, val w: Int, val h: Int, val duration: Double, val mime: String,
) {
    val isVideo get() = kind == "video" || kind == "gif"
}

/** Pure Telegram helpers (link parsing, proxy parsing, error mapping, media picking, log redaction). JVM-testable; same behaviour and wording as the PC version. */
object TgSupport {
    val HOSTS = listOf("t.me", "telegram.me", "telegram.dog")
    private val USERNAME = Regex("^[A-Za-z][A-Za-z0-9_]{2,31}$")
    private val RESERVED = setOf("addstickers", "addemoji", "addtheme", "share", "proxy", "socks", "setlanguage", "iv", "login", "bg",
        "confirmphone", "invoice", "joinchat", "contact", "boost", "giftcode", "addlist", "m", "a", "k", "z", "web", "stickers", "emoji", "auth", "nft", "premium_offer")

    const val MSG_INVITE = "这是 Telegram 的邀请链接，不是某条消息的链接。请先用这个链接在 Telegram 里加入，再在要下载的消息上长按 →「复制消息链接」"
    const val MSG_NO_MESSAGE = "这是频道 / 用户主页的链接，不是某条消息的链接。请在要下载的消息上长按 →「复制消息链接」"
    const val MSG_NOT_MESSAGE = "这不是 Telegram 消息链接。请在要下载的消息上长按 →「复制消息链接」"
    const val MSG_BAD = "Telegram 链接格式不对。请在要下载的消息上长按 →「复制消息链接」后重新粘贴"
    const val PROTECTED_MSG = "该频道/聊天禁止保存内容，拾影不下载这类内容"
    const val NEED_LOGIN = "这是私密频道 / 群组（或评论区）的消息链接，需要先登录 Telegram：点右上角「登录」→「Telegram 账号登录」"
    const val LOGIN_HINT = "\n\n登录 Telegram 后拾影可以直接下载（右上角「登录」→「Telegram 账号登录」）"
    const val NET_HINT = "请检查网络。在国内需要代理：打开「登录 → Telegram 账号登录」，在「代理」里填 SOCKS5（如 socks5://127.0.0.1:7890，Clash / v2rayN 的 SOCKS 或混合端口）或 MTProxy 链接，再试"

    fun isTgHost(h: String?): Boolean {
        val x = (h ?: "").lowercase().removePrefix("www.")
        return x in HOSTS || HOSTS.any { x.endsWith(".$it") }
    }

    private fun posInt(s: String?): Int? = s?.takeIf { Regex("^\\d{1,9}$").matches(it) }?.toIntOrNull()?.takeIf { it > 0 }

    private class Url(val host: String, val path: String, val query: Map<String, String?>)

    private fun splitUrl(raw: String): Url? {
        val m = Regex("""^[a-z][a-z0-9+.-]*://([^/?#]*)([^?#]*)(?:\?([^#]*))?""", RegexOption.IGNORE_CASE).find(raw) ?: return null
        var host = m.groupValues[1].substringAfterLast('@').lowercase()
        if (host.contains(':') && !host.startsWith("[")) host = host.substringBefore(':')
        val q = LinkedHashMap<String, String?>()
        m.groupValues[3].split('&').filter { it.isNotEmpty() }.forEach {
            val i = it.indexOf('=')
            val k = dec(if (i >= 0) it.substring(0, i) else it)
            if (!q.containsKey(k)) q[k] = if (i >= 0) dec(it.substring(i + 1)) else ""
        }
        return Url(host, m.groupValues[2], q)
    }

    private fun dec(s: String): String = try { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (e: Exception) { s }

    /** Parses a Telegram message link; throws [TgLinkError] with a Chinese message when it is not one. */
    fun parseLink(input: String?): TgLink {
        var raw = (input ?: "").trim()
        if (raw.isEmpty()) throw TgLinkError("bad", MSG_BAD)
        if (raw.startsWith("tg://", ignoreCase = true)) return parseTgScheme(raw)
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(raw)) raw = "https://$raw"
        val u = splitUrl(raw) ?: throw TgLinkError("bad", MSG_BAD)
        val host = u.host.removePrefix("www.")
        if (!isTgHost(host)) throw TgLinkError("not_message", MSG_NOT_MESSAGE)
        var parts = u.path.split('/').filter { it.isNotEmpty() }.map { dec(it) }
        val sub = HOSTS.firstNotNullOfOrNull { d -> if (host.endsWith(".$d")) host.dropLast(d.length + 1) else null }
        if (sub != null) parts = listOf(sub) + parts
        if (parts.isEmpty()) throw TgLinkError("not_message", MSG_NOT_MESSAGE)
        val first = parts[0]
        if (first.startsWith("+") || first.equals("joinchat", true)) throw TgLinkError("invite", MSG_INVITE)
        if (first.equals("proxy", true) || first.equals("socks", true)) throw TgLinkError("not_message", "这是 Telegram 代理链接。请把它填到「登录 → Telegram 账号登录 → 代理」里，不是在这里解析")
        if (first.equals("s", true)) parts = parts.drop(1)
        if (parts.isEmpty()) throw TgLinkError("not_message", MSG_NOT_MESSAGE)
        val single = u.query.containsKey("single")
        val commentId = posInt(u.query["comment"])
        val threadId = posInt(u.query["thread"])
        if (parts[0].equals("c", true)) {
            val ch = parts.getOrNull(1)?.takeIf { Regex("^\\d{1,16}$").matches(it) }?.trimStart('0')?.ifEmpty { null } ?: throw TgLinkError("bad", MSG_BAD)
            val nums = parts.drop(2).map { posInt(it) }
            if (nums.isEmpty()) throw TgLinkError("no_message", MSG_NO_MESSAGE)
            if (nums.any { it == null } || nums.size > 2) throw TgLinkError("bad", MSG_BAD)
            return TgLink("channel", channelId = ch, msgId = nums.last()!!, topicId = if (nums.size == 2) nums[0] else null,
                threadId = threadId, commentId = commentId, single = single)
        }
        val name = parts[0]
        if (name.lowercase() in RESERVED) throw TgLinkError("not_message", MSG_NOT_MESSAGE)
        if (!USERNAME.matches(name)) throw TgLinkError("bad", MSG_BAD)
        val nums = parts.drop(1).map { posInt(it) }
        if (nums.isEmpty()) throw TgLinkError("no_message", MSG_NO_MESSAGE)
        if (nums.any { it == null } || nums.size > 2) throw TgLinkError("bad", MSG_BAD)
        return TgLink("username", username = name, msgId = nums.last()!!, topicId = if (nums.size == 2) nums[0] else null,
            threadId = threadId, commentId = commentId, single = single)
    }

    private fun parseTgScheme(raw: String): TgLink {
        val u = splitUrl(raw.replaceFirst(Regex("^tg://", RegexOption.IGNORE_CASE), "https://tg.invalid/")) ?: throw TgLinkError("bad", MSG_BAD)
        val what = u.path.trimStart('/').lowercase()
        val single = u.query.containsKey("single")
        val commentId = posInt(u.query["comment"]); val threadId = posInt(u.query["thread"])
        val msgId = posInt(u.query["post"])
        when (what) {
            "resolve" -> {
                val name = u.query["domain"] ?: ""
                if (!USERNAME.matches(name)) throw TgLinkError("bad", MSG_BAD)
                if (msgId == null) throw TgLinkError("no_message", MSG_NO_MESSAGE)
                return TgLink("username", username = name, msgId = msgId, threadId = threadId, commentId = commentId, single = single)
            }
            "privatepost" -> {
                val ch = u.query["channel"] ?: ""
                if (!Regex("^\\d{1,16}$").matches(ch)) throw TgLinkError("bad", MSG_BAD)
                if (msgId == null) throw TgLinkError("no_message", MSG_NO_MESSAGE)
                return TgLink("channel", channelId = ch.trimStart('0'), msgId = msgId, threadId = threadId, commentId = commentId, single = single)
            }
            "join" -> throw TgLinkError("invite", MSG_INVITE)
        }
        throw TgLinkError("not_message", MSG_NOT_MESSAGE)
    }

    /** tg://resolve?… / tg://privatepost?… in the text → https://t.me/… (so platform detection sees it). */
    fun tgSchemeToHttps(text: String?): String? {
        val m = Regex("""tg://(resolve|privatepost)\?[A-Za-z0-9_=&%.-]+""", RegexOption.IGNORE_CASE).find(text ?: "") ?: return null
        return try { parseLink(m.value).url } catch (e: TgLinkError) { null }
    }

    // ------------------------------------------------------------------ proxy

    /**
     * Proxy setting text → [TgProxy]. socks5://[user:pass@]host:port, host:port (SOCKS5), tg://socks?… / t.me/socks?…,
     * tg://proxy?server=…&port=…&secret=… / t.me/proxy?… (MTProxy; plain / dd secrets only). Empty → null. Bad → IllegalArgumentException (Chinese).
     */
    fun parseProxy(text: String?): TgProxy? {
        val s = (text ?: "").trim()
        if (s.isEmpty()) return null
        if (Regex("""^(tg://|https?://(www\.)?(t\.me|telegram\.me)/)(proxy|socks)\?""", RegexOption.IGNORE_CASE).containsMatchIn(s)) {
            val u = splitUrl(s.replaceFirst(Regex("^tg://", RegexOption.IGNORE_CASE), "https://tg.invalid/"))!!
            val kind = u.path.trimStart('/').lowercase()
            val ip = u.query["server"]; val port = u.query["port"]?.toIntOrNull() ?: 0
            if (ip.isNullOrEmpty() || port !in 1..65535) throw IllegalArgumentException("代理链接里缺少服务器或端口")
            if (kind == "socks") return TgProxy.Socks5(ip, port, u.query["user"]?.ifEmpty { null }, u.query["pass"]?.ifEmpty { null })
            return TgProxy.MtProxy(ip, port, mtSecret(u.query["secret"]))
        }
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) throw IllegalArgumentException("Telegram 不支持 HTTP 代理，请填 SOCKS5 代理（Clash / v2rayN 的 SOCKS 或「混合」端口，例如 socks5://127.0.0.1:7890）或 MTProxy 链接")
        var rest = s
        val m = Regex("^(socks5h?|socks)://", RegexOption.IGNORE_CASE).find(s)
        if (m != null) rest = s.substring(m.value.length)
        else if (Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(s)) throw IllegalArgumentException("只支持 socks5:// 开头的代理或 MTProxy 链接")
        var user: String? = null; var pass: String? = null
        val at = rest.lastIndexOf('@')
        if (at >= 0) {
            val cred = rest.substring(0, at); rest = rest.substring(at + 1)
            val c = cred.indexOf(':')
            user = dec(if (c >= 0) cred.substring(0, c) else cred)
            pass = if (c >= 0) dec(cred.substring(c + 1)) else null
        }
        rest = rest.trimEnd('/')
        val hp = Regex("""^\[?([^\]\s]+?)\]?:(\d{1,5})$""").find(rest)
        val port = hp?.groupValues?.get(2)?.toIntOrNull() ?: 0
        if (hp == null || port !in 1..65535) throw IllegalArgumentException("代理格式不对，应该像 socks5://127.0.0.1:7890")
        return TgProxy.Socks5(hp.groupValues[1], port, user, pass)
    }

    private fun mtSecret(sec: String?): ByteArray {
        var s = (sec ?: "").trim()
        if (s.isEmpty()) throw IllegalArgumentException("MTProxy 链接里缺少 secret")
        if (!Regex("^[0-9a-fA-F]+$").matches(s)) {
            s = try { b64(s).joinToString("") { "%02x".format(it.toInt() and 0xff) } } catch (e: Exception) { throw IllegalArgumentException("MTProxy 的 secret 格式不对") }
        }
        s = s.lowercase()
        if (s.startsWith("ee")) throw IllegalArgumentException("这个 MTProxy 是 FakeTLS（secret 以 ee 开头），拾影不支持。请换普通 / dd 开头的 MTProxy，或用 SOCKS5 代理")
        if (!(s.length == 32 || (s.length == 34 && s.startsWith("dd")))) throw IllegalArgumentException("MTProxy 的 secret 应该是 32 位十六进制（或 dd 开头 34 位）")
        return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** Minimal base64 / base64url decoder (java.util.Base64 needs API 26). */
    private fun b64(s: String): ByteArray {
        val a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val t = s.replace('-', '+').replace('_', '/').trimEnd('=')
        val out = java.io.ByteArrayOutputStream(); var buf = 0; var bits = 0
        for (ch in t) {
            val v = a.indexOf(ch); if (v < 0) throw IllegalArgumentException("base64")
            buf = (buf shl 6) or v; bits += 6
            if (bits >= 8) { bits -= 8; out.write((buf shr bits) and 0xff) }
        }
        return out.toByteArray()
    }

    fun describeProxy(p: TgProxy?): String = when (p) {
        null -> "直连"
        is TgProxy.MtProxy -> "MTProxy ${p.host}:${p.port}"
        is TgProxy.Socks5 -> "SOCKS5 ${p.host}:${p.port}${if (!p.user.isNullOrEmpty()) "（带用户名）" else ""}"
    }

    // ------------------------------------------------------------------ errors

    fun fmtWait(s: Int): String = when {
        s < 60 -> "$s 秒"
        s < 3600 -> "${(s + 59) / 60} 分钟"
        else -> "%.1f 小时".format(s / 3600.0)
    }

    /** Error → TgError(kind, Chinese message). stage: "login" | "parse" | "download". */
    fun classify(e: Throwable?, stage: String = "parse"): TgError {
        if (e is TgError) return e
        if (e is TgLinkError) return TgError("invalid", e.message ?: MSG_BAD)
        val name = (e as? RpcError)?.error ?: Regex("""\b([A-Z][A-Z0-9_]{4,})\b""").find(e?.message ?: "")?.groupValues?.get(1) ?: ""
        val text = e?.message ?: e?.toString() ?: ""
        val n = name.uppercase()
        val seconds = (e as? RpcError)?.waitSeconds ?: Regex("""(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|TAKEOUT_INIT_DELAY)_(\d+)""").find(text)?.groupValues?.get(1)?.toIntOrNull()
        fun k(kind: String, msg: String) = TgError(kind, msg)
        if (seconds != null && Regex("FLOOD|SLOWMODE|TAKEOUT").containsMatchIn(n + text)) return k("flood", "请求太频繁，Telegram 要求等待 $seconds 秒（约 ${fmtWait(seconds)}）后再试")
        if (Regex("CHAT_FORWARDS_RESTRICTED|NOFORWARDS|FORWARDS_RESTRICTED").containsMatchIn(n)) return k("protected", PROTECTED_MSG)
        if (n in setOf("CHANNEL_PRIVATE", "CHANNEL_INVALID", "CHAT_ADMIN_REQUIRED", "USER_NOT_PARTICIPANT", "CHAT_RESTRICTED", "USER_BANNED_IN_CHANNEL",
                "CHANNEL_PUBLIC_GROUP_NA", "PEER_ID_INVALID", "CHAT_ID_INVALID", "INVITE_HASH_EXPIRED"))
            return k("no_access", "没有权限看这条消息：你的账号不在这个频道 / 群组里，或已被移出 / 封禁。请先用这个账号在 Telegram 里加入，再复制消息链接")
        if (n == "USERNAME_NOT_OCCUPIED" || n == "USERNAME_INVALID") return k("not_found", "链接里的频道 / 用户不存在（可能改了用户名或已被删除），请重新复制消息链接")
        if (n in setOf("MSG_ID_INVALID", "MESSAGE_ID_INVALID", "MESSAGE_IDS_EMPTY")) return k("deleted", "这条消息不存在或已被删除")
        if (n == "FILE_REFERENCE_EXPIRED" || n == "FILE_REFERENCE_INVALID") return k("retry", "文件地址过期了，请重新解析这条链接再下载")
        if (n == "API_ID_INVALID" || n == "API_ID_PUBLISHED_FLOOD") return k("auth_api", "api_id 或 api_hash 不对（或这个 api_id 被 Telegram 限制了）。请到 my.telegram.org → API development tools 重新复制")
        if (n == "PHONE_NUMBER_INVALID") return k("auth_phone", "手机号格式不对。请带国家区号，例如 +8613800138000")
        if (n == "PHONE_NUMBER_BANNED") return k("auth_phone", "这个手机号被 Telegram 封禁了")
        if (n == "PHONE_NUMBER_UNOCCUPIED") return k("auth_phone", "这个手机号还没有注册 Telegram。请先在手机上注册")
        if (n == "PHONE_NUMBER_FLOOD" || n == "PHONE_PASSWORD_FLOOD") return k("flood", "尝试次数太多，Telegram 暂时不让登录，请过几个小时再试")
        if (n == "PHONE_CODE_INVALID") return k("auth_code", "验证码不对，请再看一下 Telegram 发来的验证码")
        if (n == "PHONE_CODE_EXPIRED") return k("auth_code_expired", "验证码过期了，请点「重新发送验证码」")
        if (n == "PHONE_CODE_EMPTY") return k("auth_code", "请输入验证码")
        if (n == "PASSWORD_HASH_INVALID") return k("auth_password", "两步验证密码不对")
        if (n in setOf("AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "AUTH_KEY_DUPLICATED"))
            return k("session", "Telegram 登录已失效（可能在其他设备上退出了这个会话），请重新登录")
        if (n == "SESSION_PASSWORD_NEEDED") return k("auth_need_password", "这个账号开了两步验证，请输入两步验证密码")
        if (e is ProxyFailure) return k("net", "${e.message}。$NET_HINT")
        if (e is IOException || Regex("ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|Connection|connect|Socket|socks|unreachable|Network|网络|连接|代理", RegexOption.IGNORE_CASE).containsMatchIn(text))
            return k("net", (if (stage == "login") "连不上 Telegram 服务器，无法登录。" else "连不上 Telegram 服务器。") + NET_HINT)
        return k("other", "Telegram 出错了：" + (n.ifEmpty { text }).take(160))
    }

    // ------------------------------------------------------------------ media

    private val MIME_EXT = mapOf(
        "video/mp4" to ".mp4", "video/quicktime" to ".mov", "video/webm" to ".webm", "video/x-matroska" to ".mkv", "video/x-msvideo" to ".avi",
        "video/3gpp" to ".3gp", "video/mpeg" to ".mpg", "image/jpeg" to ".jpg", "image/jpg" to ".jpg", "image/png" to ".png", "image/webp" to ".webp",
        "image/gif" to ".gif", "image/heic" to ".heic", "image/avif" to ".avif", "image/bmp" to ".bmp",
    )

    fun attr(doc: TlObj?, type: String): TlObj? = doc?.objs("attributes")?.firstOrNull { it.type == type }

    fun extFor(doc: TlObj?, fallback: String): String {
        val mime = doc?.str("mime_type")?.lowercase() ?: ""
        MIME_EXT[mime]?.let { return it }
        val fn = attr(doc, "documentAttributeFilename")?.str("file_name") ?: ""
        return Regex("""\.([A-Za-z0-9]{2,5})$""").find(fn)?.let { "." + it.groupValues[1].lowercase() } ?: fallback
    }

    fun isVideoDoc(d: TlObj?): Boolean {
        if (d == null || d.type != "document" || attr(d, "documentAttributeSticker") != null) return false
        return (d.str("mime_type") ?: "").lowercase().startsWith("video/") || attr(d, "documentAttributeVideo") != null
    }

    fun isImageDoc(d: TlObj?): Boolean {
        if (d == null || d.type != "document" || attr(d, "documentAttributeSticker") != null) return false
        return (d.str("mime_type") ?: "").lowercase().startsWith("image/")
    }

    /** Largest photo size: (type, size, w, h). */
    fun bestPhotoSize(photo: TlObj?): Triple<String, Long, Pair<Int, Int>>? {
        var best: TlObj? = null; var bestArea = -1L; var bestSize = 0L
        for (s in photo?.objs("sizes") ?: emptyList()) {
            if (s.type != "photoSize" && s.type != "photoSizeProgressive") continue
            val area = (s.int("w") ?: 0).toLong() * (s.int("h") ?: 0)
            val sz = if (s.type == "photoSizeProgressive") s.list("sizes").mapNotNull { (it as? Number)?.toLong() }.maxOrNull() ?: 0 else (s.long("size") ?: 0)
            if (area > bestArea || (area == bestArea && sz > bestSize)) { best = s; bestArea = area; bestSize = sz }
        }
        val b = best ?: return null
        return Triple(b.str("type") ?: "y", bestSize, (b.int("w") ?: 0) to (b.int("h") ?: 0))
    }

    /** What to download from one message (at most one file: albums are several messages). Videos: the largest of the main file and alt_documents. */
    fun mediaItems(msg: TlObj?): List<TgItem> {
        val media = msg?.obj("media") ?: return emptyList()
        val msgId = msg.int("id") ?: 0
        if (media.type == "messageMediaPhoto") {
            val photo = media.obj("photo")?.takeIf { it.type == "photo" } ?: return emptyList()
            val (_, size, wh) = bestPhotoSize(photo) ?: return emptyList()
            return listOf(TgItem(msgId, "photo", -1, size, ".jpg", wh.first, wh.second, 0.0, "image/jpeg"))
        }
        if (media.type == "messageMediaDocument") {
            val main = media.obj("document")
            val cands = (listOf(-1 to main) + media.objs("alt_documents").mapIndexed { i, d -> i to d }).filter { isVideoDoc(it.second) }
            if (cands.isNotEmpty()) {
                val (alt, d) = cands.maxByOrNull { it.second?.long("size") ?: 0L }!!
                val va = attr(d, "documentAttributeVideo") ?: attr(main, "documentAttributeVideo")
                val gif = attr(d, "documentAttributeAnimated") != null || attr(main, "documentAttributeAnimated") != null
                return listOf(TgItem(msgId, if (gif) "gif" else "video", alt, d?.long("size") ?: 0, extFor(d, ".mp4"), va?.int("w") ?: 0, va?.int("h") ?: 0,
                    (va?.get("duration") as? Number)?.toDouble() ?: 0.0, d?.str("mime_type") ?: "video/mp4"))
            }
            if (isImageDoc(main)) {
                val ia = attr(main, "documentAttributeImageSize")
                return listOf(TgItem(msgId, "image", -1, main?.long("size") ?: 0, extFor(main, ".jpg"), ia?.int("w") ?: 0, ia?.int("h") ?: 0, 0.0, main?.str("mime_type") ?: "image/jpeg"))
            }
        }
        return emptyList()
    }

    fun noMediaReason(msg: TlObj?): String {
        val m = msg?.obj("media") ?: return "这条消息里没有视频或图片（只有文字）"
        return when (m.type) {
            "messageMediaPaidMedia" -> "这是付费内容，拾影不下载"
            "messageMediaWebPage" -> "这条消息只有网页预览，没有 Telegram 里的视频或图片。可以复制里面的网页链接到拾影解析"
            "messageMediaDocument" -> {
                val d = m.obj("document")
                when {
                    attr(d, "documentAttributeSticker") != null -> "这是贴纸，拾影不下载"
                    attr(d, "documentAttributeAudio") != null -> "这是音频 / 语音，拾影只下载视频和图片"
                    else -> "这条消息是普通文件（不是视频或图片），请在 Telegram 里直接保存"
                }
            }
            else -> "这条消息里没有视频或图片"
        }
    }

    /** Messages of the same album (grouped_id), sorted by id. */
    fun albumOf(msg: TlObj, around: List<TlObj>): List<TlObj> {
        val g = msg.long("grouped_id") ?: return listOf(msg)
        val list = around.filter { it.type == "message" && it.long("grouped_id") == g }.toMutableList()
        if (list.none { it.int("id") == msg.int("id") }) list += msg
        return list.sortedBy { it.int("id") ?: 0 }
    }

    /** Ids around a message to look for the rest of its album (albums have at most 10 items). */
    fun albumWindow(msgId: Int): List<Int> = ((msgId - 9).coerceAtLeast(1)..(msgId + 9)).toList()

    /** noforwards on the message or the chat. */
    fun isProtected(msg: TlObj?, chat: TlObj?): Boolean = msg?.flag("noforwards") == true || chat?.flag("noforwards") == true

    // ------------------------------------------------------------------ redact

    /** Hides session data, api_hash, phone numbers, codes and passwords in diagnostic text. [secrets] = known sensitive values. */
    fun redact(text: String?, secrets: Collection<String> = emptyList()): String {
        var s = text ?: ""
        for (v in secrets.filter { it.length >= 3 }.sortedByDescending { it.length }) {
            s = s.replace(v, "<已隐藏>")
            val digits = v.filter { it.isDigit() }
            if (digits.length >= 7 && digits != v) s = s.replace(digits, "<已隐藏>")
        }
        s = s.replace(Regex("""\b1?[A-Za-z0-9+/_-]{120,}={0,2}"""), "<已隐藏 session>")
        s = s.replace(Regex("""\b[0-9a-fA-F]{32}\b"""), "<已隐藏 api_hash>")
        s = s.replace(Regex("""(api_?hash|apiHash|session|password|phone_?code|phoneCode|code|phone(?:_?number)?|phoneNumber)(["']?\s*[:=]\s*["']?)[^"',\s}]+""", RegexOption.IGNORE_CASE)) { it.groupValues[1] + it.groupValues[2] + "<已隐藏>" }
        s = s.replace(Regex("""\+\d[\d\s-]{6,16}\d"""), "<已隐藏手机号>")
        s = s.replace(Regex("""(?<![\d.])\d{11,15}(?![\d.])"""), "<已隐藏手机号>")
        return s
    }

    // ------------------------------------------------------------------ login input

    /** Mainland numbers without +86 get it; spaces / dashes removed. */
    fun normalizePhone(s: String?): String {
        var p = (s ?: "").replace(Regex("""[\s\-()（）]"""), "")
        if (Regex("^1[3-9]\\d{9}$").matches(p)) p = "+86$p"
        if (Regex("^00\\d").containsMatchIn(p)) p = "+" + p.substring(2)
        if (!Regex("^\\+?\\d{6,16}$").matches(p)) throw TgError("auth_phone", "手机号格式不对。请带国家区号，例如 +8613800138000")
        return if (p.startsWith("+")) p else "+$p"
    }

    fun checkApi(apiId: String?, apiHash: String?): Pair<Int, String> {
        val id = (apiId ?: "").trim(); val hash = (apiHash ?: "").trim()
        if (!Regex("^\\d{3,10}$").matches(id) || id.toLongOrNull()?.let { it > Int.MAX_VALUE } != false) throw TgError("auth_api", "api_id 应该是一串数字（在 my.telegram.org 的 App api_id 那一行）")
        if (!Regex("^[0-9a-fA-F]{32}$").matches(hash)) throw TgError("auth_api", "api_hash 应该是 32 位字母和数字（在 my.telegram.org 的 App api_hash 那一行）")
        return id.toInt() to hash.lowercase()
    }
}
