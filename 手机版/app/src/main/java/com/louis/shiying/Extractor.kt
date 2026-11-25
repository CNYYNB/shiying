package com.louis.shiying

import okhttp3.Request
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** Couldn't get the post from the share page; the WebView fallback should try. */
class NeedFallback(val id: String, val likelyImages: Boolean, val why: String, val filtered: PostUnavailable?) : Exception(why)

/** User-facing error with a ready Chinese message. */
class UserError(message: String) : Exception(message)

/**
 * Primary extraction: resolve the link → aweme id → iesdouyin share page (iPhone UA) → embedded _ROUTER_DATA.
 * Pure JVM code (OkHttp + org.json) so it can be exercised from unit tests against the live site.
 */
object Extractor {
    data class Target(val id: String, val likelyImages: Boolean)

    /** Telegram account hook (set by App): logged in → MTProto resolve; otherwise public posts go to yt-dlp. */
    interface Telegram {
        fun loggedIn(): Boolean
        fun resolve(link: TgLink, log: (String) -> Unit): Post
    }
    @Volatile var telegram: Telegram? = null

    /** What the router decided for a pasted text. */
    sealed class Route {
        class Native(val post: Post) : Route()
        /** Hand [url] to yt-dlp. */
        class Ytdlp(val url: String, val platform: Platform) : Route()
    }

    /**
     * Platform-aware first step (pure JVM): native parsers for 抖音 / 快手 / 小红书, everything else → yt-dlp
     * (after expanding short links that yt-dlp can't follow itself). Douyin keeps throwing [NeedFallback] for the WebView path.
     */
    fun route(text: String, log: (String) -> Unit = {}): Route {
        val platform = Links.detect(text) ?: throw UserError("没有找到链接。请在 App 里点「分享 → 复制链接」，再粘贴到这里")
        return when (platform) {
            Platform.DOUYIN -> Route.Native(fromSharePage(resolve(text, log), log))
            Platform.KUAISHOU -> Route.Native(Kuaishou.parse(text, log))
            Platform.TELEGRAM -> {
                val link = try { TgSupport.parseLink(Links.findUrl(text)) } catch (e: TgLinkError) { throw UserError(e.message ?: TgSupport.MSG_BAD) }
                val tg = telegram
                if (tg != null && tg.loggedIn()) Route.Native(tg.resolve(link, log))
                else if (!link.publicFallback) throw UserError(TgSupport.NEED_LOGIN)
                else { log("没有登录 Telegram，用解析引擎试公开频道…"); Route.Ytdlp(link.fallbackUrl, platform) }
            }
            Platform.XIAOHONGSHU -> try { Route.Native(Xhs.parse(text, log)) } catch (e: Xhs.XhsNoData) {
                log("页面没有笔记数据，改用解析引擎…")
                Route.Ytdlp(e.url, platform)
            }
            else -> {
                var url = Links.findUrl(text)!!
                if (YtdlpSupport.needsExpand(url)) {
                    log("正在解析短链接…")
                    url = Resolve.follow(url, Net.UA_DESKTOP) { Platform.ofUrl(it) != Platform.OTHER && !YtdlpSupport.needsExpand(it) }
                }
                if (Regex("""b23\.tv/.+""").containsMatchIn(url) || url.contains("bilibili.com/404")) throw UserError("B站短链接已失效（b23.tv 短链一般一年后过期），请重新复制分享链接")
                val p = Platform.ofUrl(url).let { if (it == Platform.OTHER) platform else it }
                Route.Ytdlp(YtdlpSupport.normalizeUrl(url), p)
            }
        }
    }

    /** Turn whatever the user pasted into an aweme id (following short-link redirects when needed). */
    fun resolve(text: String, log: (String) -> Unit = {}): Target {
        Links.bareId(text)?.let { return Target(it, false) }
        val url = Links.findUrl(text)?.takeIf { Links.isDouyin(it) } ?: Links.findUrl(text) ?: throw UserError("没有找到链接。请在抖音里点「分享 → 复制链接」，再粘贴到这里")
        if (!Links.isDouyin(url)) throw UserError("这不是抖音链接：${Links.host(url)}")
        Links.idFromUrl(url)?.let { return Target(it, isImageUrl(url)) }
        log("正在解析短链接…")
        var cur = url
        var lastErr: Exception? = null
        for (attempt in 0 until 3) {
            try {
                cur = url
                for (hop in 0 until 10) {
                    val req = Request.Builder().url(cur).header("User-Agent", Net.UA_IPHONE)
                        .header("Accept-Language", "zh-CN,zh;q=0.9").get().build()
                    Net.noRedirect.newCall(req).execute().use { r ->
                        val loc = r.header("Location")
                        if (r.isRedirect && loc != null) {
                            cur = r.request.url.resolve(loc)?.toString() ?: loc
                            Links.idFromUrl(cur)?.let { return Target(it, isImageUrl(cur)) }
                        } else {
                            if (r.code == 404 || r.code >= 500) throw UserError("短链接无效或已过期（HTTP ${r.code}），请重新复制分享链接")
                            val body = r.body?.string().orEmpty()
                            Regex("""(?:/video/|/note/|/slides/|aweme_id=|"aweme_id":")(\d{15,21})""").find(body)?.let {
                                return Target(it.groupValues[1], body.contains("/note/") || body.contains("/slides/"))
                            }
                            throw UserError("短链接没有指向抖音作品（可能是主页、直播或合集链接）")
                        }
                    }
                }
                throw UserError("短链接跳转次数过多")
            } catch (e: UserError) { throw e } catch (e: IOException) {
                lastErr = e; Thread.sleep(600L * (attempt + 1))
            }
        }
        throw UserError(netMessage(lastErr))
    }

    private fun isImageUrl(u: String) = u.contains("/note/") || u.contains("/slides/") || u.contains("/gallery/")

    /**
     * Fetch the post from the share page. Throws [PostUnavailable] (final, clear message), [NeedFallback]
     * (try the WebView), or [UserError] (network).
     */
    fun fromSharePage(t: Target, log: (String) -> Unit = {}): Post {
        val kinds = if (t.likelyImages) listOf("note", "video") else listOf("video", "note")
        var lastWhy = ""
        var filtered: PostUnavailable? = null
        var netErr: Exception? = null
        // The first hit without a ttwid cookie often returns a page shell with no item data; the response
        // sets the cookie, so a quick retry usually succeeds.
        for (attempt in 0 until 3) {
            for (kind in kinds) {
                log(if (attempt == 0) "正在读取作品信息…" else "正在重试（${attempt + 1}/3）…")
                val html = try { getText("https://www.iesdouyin.com/share/$kind/${t.id}/") } catch (e: IOException) {
                    netErr = e; lastWhy = netMessage(e); continue
                }
                when (val s = Parser.parseSharePage(html)) {
                    is Parser.Share.Item -> {
                        val p = Parser.fromItem(s.item, "分享页")
                        if (p.isImages || p.videoUrls.isNotEmpty()) return p
                        lastWhy = "作品数据里没有视频地址"
                    }
                    is Parser.Share.Filtered -> {
                        val u = Parser.unavailable(s.reason, s.notice, s.detail)
                        if (u.final) throw u
                        filtered = u; lastWhy = u.message ?: s.reason
                    }
                    is Parser.Share.NoData -> lastWhy = s.why
                }
            }
            if (filtered != null) break
            Thread.sleep(500L * (attempt + 1))
        }
        if (netErr != null && lastWhy == netMessage(netErr)) throw UserError(lastWhy)
        throw NeedFallback(t.id, t.likelyImages, lastWhy, filtered)
    }

    fun getText(url: String, ua: String = Net.UA_IPHONE, referer: String? = null): String {
        val b = Request.Builder().url(url).header("User-Agent", ua).header("Accept-Language", "zh-CN,zh;q=0.9")
            .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        if (referer != null) b.header("Referer", referer)
        Net.api.newCall(b.get().build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            return r.body?.string().orEmpty()
        }
    }

    fun netMessage(e: Throwable?): String = when (e) {
        null -> "网络错误"
        is UnknownHostException -> "无法连接网络（域名解析失败），请检查网络"
        is SocketTimeoutException -> "网络超时，请稍后重试"
        is javax.net.ssl.SSLException -> "安全连接失败，可能是网络或代理拦截"
        is java.io.InterruptedIOException -> "网络超时，请稍后重试"
        else -> "网络错误：${e.message?.take(60) ?: e.javaClass.simpleName}"
    }
}
