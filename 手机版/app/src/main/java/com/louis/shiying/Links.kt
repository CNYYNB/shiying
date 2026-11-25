package com.louis.shiying

/** Pure helpers for finding a supported link / Douyin aweme id in arbitrary pasted text. JVM-testable. */
object Links {
    private val URL_RE = Regex("""https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+""")
    /** Links pasted without a scheme (e.g. "b23.tv/xxxx", "xhslink.cn/o/xxx"): only for known platform hosts. */
    private val BARE_RE = Regex("""(?<![A-Za-z0-9@./])((?:[A-Za-z0-9-]+\.)+(?:com|cn|tv|be|am|co|net|watch)/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)""")
    private val ID_RES = listOf(
        Regex("""/(?:video|note|slides|gallery|share/video|share/note|share/slides|shipin|lvdetail|vsdetail)/(\d{8,21})"""),
        Regex("""[?&#](?:modal_id|aweme_id|item_id|vid|group_id)=(\d{8,21})"""),
        Regex("""item_ids=%5B(\d{8,21})"""),
        Regex("""item_ids=(\d{8,21})"""),
    )
    private val DOUYIN_HOST = Regex("""(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com|snssdk\.com|amemv\.com)$""", RegexOption.IGNORE_CASE)

    /** All URLs in the text (scheme-less links of known platforms get https:// added). */
    fun allUrls(text: String): List<String> {
        val withScheme = URL_RE.findAll(text).map { trimTail(it.value) }.toList()
        if (withScheme.isNotEmpty()) return withScheme
        return BARE_RE.findAll(text).map { "https://" + trimTail(it.groupValues[1]) }
            .filter { Platform.ofUrl(it) != Platform.OTHER }.toList()
    }

    /** First URL of a known platform in the text (or the first URL at all as a last resort). */
    fun findUrl(text: String): String? {
        val all = allUrls(text)
        return all.firstOrNull { isDouyin(it) } ?: all.firstOrNull { Platform.ofUrl(it) != Platform.OTHER } ?: all.firstOrNull()
    }

    /** Which platform the pasted text points at (null = no link at all). A bare 19-digit number counts as Douyin. */
    fun detect(text: String): Platform? {
        if (bareId(text) != null) return Platform.DOUYIN
        val u = findUrl(text) ?: return null
        return Platform.ofUrl(u)
    }

    /** Strip trailing punctuation that is often glued onto links in share text. */
    private fun trimTail(u: String): String {
        var s = u
        while (s.isNotEmpty() && s.last() in ".,;:!?)]'*" ) s = s.dropLast(1)
        return s
    }

    fun host(url: String): String = Regex("""^https?://([^/:?#]+)""", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1)?.lowercase() ?: ""

    fun isDouyin(url: String): Boolean = DOUYIN_HOST.containsMatchIn(host(url))

    /** True when the text contains a Douyin link. */
    fun looksLikeDouyin(text: String?): Boolean {
        if (text.isNullOrBlank()) return false
        return URL_RE.findAll(text).any { isDouyin(trimTail(it.value)) }
    }

    /** True when the text contains a link of a supported platform (used to decide clipboard auto-fill). */
    fun looksSupported(text: String?): Boolean {
        if (text.isNullOrBlank()) return false
        return allUrls(text).any { Platform.ofUrl(it) != Platform.OTHER }
    }

    fun idFromUrl(url: String): String? {
        for (re in ID_RES) re.find(url)?.let { return it.groupValues[1] }
        return null
    }

    /** Bare numeric aweme id typed by the user. */
    fun bareId(text: String): String? = Regex("""^\s*(\d{15,21})\s*$""").find(text)?.groupValues?.get(1)

    /** True if the URL is a short link that has to be resolved by following redirects. */
    fun needsResolve(url: String): Boolean = idFromUrl(url) == null

    /** "作者-标题-ID" safe for MediaStore display names (no path chars, emoji kept, ≤ 120 chars). */
    fun fileBase(author: String, title: String, id: String, fallbackAuthor: String = "抖音"): String {
        fun clean(s: String, max: Int): String {
            var t = s.replace(Regex("""#\S+"""), " ")          // drop hashtags from the title
                .replace(Regex("""@\S+"""), " ")
                .replace(Regex("""[\\/:*?"<>|\u0000-\u001f\u007f]"""), " ")
                .replace(Regex("""\s+"""), " ").trim().trim('.', ' ', '-')
            if (t.length > max) t = t.substring(0, max).trim()
            return t
        }
        val a = clean(author, 24).ifEmpty { fallbackAuthor }
        val t = clean(title, 50).ifEmpty { clean(title.replace("#", " "), 50) }.ifEmpty { "作品" }
        val i = id.replace(Regex("""[^A-Za-z0-9_\-]"""), "").take(40)
        return if (i.isEmpty()) "$a-$t" else "$a-$t-$i"
    }
}
