package com.louis.shiying

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2.2: YTDLnis-parity first attempt, real login detection, verbose-safe classification, diagnostics redaction. */
class V22Test {
    private fun res(n: String) = javaClass.classLoader!!.getResource(n)!!.readText()

    @Test fun firstYoutubeAttemptMatchesYtdlnisDefaults() {
        val o = YtdlpSupport.infoOptions(Platform.YOUTUBE, "1080", null)
        assertFalse("no player_client override on the first attempt", o.any { it.contains("player_client") })
        assertFalse(o.contains("--extractor-args"))
        assertFalse(o.contains("--proxy"))
        assertFalse("no cookies when not logged in", o.contains("--cookies"))
        assertTrue(o.contains("--no-check-certificates"))
        assertTrue("verbose for the diagnostics log", o.contains("-v") && !o.contains("--no-warnings"))
        assertTrue(YtdlpSupport.infoOptions(Platform.YOUTUBE, "1080", "/c.txt").containsAll(listOf("--cookies", "/c.txt")))
        // other platforms unchanged
        assertTrue(YtdlpSupport.infoOptions(Platform.TIKTOK, "1080", null).contains("--no-warnings"))
        assertFalse(YtdlpSupport.infoOptions(Platform.WEIBO, "1080", null).contains("-v"))
    }

    @Test fun anonymousCookiesAreNotALogin() {
        assertFalse(CookieText.youtubeAuth(listOf("VISITOR_INFO1_LIVE", "YSC", "PREF", "VISITOR_PRIVACY_METADATA", "__Secure-ROLLOUT_TOKEN")))
        assertFalse("SAPISID without LOGIN_INFO is not enough for yt-dlp", CookieText.youtubeAuth(listOf("SAPISID", "SID", "__Secure-3PSID")))
        assertTrue(CookieText.youtubeAuth(listOf("LOGIN_INFO", "__Secure-3PAPISID", "YSC")))
        assertTrue(CookieText.youtubeAuth(listOf("LOGIN_INFO", "SAPISID")))
    }

    @Test fun netscapeLinesAndImportedNames() {
        assertEquals(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tLOGIN_INFO\tAFmm:QU=Q", CookieText.line("youtube.com", "LOGIN_INFO", "AFmm:QU=Q", 1800000000))
        assertEquals(listOf("a" to "1", "b" to "x=y=", "c" to ""), CookieText.pairs("a=1; b=x=y=; c=; =bad"))
        val ext = "# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tv\n" +
            ".youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PAPISID\tv\n.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\tg\nwww.youtube.com\tFALSE\t/\tFALSE\t0\tYSC\ty\n"
        assertEquals(setOf("LOGIN_INFO", "__Secure-3PAPISID", "YSC"), CookieText.youtubeNames(ext))
        assertTrue(CookieText.youtubeAuth(CookieText.youtubeNames(ext)))
    }

    private val verbose = """
[debug] Command-line config: ['-v', '--no-playlist', 'https://www.youtube.com/watch?v=kVk_Nwca6Wk']
[debug] [youtube] [pot] PO Token Providers: shiying-1.0.0 (external)
[debug] [youtube] [jsc] JS Challenge Providers: quickjs
[debug] Loading youtube-nsig.abc from cache; cookies were sent; sign in state unknown
[youtube] kVk_Nwca6Wk: Downloading tv samsung player API JSON
""".trimIndent()

    @Test fun debugLinesAreNotClassified() {
        val privateVid = "$verbose\nERROR: [youtube] kVk_Nwca6Wk: Private video. Sign in if you've been granted access to this video"
        assertFalse(YtdlpSupport.ytBlocked(privateVid))
        assertEquals("这是私密内容，无法下载（YouTube）", YtdlpSupport.errorMessage(privateVid, Platform.YOUTUBE))
        val bot = "$verbose\nERROR: [youtube] kVk_Nwca6Wk: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."
        assertTrue(YtdlpSupport.ytBlocked(bot))
        assertEquals("要求验证不是机器人", YtdlpSupport.ytReason(bot))
        assertFalse(YtdlpSupport.jsProblem(bot))
    }

    @Test fun jsChallengeFailureIsNotABotCheck() {
        val js = "$verbose\nWARNING: [youtube] kVk_Nwca6Wk: n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime and challenge solver script distribution installed.\n" +
            "ERROR: [youtube] kVk_Nwca6Wk: Requested format is not available. Use --list-formats for a list of available formats"
        assertTrue(YtdlpSupport.jsProblem(js))
        assertTrue(YtdlpSupport.ytBlocked(js))
        assertTrue(YtdlpSupport.ytReason(js).contains("JS"))
        assertTrue(YtdlpSupport.youtubeSummary(listOf(YtdlpSupport.YtStep("a", "b")), YtdlpSupport.YtAuth.NONE, js = true).contains("更新解析引擎"))
    }

    @Test fun networkErrorsAreDetected() {
        assertTrue(YtdlpSupport.netProblem("ERROR: [youtube] x: Unable to download API page: <urlopen error [Errno 7] No address associated with hostname> (caused by TransportError)"))
        assertTrue(YtdlpSupport.netProblem("ERROR: [youtube] x: Unable to download webpage: The read operation timed out"))
        assertFalse(YtdlpSupport.netProblem("ERROR: [youtube] x: Sign in to confirm you’re not a bot"))
    }

    @Test fun realVerboseLogFromYtdlp() {
        val log = res("yt/verbose-rotated-403.txt")   // yt-dlp 2026.11.23 -v, fake account cookies, sandbox IP (403)
        assertEquals(YtdlpSupport.YtAuth.ROTATED, YtdlpSupport.ytAuth(log))
        assertTrue(YtdlpSupport.ytBlocked(log))
        assertTrue(YtdlpSupport.ytReason(log).contains("403"))
        assertEquals(YtdlpSupport.YtAuth.OK, YtdlpSupport.ytAuth("[debug] [youtube] Found YouTube account cookies\n"))
        assertEquals(YtdlpSupport.YtAuth.NONE, YtdlpSupport.ytAuth(verbose))
    }

    @Test fun summaryReportsTheRealLoginState() {
        val steps = listOf(YtdlpSupport.YtStep("默认", "要求验证不是机器人"))
        assertTrue(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE).contains("未登录 YouTube"))
        assertFalse(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE).contains("已带上"))
        assertTrue(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.OK).contains("已带上 YouTube 登录状态"))
        assertTrue(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.ROTATED).contains("已失效"))
        assertTrue(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE).contains("复制诊断日志"))
    }

    @Test fun potArgsBindToVisitorOrDataSyncId() {
        assertTrue(YtdlpSupport.ytPotArgs("/p", "/t", "VD", authenticated = false, dataSyncId = "DS").last().endsWith(";visitor_data=VD"))
        assertTrue(YtdlpSupport.ytPotArgs("/p", "/t", "VD", authenticated = true, dataSyncId = "DS").last().endsWith(";data_sync_id=DS"))
        assertFalse(YtdlpSupport.ytPotArgs("/p", "/t", "VD", authenticated = true, dataSyncId = "").last().contains("="+"VD"))
    }

    @Test fun redactionHidesTokensAndKeepsTheStory() {
        val tok = "MnQBj8Fp0TrB2Zyx" + "a".repeat(80)
        val log = "[debug] Command-line config: ['--extractor-args', 'youtube:player_client=web;visitor_data=CgtVaXNpdG9yRGF0YTEyMw%3D%3D', " +
            "'--cookies', '/data/user/0/com.louis.shiying/cache/cookies-youtube.txt']\n" +
            "[debug] [youtube] x: Retrieved a gvs PO Token for web client: $tok\n" +
            "Authorization: SAPISIDHASH 1732500000_abcdef0123456789abcdef0123456789abcdef01\n" +
            "ERROR: [youtube] kVk_Nwca6Wk: Sign in to confirm you’re not a bot."
        val r = YtdlpSupport.redact(log)
        assertFalse(r.contains("CgtVaXNpdG9yRGF0YTEyMw"))
        assertFalse(r.contains(tok))
        assertFalse(r.contains("abcdef0123456789abcdef"))
        assertTrue(r.contains("Sign in to confirm you’re not a bot"))
        assertTrue(r.contains("kVk_Nwca6Wk"))
        assertTrue(r.contains("cookies-youtube.txt"))
        assertNull(null)
    }
}
