package com.louis.shiying

import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure (JVM-testable) half of the yt-dlp integration: command-line options, info-JSON → [Post],
 * and yt-dlp error text → clear Chinese messages. The Android half (process, cookies, update) is [Engine].
 */
object YtdlpSupport {
    /** Quality modes: see [Quality] ("best", "1080" default, "720", "480", "360", "worst", or a concrete height). */
    fun sortArg(quality: String): String = Quality.sortArg(quality)

    /** Format selector. TikTok: never pick the watermarked "download" format. */
    fun formatArg(platform: Platform): String =
        if (platform == Platform.TIKTOK) "bv*[format_note!*=atermark]+ba/b[format_note!*=atermark]/bv*+ba/b"
        else "bv*+ba/b"

    private fun common(cookieFile: String?, verbose: Boolean = false): List<String> {
        val a = mutableListOf(
            if (verbose) "-v" else "--no-warnings", "--no-playlist", "--playlist-items", "1:30",
            "--socket-timeout", "20", "--retries", "3", "--extractor-retries", "2",
            "--no-mtime", "--no-colors",
        )
        if (cookieFile != null) a += listOf("--cookies", cookieFile)
        return a
    }

    /** Options for the parse step (stdout = one JSON document). The URL is added by the caller. */
    fun infoOptions(platform: Platform, quality: String, cookieFile: String?): List<String> =
        if (platform == Platform.YOUTUBE) youtubeInfoOptions(quality, cookieFile)
        else common(cookieFile) + listOf("-f", formatArg(platform), "-S", sortArg(quality), "--dump-single-json")

    /**
     * YouTube first attempt = what YTDLnis (works on the same phone) does by default: yt-dlp's own default player clients
     * (no --extractor-args), the library's QuickJS for the n/sig challenges, cookies only when the user is really logged in,
     * --no-check-certificates, and no --proxy (the VPN is transparent; the proxy is only used on a connection error).
     * -v keeps the full log for 「复制诊断日志」 (verbose does not change what yt-dlp requests).
     */
    fun youtubeInfoOptions(quality: String, cookieFile: String?): List<String> =
        common(cookieFile, verbose = true) + listOf("--no-check-certificates", "-f", formatArg(Platform.YOUTUBE), "-S", sortArg(quality), "--dump-single-json")

    /** Options for the download step, reusing the info JSON written at parse time. */
    fun downloadOptions(platform: Platform, quality: String, cookieFile: String?, infoJson: String, outDir: String): List<String> =
        common(cookieFile) + (if (platform == Platform.YOUTUBE) listOf("--no-check-certificates") else emptyList()) + listOf(
            "-f", formatArg(platform), "-S", sortArg(quality),
            "--load-info-json", infoJson,
            "-o", "$outDir/%(autonumber)03d-%(id).40B.%(ext)s",
            "--merge-output-format", "mp4",
            "--concurrent-fragments", "4",
            "--newline",
        )

    /** Rewrite links yt-dlp handles better in another form. */
    fun normalizeUrl(url: String): String {
        // 西瓜视频 videos are served by the 今日头条 extractor (same item id); ixigua pages need extra cookies.
        Regex("""ixigua\.com/(?:i|item/)?(\d{15,21})""").find(url)?.let { return "https://www.toutiao.com/video/${it.groupValues[1]}/" }
        Regex("""toutiao\.com/(?:a|i|group/|article/|w/)?(\d{15,21})""").find(url)?.let {
            if (!url.contains("/video/")) return "https://www.toutiao.com/video/${it.groupValues[1]}/"
        }
        // YouTube Shorts → watch (same extractor; avoids the shorts-tab page)
        Regex("""youtube\.com/shorts/([A-Za-z0-9_-]{6,})""").find(url)?.let { return "https://www.youtube.com/watch?v=${it.groupValues[1]}" }
        return url
    }

    /** True for short links that should be expanded before handing the link to yt-dlp. */
    fun needsExpand(url: String): Boolean {
        val h = Links.host(url)
        return h == "b23.tv" || h.endsWith(".b23.tv") || h.startsWith("bili2233.") || h.startsWith("bili22.") || h.startsWith("bili33.") ||
            h == "t.cn" || h == "v.ixigua.com" || h == "m.toutiao.com" && url.contains("/is/") || h == "vt.tiktok.com" || h == "vm.tiktok.com"
    }

    // ------------------------------------------------------------------------------------------ info JSON

    private fun bestHeight(o: JSONObject): Int {
        val rf = o.optJSONArray("requested_formats")
        var h = o.optInt("height", 0)
        if (rf != null) for (i in 0 until rf.length()) h = maxOf(h, rf.optJSONObject(i)?.optInt("height", 0) ?: 0)
        val w = o.optInt("width", 0)
        return if (w in 1 until h) w else h   // portrait video: report the short side ("1080p")
    }

    private fun hasMedia(o: JSONObject): Boolean =
        (o.optJSONArray("formats")?.length() ?: 0) > 0 || o.optString("url").startsWith("http") || o.optJSONArray("requested_formats") != null

    /** Build a [Post] from `--dump-single-json` output. Throws [UserError] for playlists with nothing downloadable. */
    fun parseInfo(json: String, platform: Platform, pageUrl: String, infoPath: String?): Post {
        val start = json.indexOf('{'); val end = json.lastIndexOf('}')
        if (start < 0 || end <= start) throw UserError("解析引擎没有返回作品信息")
        val o = try { JSONObject(json.substring(start, end + 1)) } catch (e: Exception) { throw UserError("解析引擎返回的信息无法读取") }
        val isList = o.optString("_type") == "playlist" || o.has("entries")
        val entries: List<JSONObject> = if (isList) {
            val a: JSONArray? = o.optJSONArray("entries")
            (0 until (a?.length() ?: 0)).mapNotNull { a?.optJSONObject(it) }.filter { hasMedia(it) }
        } else listOf(o)
        if (entries.isEmpty()) throw UserError("这条内容里没有可下载的视频（可能是纯图片、直播或需要登录）")
        val first = entries.first()
        fun str(vararg keys: String): String {
            for (k in keys) { val v = o.optString(k).ifEmpty { first.optString(k) }; if (v.isNotBlank() && v != "null") return v }
            return ""
        }
        var title = str("title", "fulltitle")
        val desc = str("description")
        // Many sites (TikTok, X, Instagram) put the caption in description and a generic text in title.
        if (desc.isNotBlank() && (title.isBlank() || title.startsWith("Video by") || title.startsWith("Post by") || title.matches(Regex("""(?i)tiktok video #\d+""")))) title = desc
        val author = str("uploader", "channel", "creator", "uploader_id", "artist")
        val dur = entries.sumOf { it.optDouble("duration", 0.0).takeIf { d -> !d.isNaN() } ?: 0.0 }
        val id = str("id", "display_id")
        val thumb = str("thumbnail").ifEmpty {
            first.optJSONArray("thumbnails")?.let { t -> (t.length() - 1 downTo 0).mapNotNull { t.optJSONObject(it)?.optString("url")?.takeIf { u -> u.startsWith("http") } }.firstOrNull() } ?: ""
        }
        return Post(
            id = id,
            isImages = false,
            desc = if (desc.isNotBlank() && desc != title) "$title\n$desc" else title,
            author = author,
            cover = thumb.ifBlank { null },
            durationMs = (dur * 1000).toLong(),
            videoUrls = emptyList(),
            images = emptyList(),
            source = "解析引擎",
            platform = platform,
            pageUrl = o.optString("webpage_url").ifBlank { pageUrl },
            engine = "ytdlp",
            infoJson = infoPath,
            entries = entries.size,
            height = entries.maxOf { bestHeight(it) },
        )
    }

    // ------------------------------------------------------------------------------------------ YouTube fallbacks

    /** Player clients that need no PO token (yt-dlp 2026.11: tv*, ios_producer, visionos) + web_embedded / android_vr. */
    const val YT_ALT_CLIENTS = "youtube:player_client=tv,tv_downgraded,ios_producer,visionos,web_embedded,android_vr"

    /** Clients used with an on-device PO token. */
    const val YT_POT_CLIENTS = "web_safari,mweb,web"

    /**
     * extractor-args for the PO token step. A logged-out GVS token is bound to visitor data, a logged-in one to the account's
     * data_sync_id (yt-dlp: never mix visitor_data with a login). [authenticated] = yt-dlp really saw account cookies.
     */
    fun ytPotArgs(pluginDir: String, tokenFile: String, visitorData: String?, authenticated: Boolean, dataSyncId: String? = null): List<String> {
        val yt = StringBuilder("youtube:player_client=$YT_POT_CLIENTS")
        if (!authenticated && !visitorData.isNullOrBlank()) yt.append(";visitor_data=").append(visitorData)
        if (authenticated && !dataSyncId.isNullOrBlank()) yt.append(";data_sync_id=").append(dataSyncId)
        return listOf("--plugin-dirs", pluginDir, "--extractor-args", "youtubepot-shiying:file=$tokenFile", "--extractor-args", yt.toString())
    }

    fun youtubeId(url: String): String? =
        Regex("""(?:youtu\.be/|[?&]v=|/shorts/|/live/|/embed/|/v/)([A-Za-z0-9_-]{11})""").find(url)?.groupValues?.get(1)

    /** ERROR / WARNING lines only: with -v the [debug] lines mention "PO Token", "cookies", "sign in"… and must not be classified. */
    fun problemLines(stderr: String): String =
        stderr.lineSequence().map { it.trim() }.filter { it.startsWith("ERROR") || it.startsWith("WARNING") }.joinToString("\n")
            .ifBlank { stderr.lineSequence().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("[") }.toList().takeLast(3).joinToString("\n") }

    private fun errorsOnly(stderr: String): String {
        val e = stderr.lineSequence().map { it.trim() }.filter { it.startsWith("ERROR") }.joinToString("\n")
        return e.ifBlank { problemLines(stderr) }
    }

    /** True when YouTube refused the request in a way another client / token / login might get around. */
    fun ytBlocked(stderr: String): Boolean {
        val all = problemLines(stderr).lowercase()
        val s = errorsOnly(stderr).lowercase()
        return (listOf("sign in to confirm", "not a bot", "failed to extract any player response", "http error 403", "http error 429",
            "too many requests", "requested format is not available", "only images are available",
            "unable to download api page").any { s.contains(it) } || jsProblem(stderr) && s.contains("format") ||
            // generic ERROR after the player API was refused (403 / 429 in the warnings)
            listOf("http error 403", "http error 429").any { all.contains(it) } && all.contains("unable to download api page")) &&
            !listOf("private video", "age-restricted", "confirm your age", "members-only", "join this channel", "has been removed",
                "account associated with this video has been terminated", "copyright").any { all.contains(it) }
    }

    /** yt-dlp could not solve YouTube's JS challenges (n / signature) → formats missing. Not an IP problem. */
    fun jsProblem(stderr: String): Boolean {
        val s = problemLines(stderr).lowercase()
        return listOf("n challenge solving failed", "signature solving failed", "no supported javascript runtime",
            "error running quickjs", "error running deno", "js challenge", "jsc", "nsig extraction failed", "signature extraction failed").any { s.contains(it) }
    }

    /** Network failure (connection, DNS, TLS) as opposed to YouTube refusing. */
    fun netProblem(stderr: String): Boolean {
        val s = errorsOnly(stderr).lowercase()
        return listOf("timed out", "connection refused", "connection reset", "network is unreachable", "name or service not known",
            "temporary failure in name resolution", "failed to resolve", "errno 7", "errno -2", "errno -3", "eof occurred", "ssl:",
            "unable to connect", "connectionerror", "remote end closed").any { s.contains(it) } && !s.contains("not a bot")
    }

    enum class YtAuth { NONE, OK, ROTATED }

    /** What yt-dlp itself concluded about the cookies (needs -v): "Found YouTube account cookies" / "...no longer valid". */
    fun ytAuth(stderr: String): YtAuth = when {
        stderr.contains("account cookies are no longer valid") -> YtAuth.ROTATED
        stderr.contains("Found YouTube account cookies") -> YtAuth.OK
        else -> YtAuth.NONE
    }

    /** Short Chinese reason for one failed YouTube attempt. */
    fun ytReason(stderr: String): String {
        val s = errorsOnly(stderr).lowercase()
        return when {
            s.contains("sign in to confirm") || s.contains("not a bot") -> "要求验证不是机器人"
            jsProblem(stderr) && (s.contains("format") || s.contains("only images")) -> "YouTube 签名 / n 参数解算失败（JS 引擎），拿不到视频流"
            s.contains("http error 429") || s.contains("too many requests") -> "请求过多被限流（429）"
            s.contains("http error 403") || s.contains("failed to extract any player response") -> "IP 被拒绝，拿不到播放信息（403）"
            s.contains("requested format is not available") || s.contains("only images") -> "没有拿到可下载的视频流"
            netProblem(stderr) -> "网络连接失败"
            else -> errorLine(stderr).take(60).ifBlank { "未知原因" }
        }
    }

    data class YtStep(val name: String, val result: String)

    /**
     * Final message after every YouTube fallback failed. [auth] = what yt-dlp reported about the cookies (not merely whether a
     * cookie file existed: anonymous WebView cookies are no login).
     */
    /** [deno]: true = Deno was used, false = supported but not installed (hint to install it), null = not applicable (32-bit). */
    fun youtubeSummary(steps: List<YtStep>, auth: YtAuth, js: Boolean = false, deno: Boolean? = null): String {
        val sb = StringBuilder("YouTube 解析失败，已自动尝试：\n")
        steps.forEachIndexed { i, st -> sb.append("${i + 1}. ${st.name}：${st.result}\n") }
        sb.append(when (auth) {
            YtAuth.OK -> "（已带上 YouTube 登录状态）\n"
            YtAuth.ROTATED -> "（YouTube 登录状态已失效：cookies 被浏览器轮换或已过期）\n"
            YtAuth.NONE -> "（未登录 YouTube）\n"
        })
        if (js) sb.append("解析引擎没能解开 YouTube 的签名校验：请点「⋮ → 更新解析引擎」后重试。\n")
        else sb.append("YouTube 拒绝了当前网络的请求。建议：\n• 换一个 VPN 节点后重试\n")
        sb.append(when (auth) {
            YtAuth.OK -> "• 也可以在「登录 → YouTube」重新登录"
            YtAuth.ROTATED -> "• 在「登录 → YouTube」重新登录，或用无痕窗口重新导出 cookies.txt（导出后关闭该窗口）"
            YtAuth.NONE -> "• 或在「登录 → YouTube」登录账号 / 导入 cookies.txt"
        })
        if (deno == false) sb.append("\n• 安装 Deno 引擎（⋮ →「安装 Deno 引擎」，与 YTDLnis 相同）后重试")
        sb.append("\n• 「⋮ → 复制诊断日志」可以复制完整日志")
        return sb.toString()
    }

    /** Removes cookie values, tokens, visitor / sync ids and long opaque strings from a yt-dlp log before it is copied. */
    fun redact(log: String): String {
        var s = log
        s = s.replace(Regex("""(visitor_data|data_sync_id|po_token|token|pot|sig|lsig|n|SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)=([^;&\s'",\]]+)""")) { m ->
            if (m.groupValues[2].length < 12) m.value else "${m.groupValues[1]}=<已隐藏>"
        }
        s = s.replace(Regex("""(Authorization|Cookie|X-Goog-Visitor-Id)(['"]?\s*[:=]\s*['"]?)[^'"\n]+""", RegexOption.IGNORE_CASE)) { m -> m.groupValues[1] + m.groupValues[2] + "<已隐藏>" }
        s = s.replace(Regex("""[A-Za-z0-9_\-%+/=.]{60,}""")) { m -> if (m.value.startsWith("http") || m.value.contains("/data/")) m.value else "<已隐藏 ${m.value.length} 字符>" }
        return s
    }

    // ------------------------------------------------------------------------------------------ errors

    /** Last "ERROR:" line of yt-dlp's stderr (without the "[extractor] id:" prefix). */
    fun errorLine(stderr: String): String {
        val line = stderr.lineSequence().map { it.trim() }.lastOrNull { it.startsWith("ERROR:") } ?: stderr.trim().lineSequence().lastOrNull().orEmpty()
        return line.removePrefix("ERROR:").trim().replace(Regex("""^\[[^\]]+\]\s*[^:]{1,60}:\s*"""), "")
            .substringBefore("; please report this issue").substringBefore(" See  https://").trim()
    }

    /** Map yt-dlp's error output to a clear Chinese message. */
    fun errorMessage(stderr: String, platform: Platform): String {
        val line = errorLine(stderr)
        val errs = stderr.lineSequence().filter { it.contains("ERROR") }.joinToString("\n")
        val s = (line + "\n" + errs.takeLast(1500)).lowercase()
        val name = if (platform == Platform.OTHER) "该网站" else platform.label
        fun has(vararg k: String) = k.any { s.contains(it) }
        val loginHint = if (platform.loginUrl != null) "请点右上角「登录」登录$name 后重试" else "该平台暂不支持在拾影里登录"
        return when {
            has("private video", "this video is private", "is private", "private account", "account is private", "protected tweet", "私密") ->
                "这是私密内容，无法下载（$name）"
            has("age-restricted", "age restricted", "confirm your age", "inappropriate for some users") ->
                "内容有年龄限制，需要登录才能下载。$loginHint"
            has("members-only", "members only", "join this channel", "premium", "requires payment", "purchase", "paid content", "rental",
                "大会员", "付费", "vip", "only available to subscribers", "subscriber-only", "ppv") ->
                "付费 / 会员专享内容，不支持下载"
            has("tls fingerprint", "impersonat") ->
                "$name 拦截了解析引擎的连接（TLS 指纹校验）。可以先点「⋮ → 更新解析引擎」，或登录$name 后再试；仍不行说明暂不支持"
            has("ip address is blocked", "your ip address", "ip is blocked") ->
                "$name 封锁了当前网络的 IP（常见于 VPN / 机房节点），请换一个网络或节点后重试"
            has("available in your country", "not available in your region", "geo restrict", "geo-restrict", "georestrict", "region",
                "blocked in your country", "in your location", "地区") ->
                "地区限制：该内容在当前网络所在地区不可用（可尝试更换网络 / VPN 节点）"
            has("http error 429", "too many requests", "rate-limit", "rate limit", "ratelimit", "http error 412", "precondition failed", "风控", "频繁") ->
                "请求太频繁，被 $name 限流 / 风控了，请稍后再试（登录后通常更稳定）"
            has("sign in to confirm you", "not a bot") ->
                "$name 要求验证「不是机器人」（当前网络 IP 被限制）。请换个网络 / 节点，或登录后再试"
            has("login required", "log in", "login to", "sign in", "logged-in", "logged in", "--cookies", "cookies", "authentication", "requires login", "need to log", "需要登录", "登录") ->
                "需要登录才能下载。$loginHint"
            has("unsupported url") ->
                "暂不支持这个链接（请使用单个作品 / 视频页面的分享链接）"
            has("video unavailable", "has been removed", "been deleted", "does not exist", "doesn't exist", "no longer available", "not found", "http error 404",
                "啥都木有", "不存在", "已删除", "this content isn't available", "content is not available", "post is unavailable", "status is unavailable") ->
                "内容不存在或已被删除"
            has("no video could be found", "no video formats", "no formats", "requested format is not available", "there's no video", "no media", "has no video") ->
                "这条内容里没有可下载的视频（可能是纯图片、直播或需要登录）"
            has("live event", "is live", "premieres in", "this live") ->
                "直播 / 首映内容不支持下载"
            has("timed out", "timeout", "connection reset", "connection refused", "network is unreachable", "name or service not known", "temporary failure in name resolution",
                "nodename nor servname", "failed to resolve", "errno 7", "errno -2", "errno -3", "eof occurred", "ssl") ->
                "网络错误，无法连接 $name（在国内访问海外平台需要开启 VPN）"
            has("failed to extract", "unable to extract", "please report this issue", "keyerror", "typeerror", "jsonerror", "unable to download api page", "http error 403", "forbidden") ->
                "解析失败：$name 可能改版了或拒绝了请求。请点「⋮ → 更新解析引擎」后重试${if (platform.loginUrl != null) "，或登录后再试" else ""}"
            line.isNotBlank() -> "解析失败：${line.take(140)}"
            else -> "解析失败（解析引擎没有返回原因）"
        }
    }
}
