package com.louis.shiying

import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * 快手: share link → mobile share page (v.m.chenzhongtech.com/fw/photo/{id}, iPhone UA) → window.INIT_STATE.
 * The state's top-level keys are obfuscated, but the values are plain JSON: the post is the object that holds
 * `photo.mainMvUrls` (clean mp4, no watermark) or an atlas (图集) list. Errors come as {"result":N,"error_msg":"…"}.
 * Pure JVM (OkHttp + org.json).
 */
object Kuaishou {
    private val ID_RE = Regex("""/(?:short-video|fw/photo|photo|fw/long-video|long-video)/([A-Za-z0-9_\-]{6,40})""")
    private val ID_PARAM_RE = Regex("""[?&](?:photoId|shareObjectId)=([A-Za-z0-9_\-]{6,40})""")
    private val STATE_RE = Regex("""window\.INIT_STATE\s*=\s*(\{.*?\})\s*</script>""", RegexOption.DOT_MATCHES_ALL)
    private const val REFERER = "https://v.m.chenzhongtech.com/"

    fun idFromUrl(url: String): String? = ID_RE.find(url)?.groupValues?.get(1) ?: ID_PARAM_RE.find(url)?.groupValues?.get(1)

    sealed class Page {
        class Ok(val post: Post) : Page()
        class Error(val code: Int, val msg: String) : Page()
        class NoData(val why: String) : Page()
    }

    fun parse(text: String, log: (String) -> Unit = {}): Post {
        val url = Links.findUrl(text) ?: throw UserError("没有找到快手链接")
        var target = url
        var id = idFromUrl(url)
        if (id == null) {
            log("正在解析快手短链接…")
            target = Resolve.follow(url, Net.UA_IPHONE) { idFromUrl(it) != null }
            id = idFromUrl(target) ?: throw UserError("快手短链接没有指向作品（可能是主页、直播或已失效），请重新复制分享链接")
        }
        val pages = LinkedHashSet<String>()
        if (target.contains("/fw/photo/")) pages += target
        pages += "https://v.m.chenzhongtech.com/fw/photo/$id"
        var why = "页面中没有作品数据"
        var netErr: IOException? = null
        for (attempt in 0 until 2) for (pageUrl in pages) {
            log(if (attempt == 0) "正在读取快手作品…" else "正在重试…")
            val html = try { Extractor.getText(pageUrl, Net.UA_IPHONE, REFERER) } catch (e: IOException) { netErr = e; continue }
            when (val r = parsePage(html, id)) {
                is Page.Ok -> return r.post
                is Page.Error -> throw PostUnavailable("ks_${r.code}", errorText(r.code, r.msg), true)
                is Page.NoData -> why = r.why
            }
        }
        if (netErr != null) throw UserError(Extractor.netMessage(netErr))
        throw UserError("快手没有返回作品数据（$why）。可能需要验证或作品不可见，请稍后重试")
    }

    fun errorText(code: Int, msg: String): String {
        val m = msg.trim()
        return when {
            m.isNotEmpty() -> "快手：$m"
            else -> "快手作品无法查看（错误码 $code）：可能已删除、设为私密或仅好友可见"
        }
    }

    /** Parse the mobile share page HTML. [wantId] is the photo id from the link (used to pick the right object). */
    fun parsePage(html: String, wantId: String?): Page {
        val m = STATE_RE.find(html) ?: return Page.NoData("页面中没有 INIT_STATE")
        val root = try { JSONObject(m.groupValues[1]) } catch (e: Exception) { return Page.NoData("INIT_STATE 解析失败") }
        val photos = ArrayList<JSONObject>()
        var err: Page.Error? = null
        fun walk(o: Any?, depth: Int) {
            if (depth > 8) return
            when (o) {
                is JSONObject -> {
                    val ph = o.optJSONObject("photo")
                    if (ph != null && (ph.has("mainMvUrls") || ph.has("ext_params") || ph.has("photoId"))) photos += ph
                    val res = o.opt("result")
                    if (res is Int && res != 1 && o.has("error_msg") && err == null) err = Page.Error(res, o.optString("error_msg"))
                    val it = o.keys(); while (it.hasNext()) walk(o.opt(it.next()), depth + 1)
                }
                is JSONArray -> for (i in 0 until o.length()) walk(o.opt(i), depth + 1)
            }
        }
        walk(root, 0)
        val ph = photos.firstOrNull { wantId != null && it.optString("photoId") == wantId } ?: photos.firstOrNull()
        if (ph != null) {
            val p = fromPhoto(ph, wantId)
            if (p.isImages || p.videoUrls.isNotEmpty()) return Page.Ok(p)
        }
        err?.let { return it }
        return Page.NoData(if (ph != null) "作品里没有视频或图片地址" else "没有 photo 对象")
    }

    private fun urls(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).mapNotNull { i ->
            when (val v = a.opt(i)) {
                is JSONObject -> v.optString("url").takeIf { it.startsWith("http") }
                is String -> v.takeIf { it.startsWith("http") }
                else -> null
            }
        }
    }

    fun fromPhoto(ph: JSONObject, wantId: String?): Post {
        // The link carries the share id ("3x…"); the object's photoId is the numeric id. Keep the share id for links.
        val id = wantId?.takeIf { it.isNotBlank() } ?: ph.optString("photoId")
        // 图集: ext_params.atlas = {cdn:[host…], list:[path…]} (also seen at photo.atlas).
        val atlas = ph.optJSONObject("ext_params")?.optJSONObject("atlas") ?: ph.optJSONObject("atlas")
        val images = ArrayList<ImageItem>()
        if (atlas != null) {
            val cdns = (0 until (atlas.optJSONArray("cdn")?.length() ?: 0)).mapNotNull { atlas.optJSONArray("cdn")?.optString(it)?.takeIf { s -> s.isNotBlank() } }
                .ifEmpty { listOf("p1.a.yximgs.com", "p2.a.yximgs.com") }
            val list = atlas.optJSONArray("list")
            if (list != null) for (i in 0 until list.length()) {
                val path = list.optString(i)
                if (path.isBlank()) continue
                val u = if (path.startsWith("http")) listOf(path) else cdns.map { c -> "https://${c.removePrefix("https://").removePrefix("http://").trimEnd('/')}/${path.trimStart('/')}" }
                images += ImageItem(u, emptyList())
            }
        }
        val isSingle = images.isEmpty() && (ph.optBoolean("singlePicture") || ph.optString("photoType").contains("PICTURE", true)) && !ph.has("mainMvUrls")
        if (isSingle) urls(ph.optJSONArray("coverUrls")).takeIf { it.isNotEmpty() }?.let { images += ImageItem(it, emptyList()) }

        // Video: mp4 representations from the manifest (best first, H.264 before HEVC), then mainMvUrls.
        val cands = LinkedHashSet<String>()
        val reps = ArrayList<Triple<Int, Boolean, List<String>>>()
        ph.optJSONObject("manifest")?.optJSONArray("adaptationSet")?.let { sets ->
            for (i in 0 until sets.length()) {
                val r = sets.optJSONObject(i)?.optJSONArray("representation") ?: continue
                for (j in 0 until r.length()) {
                    val rep = r.optJSONObject(j) ?: continue
                    val all = listOf(rep.optString("url")) + urls(rep.optJSONArray("backupUrl"))
                    val mp4 = all.filter { it.startsWith("http") && !it.contains(".m3u8") && !it.contains("/hls") }
                    if (mp4.isEmpty()) continue
                    val h = minOf(rep.optInt("width"), rep.optInt("height")).takeIf { it > 0 } ?: rep.optInt("height")
                    reps += Triple(h, rep.optString("videoCodec").contains("hevc", true), mp4)
                }
            }
        }
        val heights = HashMap<String, Int>()
        for (r in reps.sortedWith(compareByDescending<Triple<Int, Boolean, List<String>>> { it.first }.thenBy { it.second })) {
            cands += r.third; if (r.first > 0) for (u in r.third) heights.putIfAbsent(u, r.first)
        }
        val photoH = minOf(ph.optInt("width"), ph.optInt("height"))
        for (u in urls(ph.optJSONArray("mainMvUrls"))) { cands += u; if (photoH > 0) heights.putIfAbsent(u, photoH) }
        val isImages = images.isNotEmpty()
        val cover = urls(ph.optJSONArray("coverUrls")).firstOrNull() ?: urls(ph.optJSONArray("webpCoverUrls")).firstOrNull()
        return Post(
            id = id,
            isImages = isImages,
            desc = ph.optString("caption"),
            author = ph.optString("userName"),
            cover = if (isImages) images.first().urls.first() else cover,
            durationMs = if (isImages) 0 else ph.optLong("duration", 0),
            videoUrls = if (isImages) emptyList() else cands.toList(),
            heights = if (isImages) emptyMap() else heights,
            images = images,
            source = "分享页",
            platform = Platform.KUAISHOU,
            pageUrl = "https://www.kuaishou.com/short-video/$id",
            headers = mapOf("Referer" to REFERER, "User-Agent" to Net.UA_IPHONE),
            height = minOf(ph.optInt("width"), ph.optInt("height")).coerceAtLeast(0),
        )
    }
}

/** Short-link expansion shared by the native parsers and the yt-dlp path. */
object Resolve {
    /** Follow redirects by hand (max 10 hops) until [done] accepts a URL; returns the last URL reached. */
    fun follow(url0: String, ua: String, done: (String) -> Boolean = { false }): String {
        // Share texts often carry http:// links; every supported platform serves https (and Android blocks cleartext).
        val url = if (url0.startsWith("http://")) "https://" + url0.removePrefix("http://") else url0
        var lastErr: IOException? = null
        for (attempt in 0 until 3) {
            var cur = url
            try {
                for (hop in 0 until 10) {
                    val req = Request.Builder().url(cur).header("User-Agent", ua)
                        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8").get().build()
                    Net.noRedirect.newCall(req).execute().use { r ->
                        val loc = r.header("Location")
                        if (r.isRedirect && loc != null) {
                            cur = r.request.url.resolve(loc)?.toString() ?: loc
                            if (done(cur)) return cur
                        } else {
                            if (r.code == 404) throw UserError("短链接无效或已过期（HTTP 404），请重新复制分享链接")
                            if (r.code >= 500) throw IOException("HTTP ${r.code}")
                            // Some short links redirect with a page / meta refresh instead of a 30x.
                            val body = r.body?.string().orEmpty()
                            Regex("""(?:http-equiv=["']?refresh["']?[^>]*url=|location\.(?:href|replace)\(?\s*=?\s*["'])(https?://[^"'>\s)]+)""", RegexOption.IGNORE_CASE)
                                .find(body)?.let { m -> val n = m.groupValues[1].replace("&amp;", "&"); if (n != cur) { cur = n; if (done(cur)) return cur; return@use } }
                            return cur
                        }
                    }
                }
                return cur
            } catch (e: UserError) { throw e } catch (e: IOException) {
                lastErr = e; Thread.sleep(500L * (attempt + 1))
            }
        }
        throw UserError(Extractor.netMessage(lastErr))
    }
}
