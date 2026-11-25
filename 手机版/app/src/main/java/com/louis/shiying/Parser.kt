package com.louis.shiying

import org.json.JSONArray
import org.json.JSONObject

data class ImageItem(val urls: List<String>, val liveVideoUrls: List<String>)

data class Post(
    val id: String,
    val isImages: Boolean,
    val desc: String,
    val author: String,
    val cover: String?,
    val durationMs: Long,
    /** No-watermark candidates, best first. Tried in order until one downloads. */
    val videoUrls: List<String>,
    val images: List<ImageItem>,
    /** Which extraction method produced this post ("分享页" / "网页" / "解析引擎" …). */
    val source: String,
    val platform: Platform = Platform.DOUYIN,
    /** Canonical link of the post (used for 重新解析 / 复制链接). */
    val pageUrl: String = "",
    /** "native" = download [videoUrls]/[images] with OkHttp; "ytdlp" = download with yt-dlp from [infoJson]. */
    val engine: String = "native",
    /** yt-dlp: path of the info JSON written at parse time (download reuses it with --load-info-json). */
    val infoJson: String? = null,
    /** Extra request headers for native downloads (Referer / User-Agent). */
    val headers: Map<String, String> = emptyMap(),
    /** yt-dlp playlists (carousel posts, multi-part videos): number of videos. */
    val entries: Int = 1,
    /** Best height that will be downloaded, e.g. 1080 (0 = unknown). */
    val height: Int = 0,
    /** Native posts: height (short side) of each [videoUrls] candidate when known, for the 下载画质 setting. */
    val heights: Map<String, Int> = emptyMap(),
    /** Per-download quality picked on the preview card (overrides the 下载画质 setting for this download). */
    val qualityOverride: String? = null,
    /** yt-dlp: extra options the successful parse attempt used (e.g. --proxy, player clients), reused for the download. */
    val ytdlpArgs: List<String> = emptyList(),
    /** Telegram (engine "telegram"): chat, message ids and the files to download over MTProto. */
    val tg: TgPost? = null,
) {
    val title: String get() = desc.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.ifEmpty { null } ?: "（无标题）"
    val liveCount: Int get() = images.count { it.liveVideoUrls.isNotEmpty() }
    val link: String get() = pageUrl.ifEmpty { "https://www.douyin.com/${if (isImages) "note" else "video"}/$id" }
}

/** Thrown when Douyin says the post can't be viewed (deleted / private / friends-only …). */
class PostUnavailable(val reason: String, message: String, val final: Boolean) : Exception(message)

/** Pure parsing of Douyin share-page HTML and aweme JSON. No Android dependencies besides org.json. */
object Parser {
    sealed class Share {
        class Item(val item: JSONObject) : Share()
        class Filtered(val reason: String, val notice: String, val detail: String) : Share()
        /** Page had no item data at all (missing cookie, anti-bot page, unknown id…). */
        class NoData(val why: String) : Share()
    }

    private val ROUTER_RE = Regex("""window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>""", RegexOption.DOT_MATCHES_ALL)

    fun parseSharePage(html: String): Share {
        val m = ROUTER_RE.find(html) ?: return Share.NoData("页面中没有 _ROUTER_DATA")
        val root = try { JSONObject(m.groupValues[1]) } catch (e: Exception) { return Share.NoData("_ROUTER_DATA 解析失败") }
        val ld = root.optJSONObject("loaderData") ?: return Share.NoData("没有 loaderData")
        val keys = ld.keys()
        while (keys.hasNext()) {
            val v = ld.optJSONObject(keys.next()) ?: continue
            val res = v.optJSONObject("videoInfoRes") ?: continue
            val list = res.optJSONArray("item_list")
            if (list != null && list.length() > 0 && list.optJSONObject(0) != null) return Share.Item(list.getJSONObject(0))
            val f = res.optJSONArray("filter_list")?.optJSONObject(0)
            if (f != null) return Share.Filtered(f.optString("filter_reason"), f.optString("notice"), f.optString("detail_msg"))
            return Share.NoData("item_list 为空")
        }
        return Share.NoData("没有 videoInfoRes")
    }

    /** Map Douyin's filter reason to a clear Chinese message. final=true: retrying another way won't help. */
    fun unavailable(reason: String, notice: String = "", detail: String = ""): PostUnavailable {
        val r = reason.lowercase()
        return when {
            r == "author_secret" -> PostUnavailable(reason, "这是私密帐号的作品，无法下载（需要关注并被对方通过）", true)
            r == "system_item_not_exist" || r.contains("delete") -> PostUnavailable(reason, "作品不存在或已被删除", true)
            r.contains("friend") -> PostUnavailable(reason, "这是仅好友可见的作品，无法下载", true)
            r.contains("self_see") -> PostUnavailable(reason, "作品不见了：可能已被删除、设为私密或仅好友可见，无法下载", true)
            else -> PostUnavailable(reason, "作品暂时无法查看" + (listOf(notice, detail).firstOrNull { it.isNotBlank() }?.let { "：$it" } ?: "") + "（$reason）", false)
        }
    }

    private fun strings(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.startsWith("http") } }
    }

    private fun firstUrl(o: JSONObject?): String? = strings(o?.optJSONArray("url_list")).firstOrNull()

    /** Rewrite an aweme play / playwm API url to the no-watermark play url at a given ratio. */
    fun playUrl(u: String, ratio: String?): String {
        var s = u.replace("/playwm/", "/play/").replace("playwm?", "play?")
        if (ratio != null) {
            s = if (Regex("""[?&]ratio=""").containsMatchIn(s)) s.replace(Regex("""([?&]ratio=)[^&]*"""), "$1$ratio")
            else s + (if (s.contains('?')) "&" else "?") + "ratio=$ratio"
        }
        return s
    }

    private fun isPlayApi(u: String) = u.contains("/aweme/v1/play")

    /** All no-watermark video candidates for a `video` object, best quality first, de-duplicated. */
    fun videoCandidates(video: JSONObject?): List<String> = videoCandidatesWithHeights(video).first

    /** Candidates + known height of each (bit_rate entries, ratio=… play urls). */
    fun videoCandidatesWithHeights(video: JSONObject?): Pair<List<String>, Map<String, Int>> {
        if (video == null) return emptyList<String>() to emptyMap()
        val out = LinkedHashSet<String>()
        val hs = HashMap<String, Int>()
        fun ratioH(u: String): Int = Regex("""[?&]ratio=(\d{3,4})p""").find(u)?.groupValues?.get(1)?.toInt() ?: 0
        // 1) Web detail JSON: bit_rate list carries direct CDN urls per quality.
        val br = video.optJSONArray("bit_rate")
        if (br != null) {
            data class Q(val h: Int, val rate: Long, val h265: Boolean, val urls: List<String>)
            val qs = (0 until br.length()).mapNotNull { i ->
                val b = br.optJSONObject(i) ?: return@mapNotNull null
                val pa = b.optJSONObject("play_addr") ?: return@mapNotNull null
                val urls = strings(pa.optJSONArray("url_list"))
                if (urls.isEmpty()) return@mapNotNull null
                val h = minOf(pa.optInt("height", 0), pa.optInt("width", 0)).takeIf { it > 0 } ?: pa.optInt("height", 0)
                Q(h, b.optLong("bit_rate", 0), b.optInt("is_h265", 0) == 1 || b.optInt("is_bytevc1", 0) == 1, urls)
            }.sortedWith(compareByDescending<Q> { it.h }.thenBy { it.h265 }.thenByDescending { it.rate })
            for (q in qs) for (u in q.urls) { val x = if (isPlayApi(u)) playUrl(u, null) else u; out += x; if (q.h > 0) hs.putIfAbsent(x, q.h) }
        }
        // 2) play_addr (share page: aweme.snssdk.com/aweme/v1/playwm/?video_id=…&ratio=720p).
        val pa = video.optJSONObject("play_addr")
        val paUrls = strings(pa?.optJSONArray("url_list")).filterNot { it.contains(".mp3") }
        val api = paUrls.filter { isPlayApi(it) }
        for (u in api) out += playUrl(u, "1080p")
        for (u in api) out += playUrl(u, "720p")
        for (u in api) out += playUrl(u, "540p")
        for (u in paUrls) out += if (isPlayApi(u)) playUrl(u, null) else u
        val uri = pa?.optString("uri").orEmpty()
        if (api.isEmpty() && uri.isNotBlank() && !uri.startsWith("http")) {
            out += "https://aweme.snssdk.com/aweme/v1/play/?video_id=$uri&ratio=1080p&line=0"
            out += "https://aweme.snssdk.com/aweme/v1/play/?video_id=$uri&ratio=720p&line=0"
            out += "https://aweme.snssdk.com/aweme/v1/play/?video_id=$uri&ratio=540p&line=0"
        }
        // 3) h264 variant if present.
        for (u in strings(video.optJSONObject("play_addr_h264")?.optJSONArray("url_list"))) out += if (isPlayApi(u)) playUrl(u, "1080p") else u
        for (u in out) if (!hs.containsKey(u)) ratioH(u).takeIf { it > 0 }?.let { hs[u] = it }
        return out.toList() to hs
    }

    /** Build a [Post] from a share-page item or a web aweme_detail object (same field names). */
    fun fromItem(item: JSONObject, source: String): Post {
        val id = item.optString("aweme_id").ifEmpty { item.optString("group_id_str") }
        val video = item.optJSONObject("video")
        val imgs = item.optJSONArray("images")
        val images = ArrayList<ImageItem>()
        if (imgs != null) for (i in 0 until imgs.length()) {
            val im = imgs.optJSONObject(i) ?: continue
            // url_list = clean image; download_url_list = with watermark (never used). Prefer jpeg over webp.
            val urls = strings(im.optJSONArray("url_list")).sortedBy { if (it.contains(".webp")) 1 else 0 }
            if (urls.isEmpty()) continue
            images += ImageItem(urls, videoCandidates(im.optJSONObject("video")))
        }
        val isImages = images.isNotEmpty()
        var dur = video?.optLong("duration", 0) ?: 0L
        if (dur in 1..999) dur *= 1000 // some payloads give seconds
        val cover = firstUrl(video?.optJSONObject("origin_cover")) ?: firstUrl(video?.optJSONObject("cover"))
            ?: images.firstOrNull()?.urls?.firstOrNull()
        val author = item.optJSONObject("author")?.optString("nickname").orEmpty()
        val (vids, vh) = if (isImages) emptyList<String>() to emptyMap() else videoCandidatesWithHeights(video)
        return Post(
            id = id,
            isImages = isImages,
            desc = item.optString("desc"),
            author = author,
            cover = if (isImages) images.first().urls.first() else cover,
            durationMs = if (isImages) 0 else dur,
            videoUrls = vids,
            heights = vh,
            images = images,
            source = source,
            platform = Platform.DOUYIN,
            pageUrl = "https://www.douyin.com/${if (isImages) "note" else "video"}/$id",
            // Web-captured URLs (douyinvod) were requested by the desktop page; share-page URLs by the iPhone UA.
            headers = mapOf("Referer" to "https://www.douyin.com/", "User-Agent" to if (source == "网页") Net.UA_DESKTOP else Net.UA_IPHONE),
        )
    }

    /** Web API wrapper: {"aweme_detail":{…}} or {"aweme_details":[…]} or {"filter_detail":{…}}. */
    fun fromWebDetail(json: String, wantId: String?): Post? {
        val o = try { JSONObject(json) } catch (e: Exception) { return null }
        val d = o.optJSONObject("aweme_detail")
            ?: o.optJSONArray("aweme_details")?.optJSONObject(0)
            ?: o.optJSONArray("aweme_list")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.firstOrNull { wantId == null || it.optString("aweme_id") == wantId } }
            ?: o.optJSONArray("item_list")?.optJSONObject(0)
            ?: return null
        if (wantId != null && d.optString("aweme_id").isNotEmpty() && d.optString("aweme_id") != wantId) return null
        val p = fromItem(d, "网页")
        return if (p.isImages || p.videoUrls.isNotEmpty()) p else null
    }

    fun formatDuration(ms: Long): String {
        if (ms <= 0) return ""
        val s = (ms + 500) / 1000
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }
}
