package com.louis.shiying

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * 小红书: xhslink short link → note page (www.xiaohongshu.com/explore/{id}?xsec_token=…, the token is required)
 * → window.__INITIAL_STATE__ (PC: note.noteDetailMap[id].note, mobile: noteData.data.noteData).
 * - Video: sns-video-bd.xhscdn.com/{consumer.originVideoKey} (original upload, no watermark), then stream.h264/h265 masterUrls.
 * - Images: the image token from urlDefault → sns-img-bd.xhscdn.com/{token} / ci.xiaohongshu.com/{token} (original, no watermark),
 *   the page's urlDefault as last resort. Live photos: imageList[].stream.h264[].masterUrl.
 * Pure JVM.
 */
object Xhs {
    private val NOTE_ID_RE = Regex("""/(?:explore|discovery/item|item|note)/([0-9a-f]{24})""")
    private val STATE_RE = Regex("""window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>""", RegexOption.DOT_MATCHES_ALL)
    const val REFERER = "https://www.xiaohongshu.com/"

    fun noteId(url: String): String? = NOTE_ID_RE.find(url)?.groupValues?.get(1)

    sealed class Page {
        class Ok(val post: Post) : Page()
        class Gone(val msg: String) : Page()
        class NoData(val why: String) : Page()
    }

    /** Throws [UserError] / [PostUnavailable]; [XhsNoData] when the page had no note (caller may try yt-dlp / web mode). */
    class XhsNoData(val url: String, why: String) : Exception(why)

    fun parse(text: String, log: (String) -> Unit = {}): Post {
        val url = Links.findUrl(text) ?: throw UserError("没有找到小红书链接")
        var target = url
        if (noteId(url) == null || !url.contains("xsec_token")) {
            if (noteId(url) == null) {
                log("正在解析小红书短链接…")
                target = Resolve.follow(url, Net.UA_IPHONE) { noteId(it) != null || it.contains("/404") || it.contains("/login") }
            }
        }
        if (target.contains("/404") || target.contains("xhs_sec_server") || Links.host(target).endsWith("rednote.com") && noteId(target) == null) {
            throw UserError(secMessage(target))
        }
        val id = noteId(target) ?: throw UserError("小红书链接没有指向笔记（可能是主页或已失效），请在小红书里点「分享 → 复制链接」")
        if (!target.contains("xsec_token")) log("链接里没有 xsec_token，小红书可能拒绝访问…")
        // The PC page carries the full note; the mobile page is the fallback.
        val pages = LinkedHashSet<String>()
        pages += target.replace("://xiaohongshu.com", "://www.xiaohongshu.com")
        pages += target.replace(Regex("""/discovery/item/"""), "/explore/")
        var why = "页面中没有笔记数据"
        var netErr: IOException? = null
        var blocked: String? = null
        var parsedAny = false
        for (pageUrl in pages) for (ua in listOf(Net.UA_DESKTOP, Net.UA_IPHONE)) {
            log("正在读取小红书笔记…")
            val r = try { Net.fetch(pageUrl, ua, REFERER) } catch (e: IOException) { netErr = e; continue }
            if (r.finalUrl.contains("/404") || r.finalUrl.contains("xhs_sec_server") || r.finalUrl.contains("/website-login")) {
                blocked = secMessage(r.finalUrl); why = blocked; continue
            }
            parsedAny = true
            when (val p = parsePage(r.body, id, target)) {
                is Page.Ok -> return p.post
                is Page.Gone -> throw PostUnavailable("xhs_gone", p.msg, true)
                is Page.NoData -> why = p.why
            }
        }
        if (netErr != null && why == "页面中没有笔记数据") throw UserError(Extractor.netMessage(netErr))
        // Every attempt was bounced to the security / 404 page: yt-dlp would be bounced too, so say why instead.
        if (blocked != null && !parsedAny) throw UserError(blocked)
        throw XhsNoData(target, why)
    }

    fun secMessage(u: String): String = when {
        u.contains("300031") -> "小红书：当前笔记暂时无法浏览（可能已删除、仅自己可见，或分享链接已失效）"
        u.contains("rednote.com") -> "小红书拒绝了访问：当前网络被识别为海外 IP（会跳到 rednote 国际版）。请关闭 VPN 或换国内网络后重试，或先在「登录平台账号」里登录小红书"
        else -> "小红书拒绝访问（安全验证/需要登录或链接已失效）。请重新「分享 → 复制链接」，或先在「登录平台账号」里登录小红书"
    }

    fun parsePage(html: String, id: String, pageUrl: String): Page {
        val m = STATE_RE.find(html) ?: return Page.NoData("页面中没有 __INITIAL_STATE__")
        val js = m.groupValues[1].replace(Regex("""(?<=[:\[,])\s*undefined(?=\s*[,}\]])"""), "null")
        val root = try { JSONObject(js) } catch (e: Exception) { return Page.NoData("__INITIAL_STATE__ 解析失败") }
        val note = root.optJSONObject("note")?.optJSONObject("noteDetailMap")?.let { map ->
            (map.optJSONObject(id) ?: map.keys().asSequence().mapNotNull { map.optJSONObject(it) }.firstOrNull())?.optJSONObject("note")
        }?.takeIf { it.length() > 0 }
            ?: root.optJSONObject("noteData")?.optJSONObject("data")?.optJSONObject("noteData")
            ?: root.optJSONObject("noteData")?.optJSONObject("noteData")
        if (note == null || (note.optString("noteId").isEmpty() && !note.has("imageList") && !note.has("video"))) {
            val err = root.optJSONObject("note")?.optString("serverRequestInfo")
                ?: root.optJSONObject("noteData")?.optString("errorMsg")
            if (!err.isNullOrBlank() && (err.contains("删除") || err.contains("不存在") || err.contains("违规"))) return Page.Gone("小红书：$err")
            return Page.NoData("没有笔记对象")
        }
        val p = fromNote(note, id, pageUrl)
        return if (p.isImages || p.videoUrls.isNotEmpty()) Page.Ok(p) else Page.NoData("笔记里没有图片或视频地址")
    }

    /** "http://sns-webpic-qc.xhscdn.com/202411251530/<hash>/<token>!nd_dft_wlteh_webp_3" → "<token>". */
    fun imageToken(u: String): String? {
        val noQuery = u.substringBefore('?').substringBefore('!')
        val parts = noQuery.substringAfter("://").split('/')
        if (parts.size < 2) return null
        // sns-webpic hosts: host / timestamp / hash / token…; ci / sns-img hosts: host / token…
        val host = parts[0]
        val rest = if (host.startsWith("sns-webpic") && parts.size >= 4) parts.drop(3) else parts.drop(1)
        return rest.joinToString("/").takeIf { it.isNotBlank() }
    }

    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.startsWith("http") } }

    private fun streamUrls(stream: JSONObject?): List<String> = streamUrlsH(stream).map { it.first }

    /** Stream urls (best first) with the height (short side) of each. */
    private fun streamUrlsH(stream: JSONObject?): List<Pair<String, Int>> {
        if (stream == null) return emptyList()
        data class S(val h: Int, val hevc: Boolean, val urls: List<String>)
        val all = ArrayList<S>()
        for ((key, hevc) in listOf("h264" to false, "h265" to true, "av1" to true, "h266" to true)) {
            val arr = stream.optJSONArray(key) ?: continue
            for (i in 0 until arr.length()) {
                val s = arr.optJSONObject(i) ?: continue
                val urls = (listOf(s.optString("masterUrl")) + strs(s.optJSONArray("backupUrls"))).filter { it.startsWith("http") }
                if (urls.isEmpty()) continue
                val h = minOf(s.optInt("width"), s.optInt("height")).takeIf { it > 0 } ?: s.optInt("height")
                all += S(h, hevc, urls)
            }
        }
        return all.sortedWith(compareByDescending<S> { it.h }.thenBy { it.hevc }).flatMap { s -> s.urls.map { it to s.h } }
    }

    fun fromNote(note: JSONObject, id: String, pageUrl: String): Post {
        val nid = note.optString("noteId").ifEmpty { id }
        val video = note.optJSONObject("video")
        val isVideo = note.optString("type") == "video" || video?.optJSONObject("media") != null
        val images = ArrayList<ImageItem>()
        val list = note.optJSONArray("imageList")
        if (list != null) for (i in 0 until list.length()) {
            val im = list.optJSONObject(i) ?: continue
            val pageUrls = LinkedHashSet<String>()
            im.optString("urlDefault").takeIf { it.startsWith("http") }?.let { pageUrls += it }
            im.optString("url").takeIf { it.startsWith("http") }?.let { pageUrls += it }
            im.optJSONArray("infoList")?.let { il -> for (j in 0 until il.length()) il.optJSONObject(j)?.optString("url")?.takeIf { it.startsWith("http") }?.let { pageUrls += it } }
            im.optString("urlPre").takeIf { it.startsWith("http") }?.let { pageUrls += it }
            val token = pageUrls.firstNotNullOfOrNull { imageToken(it) }
            val urls = LinkedHashSet<String>()
            if (token != null) {
                urls += "https://sns-img-bd.xhscdn.com/$token"
                urls += "https://ci.xiaohongshu.com/$token?imageView2/2/w/format/jpg"
            }
            urls += pageUrls.map { it.replaceFirst("http://", "https://") }
            if (urls.isEmpty()) continue
            val live = if (im.optBoolean("livePhoto") || im.optJSONObject("stream") != null) streamUrls(im.optJSONObject("stream")) else emptyList()
            images += ImageItem(urls.toList(), live)
        }
        val vids = LinkedHashSet<String>()
        val heights = HashMap<String, Int>()
        if (isVideo && video != null) {
            val st = streamUrlsH(video.optJSONObject("media")?.optJSONObject("stream"))
            // The original upload is at least as large as the best transcode.
            val originH = st.maxOfOrNull { it.second } ?: 0
            video.optJSONObject("consumer")?.optString("originVideoKey")?.takeIf { it.isNotBlank() }?.let {
                val u = "https://sns-video-bd.xhscdn.com/$it"; vids += u; if (originH > 0) heights[u] = originH
            }
            for ((u, h) in st) { vids += u; if (h > 0) heights.putIfAbsent(u, h) }
        }
        val asImages = !isVideo && images.isNotEmpty()
        val title = note.optString("title")
        val desc = note.optString("desc")
        val user = note.optJSONObject("user")
        val dur = video?.optJSONObject("capa")?.optLong("duration")?.takeIf { it > 0 }?.times(1000)
            ?: video?.optJSONObject("media")?.optJSONObject("video")?.optLong("duration")?.takeIf { it > 0 } ?: 0L
        return Post(
            id = nid,
            isImages = asImages,
            desc = listOf(title, desc).filter { it.isNotBlank() }.joinToString("\n"),
            author = user?.optString("nickname")?.ifEmpty { user.optString("nickName") }.orEmpty(),
            cover = images.firstOrNull()?.urls?.lastOrNull(),
            durationMs = if (asImages) 0 else dur,
            videoUrls = if (asImages) emptyList() else vids.toList(),
            heights = if (asImages) emptyMap() else heights,
            images = if (asImages) images else emptyList(),
            source = "分享页",
            platform = Platform.XIAOHONGSHU,
            pageUrl = pageUrl,
            headers = mapOf("Referer" to REFERER, "User-Agent" to Net.UA_DESKTOP),
        )
    }
}
