package com.louis.shiying

/**
 * Supported platforms. [hosts] are matched against the link's host (suffix match).
 * [engine]: "douyin" / "kuaishou" / "xhs" = native Kotlin parser, "ytdlp" = embedded yt-dlp.
 * [loginUrl]: optional in-app WebView login (cookies are shared with OkHttp and exported to yt-dlp).
 */
enum class Platform(
    val label: String,
    val hosts: List<String>,
    val engine: String,
    val loginUrl: String? = null,
    /** Cookie names that mean "logged in" on this platform. */
    val sessionCookies: List<String> = emptyList(),
    /** Domains whose cookies are exported to yt-dlp for this platform. */
    val cookieDomains: List<String> = emptyList(),
    val desktopLogin: Boolean = true,
) {
    DOUYIN("抖音", listOf("douyin.com", "iesdouyin.com", "douyinvod.com", "snssdk.com", "amemv.com"), "douyin",
        "https://www.douyin.com/", listOf("sessionid", "sessionid_ss", "sid_tt"), listOf("douyin.com")),
    KUAISHOU("快手", listOf("kuaishou.com", "chenzhongtech.com", "gifshow.com", "kuaishouapp.com", "kwai.com", "kwai.net"), "kuaishou"),
    XIAOHONGSHU("小红书", listOf("xiaohongshu.com", "xhslink.com", "xhslink.cn", "xhscdn.com", "rednote.com"), "xhs",
        "https://www.xiaohongshu.com/explore", listOf("web_session"), listOf("xiaohongshu.com")),
    BILIBILI("哔哩哔哩", listOf("bilibili.com", "b23.tv", "bili2233.cn", "bili22.cn", "bili33.cn", "bilibili.tv"), "ytdlp",
        "https://passport.bilibili.com/h5-app/passport/login", listOf("SESSDATA"), listOf("bilibili.com"), desktopLogin = false),
    WEIBO("微博", listOf("weibo.com", "weibo.cn", "t.cn"), "ytdlp",
        "https://m.weibo.cn/login", listOf("SUB"), listOf("weibo.com", "weibo.cn"), desktopLogin = false),
    XIGUA("西瓜视频", listOf("ixigua.com"), "ytdlp", null, emptyList(), listOf("ixigua.com")),
    TOUTIAO("今日头条", listOf("toutiao.com", "toutiaocdn.com", "snssdk.cn"), "ytdlp", null, emptyList(), listOf("toutiao.com")),
    YOUTUBE("YouTube", listOf("youtube.com", "youtu.be", "youtube-nocookie.com"), "ytdlp",
        "https://accounts.google.com/ServiceLogin?service=youtube&hl=zh-CN&passive=true&continue=https%3A%2F%2Fm.youtube.com%2F",
        listOf("SAPISID", "__Secure-3PSID", "LOGIN_INFO"), listOf("youtube.com", "google.com"), desktopLogin = false),
    TIKTOK("TikTok", listOf("tiktok.com"), "ytdlp", null, emptyList(), listOf("tiktok.com")),
    INSTAGRAM("Instagram", listOf("instagram.com", "instagr.am"), "ytdlp",
        "https://www.instagram.com/accounts/login/", listOf("sessionid"), listOf("instagram.com"), desktopLogin = false),
    X("X / Twitter", listOf("x.com", "twitter.com", "t.co", "fxtwitter.com", "vxtwitter.com"), "ytdlp",
        "https://x.com/i/flow/login", listOf("auth_token"), listOf("x.com", "twitter.com"), desktopLogin = false),
    FACEBOOK("Facebook", listOf("facebook.com", "fb.watch", "fb.com"), "ytdlp",
        "https://m.facebook.com/login/", listOf("c_user"), listOf("facebook.com"), desktopLogin = false),
    VIMEO("Vimeo", listOf("vimeo.com"), "ytdlp", "https://vimeo.com/log_in", listOf("vimeo"), listOf("vimeo.com")),
    /** 2.4: logged in → MTProto (TgService); not logged in → public channel posts go to yt-dlp. Login is not a WebView (see TelegramActivity). */
    TELEGRAM("Telegram", listOf("t.me", "telegram.me", "telegram.dog"), "telegram"),
    /** Any other site: handed to yt-dlp as-is (it supports ~1800 sites). */
    OTHER("其他网站", emptyList(), "ytdlp");

    val native: Boolean get() = engine != "ytdlp"

    fun matchesHost(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        return hosts.any { h == it || h.endsWith(".$it") }
    }

    companion object {
        fun ofHost(host: String): Platform = entries.firstOrNull { it != OTHER && it.matchesHost(host) } ?: OTHER
        fun ofUrl(url: String): Platform = ofHost(Links.host(url))
        fun byName(name: String?): Platform? = entries.firstOrNull { it.name == name }
        /** Platforms the user can log in to from the app (shown in the 登录 menu). */
        val loginable: List<Platform> get() = entries.filter { it.loginUrl != null }
    }
}
