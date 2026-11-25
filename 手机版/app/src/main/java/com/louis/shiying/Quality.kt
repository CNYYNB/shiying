package com.louis.shiying

import org.json.JSONObject

/**
 * Download quality ("best stream at or below that height, else the nearest above").
 * Keys: "best", "1080", "720", "480", "360", "worst". Default "1080". Pure (JVM-testable).
 */
object Quality {
    const val DEFAULT = "1080"
    val keys = listOf("best", "1080", "720", "480", "360", "worst")

    fun label(q: String): String = when (q) {
        "best" -> "最高画质"
        "worst" -> "最低画质（省流量）"
        else -> "${q}p"
    }

    fun menuLabel(q: String): String = when (q) {
        "best" -> "最高画质（可能是 2K / 4K，文件很大）"
        "1080" -> "1080p（推荐）"
        "worst" -> "最低画质（省流量）"
        else -> "${q}p"
    }

    /** Old 2.0 value "1080"/"best" stay valid; anything unknown → default. */
    fun normalize(q: String?): String = if (q != null && (q in keys || (q.toIntOrNull() ?: 0) > 0)) q else DEFAULT

    /** Pick a height from [available] (0 = unknown, ignored). Returns 0 when nothing is known. */
    fun pick(available: Collection<Int>, q: String): Int {
        val hs = available.filter { it > 0 }.distinct().sorted()
        if (hs.isEmpty()) return 0
        return when (val k = normalize(q)) {
            "best" -> hs.last()
            "worst" -> hs.first()
            else -> { val cap = k.toInt(); hs.lastOrNull { it <= cap } ?: hs.first() }
        }
    }

    /**
     * Reorder native download candidates: urls of the picked height first (in their original order), then the rest
     * as before (fallbacks if the picked rendition fails). Unknown heights → order unchanged.
     */
    fun order(urls: List<String>, heights: Map<String, Int>, q: String): List<String> {
        val h = pick(urls.mapNotNull { heights[it] }, q)
        if (h == 0) return urls
        val (a, b) = urls.partition { heights[it] == h }
        return a + b
    }

    /** Height shown on the preview card for a native post. */
    fun shownHeight(p: Post, q: String): Int = pick(p.heights.values, q).takeIf { it > 0 } ?: p.height

    /** yt-dlp -S argument. */
    fun sortArg(q: String): String = when (val k = normalize(q)) {
        "best" -> "res,vcodec:h264,acodec:aac,ext:mp4:m4a"
        "worst" -> "+res,+size,vcodec:h264,acodec:aac,ext:mp4:m4a"
        else -> "res:$k,vcodec:h264,acodec:aac,ext:mp4:m4a"
    }

    /** Heights (short side) offered in a yt-dlp info JSON with an approximate size in bytes (0 = unknown) for each. */
    fun ytdlpHeights(json: String): List<Pair<Int, Long>> {
        val o = runCatching { JSONObject(json.substring(json.indexOf('{'), json.lastIndexOf('}') + 1)) }.getOrNull() ?: return emptyList()
        val target = if (o.has("entries")) o.optJSONArray("entries")?.optJSONObject(0) ?: return emptyList() else o
        val fs = target.optJSONArray("formats") ?: return emptyList()
        val dur = target.optDouble("duration", 0.0).takeIf { !it.isNaN() } ?: 0.0
        fun size(f: JSONObject): Long = f.optLong("filesize", 0).takeIf { it > 0 } ?: f.optLong("filesize_approx", 0).takeIf { it > 0 }
            ?: f.optDouble("tbr", 0.0).takeIf { !it.isNaN() && it > 0 && dur > 0 }?.let { (it * 125 * dur).toLong() } ?: 0L
        val all = (0 until fs.length()).mapNotNull { fs.optJSONObject(it) }
        val audio = all.filter { it.optString("vcodec") == "none" && it.optString("acodec").let { a -> a.isNotEmpty() && a != "none" } }.maxOfOrNull { size(it) } ?: 0L
        val best = HashMap<Int, Long>()
        for (f in all) {
            val vc = f.optString("vcodec"); val ac = f.optString("acodec")
            if (vc == "none" || f.optString("format_note").contains("storyboard") || f.optString("ext") == "mhtml") continue
            val w = f.optInt("width", 0); val hh = f.optInt("height", 0)
            val h = if (w in 1 until hh) w else hh
            if (h <= 0) continue
            val sz = size(f).let { if (it > 0 && ac == "none") it + audio else it }
            val prev = best[h]
            if (prev == null || prev == 0L || (sz in 1 until prev)) best[h] = sz
        }
        return best.entries.sortedByDescending { it.key }.map { it.key to it.value }
    }

    /** Map a concrete height chosen in the per-download picker to a quality key that yt-dlp/native code understands. */
    fun forHeight(h: Int): String = h.toString()
}
