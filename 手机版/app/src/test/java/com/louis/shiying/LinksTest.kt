package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test

class LinksTest {
    @Test fun shareText() {
        val t = "7.43 复制打开抖音，看看【小轨的作品】过年啦！# 嘉桐摇 # 卡点舞 https://v.douyin.com/f-QpBB_oD9Y/ x@F.ub 01/20 vSl:/ "
        assertEquals("https://v.douyin.com/f-QpBB_oD9Y/", Links.findUrl(t))
        assertTrue(Links.looksLikeDouyin(t))
        assertNull(Links.idFromUrl(Links.findUrl(t)!!))
    }
    @Test fun ids() {
        assertEquals("7578030072632839465", Links.idFromUrl("https://www.douyin.com/video/7578030072632839465"))
        assertEquals("7643104807914401929", Links.idFromUrl("https://www.douyin.com/note/7643104807914401929?previous_page=app_code_link"))
        assertEquals("7578030072632839465", Links.idFromUrl("https://www.iesdouyin.com/share/video/7578030072632839465/?region=CN&mid=1"))
        assertEquals("7578030072632839465", Links.idFromUrl("https://www.douyin.com/user/MS4wLjAB?modal_id=7578030072632839465"))
        assertEquals("7578030072632839465", Links.idFromUrl("https://www.douyin.com/discover?modal_id=7578030072632839465"))
        assertEquals("7578030072632839465", Links.idFromUrl("https://m.douyin.com/share/video/7578030072632839465"))
        assertEquals("7578030072632839465", Links.bareId(" 7578030072632839465 "))
        assertNull(Links.findUrl("没有链接"))
        assertFalse(Links.looksLikeDouyin("https://www.bilibili.com/video/BV1"))
        assertTrue(Links.isDouyin("https://www.iesdouyin.com/share/note/1/"))
    }
    @Test fun trailingPunct() {
        assertEquals("https://v.douyin.com/abc/", Links.findUrl("看看 https://v.douyin.com/abc/，复制此链接"))
        assertEquals("https://v.douyin.com/abc", Links.findUrl("(https://v.douyin.com/abc)."))
    }
    @Test fun fileName() {
        assertEquals("睦月-黛玉良技能推测-7578030072632839465", Links.fileBase("睦月", "黛玉良技能推测\n#边狱公司", "7578030072632839465"))
        assertEquals("a b-x y-1", Links.fileBase("a/b", "x:y?", "1"))
        assertEquals("抖音-边狱公司-1", Links.fileBase("", "#边狱公司", "1"))
        assertTrue(Links.fileBase("作者", "很长".repeat(100), "1").length < 100)
    }
}
