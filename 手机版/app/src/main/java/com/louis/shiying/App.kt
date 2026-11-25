package com.louis.shiying

import android.app.Application
import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            CookieManager.getInstance().setAcceptCookie(true)
            Net.cookieJar = WebkitCookieJar()
        } catch (e: Throwable) {
            // WebView missing/updating: keep the in-memory jar, primary extraction still works.
        }
        Cookies.appCtx = this
        Engine.initAsync(this)
        Tg.init(this)
        DownloadService.ensureChannel(this)
        History.fixStale(this, DownloadService.active)
    }
}

/** OkHttp cookies stored in the WebView CookieManager, so login + fallback + downloads share one session. */
class WebkitCookieJar : CookieJar {
    private val cm = CookieManager.getInstance()
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) runCatching { cm.setCookie(url.toString(), c.toString()) }
        runCatching { cm.flush() }
    }
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val s = runCatching { cm.getCookie(url.toString()) }.getOrNull() ?: return emptyList()
        return s.split(';').mapNotNull { part -> Cookie.parse(url, part.trim()) }
    }
}

object Login {
    /** True if the WebView has a douyin.com session cookie. */
    fun isLoggedIn(): Boolean = runCatching {
        val c = CookieManager.getInstance().getCookie("https://www.douyin.com/") ?: ""
        Regex("""(^|;\s*)(sessionid|sessionid_ss|sid_tt)=[^;]+""").containsMatchIn(c)
    }.getOrDefault(false)

    fun logout() {
        runCatching {
            val cm = CookieManager.getInstance()
            cm.removeAllCookies(null); cm.flush()
        }
        Cookies.appCtx?.let { c -> Platform.entries.forEach { Cookies.importedFile(c, it).delete(); java.io.File(c.filesDir, "cookies-work-${it.name.lowercase()}.txt").delete() } }
    }
}
