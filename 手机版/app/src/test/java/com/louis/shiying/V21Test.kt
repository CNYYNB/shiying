package com.louis.shiying

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2.1: download quality, YouTube fallbacks / errors, Google login helpers, thumbnail referers. */
class V21Test {
    // ---------------------------------------------------------------- quality

    @Test fun pickAtOrBelowElseNearest() {
        val hs = listOf(1080, 720, 540, 360)
        assertEquals(1080, Quality.pick(hs, "best"))
        assertEquals(1080, Quality.pick(hs, "1080"))
        assertEquals(720, Quality.pick(hs, "720"))
        assertEquals(360, Quality.pick(hs, "480"))
        assertEquals(360, Quality.pick(hs, "360"))
        assertEquals(360, Quality.pick(hs, "worst"))
        assertEquals(720, Quality.pick(listOf(720, 1080), "360"))   // nothing at/below → nearest above
        assertEquals(2160, Quality.pick(listOf(2160, 1080), "best"))
        assertEquals(0, Quality.pick(listOf(0, 0), "720"))
        assertEquals(1440, Quality.pick(listOf(2160, 1440, 1080), "1440")) // per-download concrete height
    }

    @Test fun normalizeKeepsOldValues() {
        assertEquals("1080", Quality.normalize(null))
        assertEquals("best", Quality.normalize("best"))
        assertEquals("1080", Quality.normalize("1080"))
        assertEquals("1080", Quality.normalize("garbage"))
        assertEquals("1440", Quality.normalize("1440"))
    }

    @Test fun sortArgs() {
        assertEquals("res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a", Quality.sortArg("1080"))
        assertEquals("res:480,vcodec:h264,acodec:aac,ext:mp4:m4a", Quality.sortArg("480"))
        assertEquals("res,vcodec:h264,acodec:aac,ext:mp4:m4a", Quality.sortArg("best"))
        assertTrue(Quality.sortArg("worst").startsWith("+res"))
        assertEquals(Quality.sortArg("720"), YtdlpSupport.sortArg("720"))
    }

    @Test fun orderPutsPickedRenditionFirstKeepsFallbacks() {
        val urls = listOf("a1080", "b720", "c540", "dunknown")
        val hs = mapOf("a1080" to 1080, "b720" to 720, "c540" to 540)
        assertEquals(urls, Quality.order(urls, hs, "1080"))
        assertEquals(listOf("b720", "a1080", "c540", "dunknown"), Quality.order(urls, hs, "720"))
        assertEquals(listOf("c540", "a1080", "b720", "dunknown"), Quality.order(urls, hs, "worst"))
        assertEquals(listOf("c540", "a1080", "b720", "dunknown"), Quality.order(urls, hs, "360"))
        assertEquals(urls, Quality.order(urls, emptyMap(), "360"))
    }

    @Test fun douyinCandidatesCarryHeights() {
        val video = JSONObject("""{"play_addr":{"uri":"v0200fg10000abc","url_list":["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200fg10000abc&ratio=720p&line=0"]},
            "bit_rate":[{"bit_rate":2000000,"is_h265":0,"play_addr":{"width":1080,"height":1920,"url_list":["https://v3.douyinvod.com/1080.mp4"]}},
                        {"bit_rate":900000,"is_h265":0,"play_addr":{"width":720,"height":1280,"url_list":["https://v3.douyinvod.com/720.mp4"]}}]}""")
        val (urls, hs) = Parser.videoCandidatesWithHeights(video)
        assertEquals("https://v3.douyinvod.com/1080.mp4", urls.first())
        assertEquals(1080, hs["https://v3.douyinvod.com/1080.mp4"])
        assertEquals(720, hs["https://v3.douyinvod.com/720.mp4"])
        assertTrue(urls.any { it.contains("/play/") && it.contains("ratio=540p") })
        assertEquals(540, hs[urls.first { it.contains("ratio=540p") }])
        assertTrue(urls.none { it.contains("playwm") })
        assertEquals("https://v3.douyinvod.com/720.mp4", Quality.order(urls, hs, "720").first())
        assertEquals(540, Quality.pick(hs.values, "480"))
    }

    @Test fun ytdlpHeightsWithSizes() {
        val json = """{"id":"x","duration":60,"formats":[
            {"format_id":"140","vcodec":"none","acodec":"mp4a.40.2","filesize":1000000},
            {"format_id":"sb0","vcodec":"none","acodec":"none","format_note":"storyboard","ext":"mhtml"},
            {"format_id":"134","vcodec":"avc1","acodec":"none","width":640,"height":360,"filesize":3000000},
            {"format_id":"136","vcodec":"avc1","acodec":"none","width":1280,"height":720,"filesize":9000000},
            {"format_id":"18","vcodec":"avc1","acodec":"mp4a","width":640,"height":360,"filesize":5000000},
            {"format_id":"137","vcodec":"avc1","acodec":"none","width":1920,"height":1080,"tbr":2000}]}"""
        val hs = Quality.ytdlpHeights(json)
        assertEquals(listOf(1080, 720, 360), hs.map { it.first })
        assertEquals(10_000_000L, hs.first { it.first == 720 }.second)   // video + best audio
        assertEquals(4_000_000L, hs.first { it.first == 360 }.second)    // smallest of 3 MB+audio / 5 MB muxed
        assertEquals(2000L * 125 * 60 + 1_000_000, hs.first { it.first == 1080 }.second)
    }

    // ---------------------------------------------------------------- YouTube

    @Test fun youtubeIds() {
        assertEquals("yWPrZluVsOA", YtdlpSupport.youtubeId("https://youtu.be/yWPrZluVsOA?si=abc"))
        assertEquals("kVk_Nwca6Wk", YtdlpSupport.youtubeId("https://youtube.com/shorts/kVk_Nwca6Wk?feature=share"))
        assertEquals("jNQXAC9IVRw", YtdlpSupport.youtubeId("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1"))
        assertNull(YtdlpSupport.youtubeId("https://www.youtube.com/@channel"))
    }

    private val botLine = "ERROR: [youtube] yWPrZluVsOA: Sign in to confirm you’re not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication."
    private val noPlayer = "ERROR: [youtube] yWPrZluVsOA: Failed to extract any player response; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template."

    @Test fun blockedVsFinalErrors() {
        assertTrue(YtdlpSupport.ytBlocked(botLine))
        assertTrue(YtdlpSupport.ytBlocked(noPlayer))
        assertTrue(YtdlpSupport.ytBlocked("WARNING: Unable to download API page: HTTP Error 403: Forbidden\nERROR: x"))
        assertFalse(YtdlpSupport.ytBlocked("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video"))
        assertFalse(YtdlpSupport.ytBlocked("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader"))
        assertFalse(YtdlpSupport.ytBlocked("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."))
        assertEquals("要求验证不是机器人", YtdlpSupport.ytReason(botLine))
        assertTrue(YtdlpSupport.ytReason(noPlayer).contains("403"))
    }

    @Test fun summaryNamesEveryStepAndSuggestsFixes() {
        val m = YtdlpSupport.youtubeSummary(listOf(
            YtdlpSupport.YtStep("解析引擎 2026.11.23", "要求验证不是机器人"),
            YtdlpSupport.YtStep("备用客户端（tv / ios / visionos 等）", "IP 被拒绝，拿不到播放信息（403）"),
            YtdlpSupport.YtStep("PO Token 验证", "要求验证不是机器人")), YtdlpSupport.YtAuth.NONE)
        assertTrue(m.contains("1. 解析引擎 2026.11.23：要求验证不是机器人"))
        assertTrue(m.contains("3. PO Token 验证"))
        assertTrue(m.contains("换一个 VPN 节点"))
        assertTrue(m.contains("登录") && m.contains("cookies.txt"))
        assertTrue(YtdlpSupport.youtubeSummary(emptyList(), YtdlpSupport.YtAuth.ROTATED).contains("重新登录"))
    }

    @Test fun potArgs() {
        val a = YtdlpSupport.ytPotArgs("/p", "/t.json", "Cgt123%3D%3D", authenticated = false)
        assertEquals(listOf("--plugin-dirs", "/p", "--extractor-args", "youtubepot-shiying:file=/t.json", "--extractor-args",
            "youtube:player_client=web_safari,mweb,web;visitor_data=Cgt123%3D%3D"), a)
        assertFalse(YtdlpSupport.ytPotArgs("/p", "/t.json", "Cgt", authenticated = true).last().contains("visitor_data"))
        assertTrue(YtdlpSupport.YT_ALT_CLIENTS.startsWith("youtube:player_client=tv"))
    }

    @Test fun youtubeLoginable() {
        assertTrue(Platform.YOUTUBE in Platform.loginable)
        assertTrue("google.com" in Platform.YOUTUBE.cookieDomains && "youtube.com" in Platform.YOUTUBE.cookieDomains)
        assertEquals(Platform.YOUTUBE, Platform.ofUrl("https://youtu.be/yWPrZluVsOA"))
    }

    // ---------------------------------------------------------------- Google login / thumbnails

    @Test fun googleRejection() {
        assertTrue(GoogleLogin.isRejection("https://accounts.google.com/v3/signin/rejected?x=1", ""))
        assertTrue(GoogleLogin.isRejection("https://accounts.google.com/ServiceLogin", "无法登录\n此浏览器或应用可能不安全。"))
        assertTrue(GoogleLogin.isRejection("https://accounts.google.com/x", "Couldn't sign you in. This browser or app may not be secure."))
        assertFalse(GoogleLogin.isRejection("https://accounts.google.com/ServiceLogin", "登录 使用您的 Google 账号"))
        assertFalse(GoogleLogin.isRejection("https://m.youtube.com/", "无法登录"))
        val wv = "Mozilla/5.0 (Linux; Android 14; 23013RK75C Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36"
        assertEquals("Mozilla/5.0 (Linux; Android 14; 23013RK75C Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",
            GoogleLogin.chromeUa(wv))
    }

    @Test fun thumbReferers() {
        assertEquals("https://weibo.com/", Thumbs.refererFor("https://wx3.sinaimg.cn/orj480/abc.jpg", Platform.WEIBO, null))
        assertEquals("https://www.bilibili.com/", Thumbs.refererFor("https://i0.hdslb.com/bfs/archive/x.jpg", Platform.BILIBILI, null))
        assertEquals(Net.REFERER, Thumbs.refererFor("https://p3-sign.douyinpic.com/x~tplv.jpeg", Platform.DOUYIN, null))
        assertNull(Thumbs.refererFor("https://i.ytimg.com/vi/x/hq720.jpg", Platform.YOUTUBE, null))
        assertEquals("https://weibo.com/", Thumbs.refererFor("https://cdn.example.com/x.jpg", Platform.WEIBO, null))
    }
}
