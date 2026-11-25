package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test

class PlatformTest {
    private fun d(t: String) = Links.detect(t)

    @Test fun detectShareTexts() {
        assertEquals(Platform.DOUYIN, d("7.43 复制打开抖音，看看【小轨的作品】https://v.douyin.com/f-QpBB_oD9Y/ x@F.ub"))
        assertEquals(Platform.DOUYIN, d("7641191614632071546"))
        assertEquals(Platform.KUAISHOU, d("https://v.kuaishou.com/fXqlD6 “谁说站在光里的才算英雄” 复制此消息，打开【快手】直接观看！"))
        assertEquals(Platform.KUAISHOU, d("https://www.kuaishou.com/short-video/3xqensd76nig6nw?authorId=3x"))
        assertEquals(Platform.XIAOHONGSHU, d("90 麦香发布了一篇小红书笔记，快来看吧！ 😆 ZMvkU4FkbGqvkLq 😆 http://xhslink.com/a/7o7zKxL5B7GZ，复制本条信息，打开【小红书】App查看精彩内容！"))
        assertEquals(Platform.XIAOHONGSHU, d("xhslink.cn/o/AxnRePgIokn"))   // no scheme (iOS share)
        assertEquals(Platform.BILIBILI, d("【【官方MV】Never Gonna Give You Up - Rick Astley】 https://b23.tv/BV1GJ411x7h7"))
        assertEquals(Platform.BILIBILI, d("https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web"))
        assertEquals(Platform.WEIBO, d("https://weibo.com/7827771738/N4xlMvjhI"))
        assertEquals(Platform.WEIBO, d("https://m.weibo.cn/status/4189191225395228"))
        assertEquals(Platform.XIGUA, d("https://www.ixigua.com/6996881461559165471"))
        assertEquals(Platform.TOUTIAO, d("https://www.toutiao.com/video/7505382061495176511/"))
        assertEquals(Platform.YOUTUBE, d("https://youtu.be/jNQXAC9IVRw?si=abc"))
        assertEquals(Platform.YOUTUBE, d("https://youtube.com/shorts/7Fc9Ry0V1OI?feature=share"))
        assertEquals(Platform.TIKTOK, d("https://vt.tiktok.com/ZSabc123/"))
        assertEquals(Platform.INSTAGRAM, d("https://www.instagram.com/reel/Chunk8-jurw/?igsh=MWQ1"))
        assertEquals(Platform.X, d("https://x.com/SpaceX/status/1732824684683784516?s=20"))
        assertEquals(Platform.X, d("https://twitter.com/SpaceX/status/1732824684683784516"))
        assertEquals(Platform.FACEBOOK, d("https://www.facebook.com/share/r/1Abc/"))
        assertEquals(Platform.FACEBOOK, d("https://fb.watch/abcd/"))
        assertEquals(Platform.VIMEO, d("https://vimeo.com/76979871"))
        assertEquals(Platform.OTHER, d("https://www.dailymotion.com/video/x8abc"))
        assertNull(d("没有链接的文字"))
    }

    @Test fun hostMatchingIsSuffixSafe() {
        assertEquals(Platform.OTHER, Platform.ofHost("notyoutube.com"))
        assertEquals(Platform.OTHER, Platform.ofHost("myx.com"))
        assertEquals(Platform.X, Platform.ofHost("mobile.x.com"))
        assertEquals(Platform.BILIBILI, Platform.ofHost("m.bilibili.com"))
    }

    @Test fun prefersKnownPlatformUrl() {
        assertEquals("https://b23.tv/abcdefg", Links.findUrl("见 https://example.com/x 和 https://b23.tv/abcdefg"))
        assertTrue(Links.looksSupported("https://www.instagram.com/p/BQ0eAlwhDrw/"))
        assertFalse(Links.looksSupported("https://example.com/a"))
    }

    @Test fun normalizeAndExpand() {
        assertEquals("https://www.toutiao.com/video/6996881461559165471/", YtdlpSupport.normalizeUrl("https://www.ixigua.com/6996881461559165471?logTag=1"))
        assertEquals("https://www.youtube.com/watch?v=7Fc9Ry0V1OI", YtdlpSupport.normalizeUrl("https://youtube.com/shorts/7Fc9Ry0V1OI?feature=share"))
        assertEquals("https://www.toutiao.com/video/7505382061495176511/", YtdlpSupport.normalizeUrl("https://www.toutiao.com/video/7505382061495176511/"))
        assertTrue(YtdlpSupport.needsExpand("https://b23.tv/BV1GJ411x7h7"))
        assertTrue(YtdlpSupport.needsExpand("https://t.cn/A6abc"))
        assertFalse(YtdlpSupport.needsExpand("https://www.bilibili.com/video/BV1GJ411x7h7"))
    }

    @Test fun fileBaseForOtherPlatforms() {
        assertEquals("哔哩哔哩-作品-BV1GJ411x7h7", Links.fileBase("", "", "BV1GJ411x7h7", "哔哩哔哩"))
        assertEquals("a-b-BV12x", Links.fileBase("a", "b", "BV1:2/x"))
        assertEquals("a-b", Links.fileBase("a", "b", "::"))
    }
}
