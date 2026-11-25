package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test

class YtdlpSupportTest {
    private fun res(name: String) = javaClass.classLoader!!.getResource("fixtures/$name")!!.readText()

    // Real `yt-dlp --dump-single-json` outputs (yt-dlp 2026.11.23, same options as the app), saved Nov 2026.
    @Test fun tiktok() {
        val p = YtdlpSupport.parseInfo(res("yt_tiktok.json"), Platform.TIKTOK, "https://www.tiktok.com/@zachking/video/6768504823336815877", "/x/info.json")
        assertEquals("ytdlp", p.engine)
        assertEquals("zachking", p.author)
        assertTrue(p.title.startsWith("They rejected my application"))
        assertEquals(1080, p.height)
        assertEquals("/x/info.json", p.infoJson)
        assertEquals(1, p.entries)
        assertTrue(p.durationMs > 0)
        assertNotNull(p.cover)
    }

    @Test fun weiboAndX() {
        val w = YtdlpSupport.parseInfo(res("yt_weibo.json"), Platform.WEIBO, "u", null)
        assertEquals(1080, w.height)
        assertEquals("睡前视频基地", w.author)
        val x = YtdlpSupport.parseInfo(res("yt_x.json"), Platform.X, "u", null)
        assertEquals("SpaceX", x.author)
        assertEquals(1080, x.height)
        assertEquals(Platform.X, x.platform)
    }

    @Test fun playlistCarousel() {
        val json = """{"_type":"playlist","id":"BQ0eAlwhDrw","title":"Post by instagram","description":"caption text","uploader":"instagram",
            "webpage_url":"https://www.instagram.com/p/BQ0eAlwhDrw/","entries":[
            {"id":"a","formats":[{"url":"https://x/1.mp4","height":1280,"width":720}],"height":1280,"width":720,"duration":5.0,"thumbnail":"https://x/t1.jpg"},
            {"id":"b","formats":[],"duration":0},
            {"id":"c","formats":[{"url":"https://x/2.mp4"}],"height":640,"width":640,"duration":3.5}]}"""
        val p = YtdlpSupport.parseInfo(json, Platform.INSTAGRAM, "u", null)
        assertEquals(2, p.entries)                 // the image-only entry is skipped
        assertEquals("caption text", p.title)      // generic "Post by" title replaced by the caption
        assertEquals(8500L, p.durationMs)
        assertEquals(720, p.height)
        assertEquals("https://x/t1.jpg", p.cover)
    }

    @Test(expected = UserError::class) fun emptyPlaylist() {
        YtdlpSupport.parseInfo("""{"_type":"playlist","entries":[]}""", Platform.INSTAGRAM, "u", null)
    }

    @Test fun options() {
        val o = YtdlpSupport.infoOptions(Platform.TIKTOK, "1080", "/c/cookies.txt")
        assertTrue(o.containsAll(listOf("--dump-single-json", "--no-playlist", "--cookies", "/c/cookies.txt")))
        assertEquals("res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a", o[o.indexOf("-S") + 1])
        assertTrue(o[o.indexOf("-f") + 1].contains("format_note!*=atermark"))
        val d = YtdlpSupport.downloadOptions(Platform.BILIBILI, "best", null, "/i.json", "/out")
        assertEquals("/i.json", d[d.indexOf("--load-info-json") + 1])
        assertEquals("mp4", d[d.indexOf("--merge-output-format") + 1])
        assertTrue(d[d.indexOf("-o") + 1].startsWith("/out/"))
        assertEquals("res,vcodec:h264,acodec:aac,ext:mp4:m4a", d[d.indexOf("-S") + 1])
        assertFalse(d.contains("--cookies"))
        assertEquals("bv*+ba/b", d[d.indexOf("-f") + 1])
    }

    // Real stderr lines seen from the sandbox in Nov 2026.
    @Test fun errorMessages() {
        fun m(s: String, p: Platform = Platform.YOUTUBE) = YtdlpSupport.errorMessage(s, p)
        assertTrue(m("ERROR: [BiliBili] 13x41117TL: Unable to download webpage: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)", Platform.BILIBILI).contains("限流"))
        assertTrue(m("ERROR: [TikTok] 7202950113931234606: Your IP address is blocked from accessing this post", Platform.TIKTOK).contains("IP"))
        assertTrue(m("ERROR: [facebook] 1388064706077874: This video is age-restricted and requires authentication. Use --cookies-from-browser", Platform.FACEBOOK).contains("年龄"))
        assertTrue(m("ERROR: [twitter] 643211948184596480: No video could be found in this tweet", Platform.X).contains("没有可下载的视频"))
        assertTrue(m("ERROR: [Instagram] BQ0eAlwhDrw: The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously. Use --cookies", Platform.INSTAGRAM).contains("限流"))
        assertTrue(m("ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser", Platform.VIMEO).contains("需要登录"))
        assertTrue(m("ERROR: [youtube] jNQXAC9IVRw: Failed to extract any player response; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= ").contains("更新解析引擎"))
        assertTrue(m("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser").contains("机器人"))
        assertTrue(m("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video").contains("私密"))
        assertTrue(m("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader").contains("已被删除"))
        assertTrue(m("ERROR: [youtube] abc: The uploader has not made this video available in your country").contains("地区限制"))
        assertTrue(m("ERROR: [youtube] abc: Join this channel to get access to members-only content like this video").contains("会员"))
        assertTrue(m("ERROR: [BiliBili] BV1x: This video is for premium members only", Platform.BILIBILI).contains("会员"))
        assertTrue(m("ERROR: Unsupported URL: https://example.com/", Platform.OTHER).contains("不支持"))
        assertTrue(m("ERROR: [generic] x: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>", Platform.OTHER).contains("网络错误"))
        assertTrue(m("ERROR: [vimeo] 54469442: This request has been blocked due to its TLS fingerprint. Install a required impersonation dependency if possible", Platform.VIMEO).contains("TLS"))
        assertEquals("No video could be found in this tweet", YtdlpSupport.errorLine("WARNING: x\nERROR: [twitter] 643211948184596480: No video could be found in this tweet\n"))
    }
}
