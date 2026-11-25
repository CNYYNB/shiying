package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test

class ParserTest {
    private fun fx(n: String) = javaClass.getResource("/fixtures/$n.html")!!.readText()

    @Test fun video() {
        val s = Parser.parseSharePage(fx("video"))
        assertTrue(s is Parser.Share.Item)
        val p = Parser.fromItem((s as Parser.Share.Item).item, "分享页")
        assertFalse(p.isImages)
        assertEquals("7578030072632839465", p.id)
        assertEquals("睦月", p.author)
        assertTrue(p.durationMs > 90_000)
        assertNotNull(p.cover)
        assertTrue(p.videoUrls.isNotEmpty())
        val first = p.videoUrls.first()
        assertTrue(first, first.contains("/aweme/v1/play/") && !first.contains("playwm") && first.contains("ratio=1080p"))
        assertTrue(p.videoUrls.any { it.contains("ratio=720p") })
        assertTrue(p.videoUrls.none { it.contains("playwm") })
        assertEquals("1:39", Parser.formatDuration(p.durationMs))
    }

    @Test fun note() {
        val s = Parser.parseSharePage(fx("note")) as Parser.Share.Item
        val p = Parser.fromItem(s.item, "分享页")
        assertTrue(p.isImages)
        assertEquals(3, p.images.size)
        assertTrue(p.videoUrls.isEmpty())
        for (im in p.images) {
            assertTrue(im.urls.first(), im.urls.first().contains(".jpeg"))         // jpeg preferred
            assertTrue(im.urls.none { it.contains("water") })                      // never the watermarked download_url_list
        }
    }

    @Test fun filtered() {
        val a = Parser.parseSharePage(fx("selfsee")) as Parser.Share.Filtered
        assertEquals("status_self_see", a.reason)
        assertTrue(Parser.unavailable(a.reason).final)
        val b = Parser.parseSharePage(fx("secret")) as Parser.Share.Filtered
        val ub = Parser.unavailable(b.reason, b.notice, b.detail)
        assertTrue(ub.final); assertTrue(ub.message!!.contains("私密"))
        val c = Parser.parseSharePage(fx("notexist")) as Parser.Share.Filtered
        assertTrue(Parser.unavailable(c.reason).message!!.contains("删除"))
        assertFalse(Parser.unavailable("some_new_reason", "要登录").final)
    }

    @Test fun shellPageHasNoData() {
        assertTrue(Parser.parseSharePage(fx("shell")) is Parser.Share.NoData)
        assertTrue(Parser.parseSharePage("<html></html>") is Parser.Share.NoData)
    }

    @Test fun playUrl() {
        assertEquals("https://aweme.snssdk.com/aweme/v1/play/?video_id=x&ratio=1080p&line=0",
            Parser.playUrl("https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x&ratio=720p&line=0", "1080p"))
        assertEquals("https://a/aweme/v1/play/?video_id=x&ratio=1080p", Parser.playUrl("https://a/aweme/v1/playwm/?video_id=x", "1080p"))
    }

    @Test fun webDetail() {
        // Shape of /aweme/v1/web/aweme/detail/ (as captured by the WebView fallback).
        val j = """{"status_code":0,"aweme_detail":{"aweme_id":"123","desc":"标题 #话题","author":{"nickname":"作者"},
          "video":{"duration":15000,"cover":{"url_list":["https://p3/c.jpeg"]},
            "play_addr":{"uri":"v0200","url_list":["https://v3-web.douyinvod.com/low.mp4"]},
            "bit_rate":[
              {"gear_name":"normal_540_0","bit_rate":800000,"is_h265":0,"play_addr":{"height":1024,"width":576,"url_list":["https://v26-web.douyinvod.com/540.mp4"]}},
              {"gear_name":"normal_1080_0","bit_rate":2500000,"is_h265":0,"play_addr":{"height":1920,"width":1080,"url_list":["https://v26-web.douyinvod.com/1080.mp4","https://v3-web.douyinvod.com/1080b.mp4"]}},
              {"gear_name":"1080_h265","bit_rate":1800000,"is_h265":1,"play_addr":{"height":1920,"width":1080,"url_list":["https://v26-web.douyinvod.com/1080h265.mp4"]}}
            ]}}}"""
        val p = Parser.fromWebDetail(j, "123")!!
        assertEquals("https://v26-web.douyinvod.com/1080.mp4", p.videoUrls[0])
        assertEquals("https://v26-web.douyinvod.com/1080h265.mp4", p.videoUrls[2])
        assertTrue(p.videoUrls.indexOf("https://v26-web.douyinvod.com/540.mp4") > 2)
        assertEquals("网页", p.source)
        assertNull(Parser.fromWebDetail(j, "999"))
        val live = """{"aweme_detail":{"aweme_id":"5","desc":"d","author":{"nickname":"a"},"images":[
          {"url_list":["https://p/1.webp","https://p/1.jpeg"],"download_url_list":["https://p/1~tplv-dy-water.jpeg"],
           "video":{"play_addr":{"url_list":["https://v3-web.douyinvod.com/live1.mp4"]}}},
          {"url_list":["https://p/2.jpeg"]}]}}"""
        val q = Parser.fromWebDetail(live, "5")!!
        assertTrue(q.isImages); assertEquals(2, q.images.size); assertEquals(1, q.liveCount)
        assertEquals("https://p/1.jpeg", q.images[0].urls[0])
        assertEquals("https://v3-web.douyinvod.com/live1.mp4", q.images[0].liveVideoUrls[0])
    }
}
