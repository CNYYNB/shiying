package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test

class KuaishouXhsTest {
    private fun res(name: String) = javaClass.classLoader!!.getResource("fixtures/$name")!!.readText()

    // ---------------------------------------------------------------- 快手 (real share-page HTML saved from v.m.chenzhongtech.com, Nov 2026)

    @Test fun kuaishouIds() {
        assertEquals("3xqensd76nig6nw", Kuaishou.idFromUrl("https://www.kuaishou.com/short-video/3xqensd76nig6nw?authorId=3x"))
        assertEquals("3xbfgiys9bhs9em", Kuaishou.idFromUrl("https://v.m.chenzhongtech.com/fw/photo/3xbfgiys9bhs9em?cc=share_copylink&photoId=3xbfgiys9bhs9em"))
        assertNull(Kuaishou.idFromUrl("https://v.kuaishou.com/2DV5QWg"))
    }

    @Test fun kuaishouVideoPage() {
        val r = Kuaishou.parsePage(res("ks_video.html"), "3xqensd76nig6nw")
        assertTrue(r is Kuaishou.Page.Ok)
        val p = (r as Kuaishou.Page.Ok).post
        assertEquals(Platform.KUAISHOU, p.platform)
        assertFalse(p.isImages)
        assertEquals("丨狐说", p.author)
        assertTrue(p.title.startsWith("黑色导弹"))
        assertEquals(185100L, p.durationMs)
        assertTrue(p.videoUrls.isNotEmpty())
        assertTrue(p.videoUrls.all { it.contains(".mp4") })          // never the HLS playlists
        assertTrue(p.videoUrls.first().contains("kwimgs.com"))
        assertEquals("https://www.kuaishou.com/short-video/3xqensd76nig6nw", p.pageUrl)
        assertNotNull(p.headers["Referer"])
    }

    @Test fun kuaishouUnderReview() {
        val r = Kuaishou.parsePage(res("ks_review.html"), "3xbfgiys9bhs9em")
        assertTrue(r is Kuaishou.Page.Error)
        assertEquals("快手：作品在审核中，请稍后观看。", Kuaishou.errorText((r as Kuaishou.Page.Error).code, r.msg))
    }

    @Test fun kuaishouAtlasShape() {
        // Shape of an atlas (图集) photo object as documented by public parsers (no real atlas post could be found to save).
        val html = """<script>window.INIT_STATE = {"x":{"photo":{"photoId":"3xatlas","caption":"图集","userName":"u","photoType":"VERTICAL_ATLAS",
            "ext_params":{"atlas":{"cdn":["p2.a.yximgs.com"],"list":["/ufile/atlas/a_0.jpg","/ufile/atlas/a_1.jpg"],"music":"/m.m4a"}},
            "coverUrls":[{"cdn":"p2.a.yximgs.com","url":"https://p2.a.yximgs.com/c.jpg"}]}}}</script>"""
        val p = (Kuaishou.parsePage(html, "3xatlas") as Kuaishou.Page.Ok).post
        assertTrue(p.isImages)
        assertEquals(2, p.images.size)
        assertEquals("https://p2.a.yximgs.com/ufile/atlas/a_1.jpg", p.images[1].urls[0])
    }

    @Test fun kuaishouNoState() {
        assertTrue(Kuaishou.parsePage("<html>captcha</html>", null) is Kuaishou.Page.NoData)
    }

    // ---------------------------------------------------------------- 小红书 (synthetic fixtures in the documented __INITIAL_STATE__ shape;
    // xiaohongshu.com redirects the sandbox's US IP to a rednote 404 page, so no live page could be saved)

    private val videoNote = """<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a6310ee000000001003f430":{"note":{
        "noteId":"6a6310ee000000001003f430","type":"video","title":"标题","desc":"正文 #话题","user":{"nickname":"小红"},
        "imageList":[{"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/0123abcd/1040g2sg31abc!nd_dft_wlteh_webp_3"}],
        "video":{"consumer":{"originVideoKey":"pre_post/1040g2t031origin"},"capa":{"duration":12},
          "media":{"stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/stream/720.mp4","width":720,"height":1280,"backupUrls":[]},
                                      {"masterUrl":"http://sns-video-bd.xhscdn.com/stream/1080.mp4","width":1080,"height":1920}],
                             "h265":[{"masterUrl":"http://sns-video-bd.xhscdn.com/stream/1080h265.mp4","width":1080,"height":1920}]}}}}}},
        "serverRequestInfo":undefined}}</script>"""

    @Test fun xhsVideoNote() {
        val r = Xhs.parsePage(videoNote, "6a6310ee000000001003f430", "https://www.xiaohongshu.com/explore/6a6310ee000000001003f430?xsec_token=x")
        val p = (r as Xhs.Page.Ok).post
        assertFalse(p.isImages)
        assertEquals("小红", p.author)
        assertEquals(12000L, p.durationMs)
        assertEquals("https://sns-video-bd.xhscdn.com/pre_post/1040g2t031origin", p.videoUrls[0])  // original upload first
        assertEquals("http://sns-video-bd.xhscdn.com/stream/1080.mp4", p.videoUrls[1])              // then best H.264
        assertTrue(p.videoUrls.indexOf("http://sns-video-bd.xhscdn.com/stream/1080h265.mp4") > p.videoUrls.indexOf("http://sns-video-bd.xhscdn.com/stream/1080.mp4"))
    }

    @Test fun xhsImageNoteWithLivePhoto() {
        val html = """<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a9d0eb2000000002a024480":{"note":{
            "noteId":"6a9d0eb2000000002a024480","type":"normal","title":"图文","desc":"","user":{"nickname":"n"},
            "imageList":[{"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/hash1/notes_pre_post/1040g3k0tokenA!nd_dft_wlteh_webp_3","livePhoto":false},
                         {"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611251530/hash2/1040g2sgtokenB!nd_dft_wlteh_webp_3","livePhoto":true,
                          "stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/live/b.mp4"}],"h265":[]}}]}}}}}</script>"""
        val p = (Xhs.parsePage(html, "6a9d0eb2000000002a024480", "u") as Xhs.Page.Ok).post
        assertTrue(p.isImages)
        assertEquals(2, p.images.size)
        assertEquals("https://sns-img-bd.xhscdn.com/notes_pre_post/1040g3k0tokenA", p.images[0].urls[0])
        assertTrue(p.images[0].liveVideoUrls.isEmpty())
        assertEquals(listOf("http://sns-video-bd.xhscdn.com/live/b.mp4"), p.images[1].liveVideoUrls)
        assertEquals(1, p.liveCount)
    }

    @Test fun xhsMobileShape() {
        val html = """<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"6a9d0eb2000000002a024480","type":"normal",
            "title":"t","user":{"nickName":"m"},"imageList":[{"url":"https://sns-webpic-qc.xhscdn.com/202611251530/h/tokenC!nd_whgt34_webp_wm_1"}]}}}}</script>"""
        val p = (Xhs.parsePage(html, "6a9d0eb2000000002a024480", "u") as Xhs.Page.Ok).post
        assertEquals("m", p.author)
        assertEquals("https://sns-img-bd.xhscdn.com/tokenC", p.images[0].urls[0])
    }

    @Test fun xhsTokenAndIds() {
        assertEquals("1040g2sg31abc", Xhs.imageToken("http://sns-webpic-qc.xhscdn.com/202611251530/0123abcd/1040g2sg31abc!nd_dft_wlteh_webp_3"))
        assertEquals("spectrum/1040g0k0x", Xhs.imageToken("https://sns-img-bd.xhscdn.com/spectrum/1040g0k0x?imageView2/2/w/1080"))
        assertEquals("6a6310ee000000001003f430", Xhs.noteId("https://www.xiaohongshu.com/discovery/item/6a6310ee000000001003f430?app_platform=android&xsec_token=CB"))
        assertNull(Xhs.noteId("https://xhslink.cn/o/AxnRePgIokn"))
        assertTrue(Xhs.parsePage("<html></html>", "x", "u") is Xhs.Page.NoData)
        assertTrue(Xhs.secMessage("https://www.rednote.com/404/sec_x?source=xhs_sec_server").contains("海外"))
    }
}
