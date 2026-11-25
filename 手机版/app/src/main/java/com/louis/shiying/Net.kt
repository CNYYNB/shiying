package com.louis.shiying

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

object Net {
    const val UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
    const val UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    const val REFERER = "https://www.douyin.com/"

    /** Replaced in App.onCreate by a jar that shares cookies with the WebView (login + fallback). */
    @Volatile var cookieJar: CookieJar = MemoryCookieJar()

    /** Tests can install a client with a proxy here before first use. */
    @Volatile var clientOverride: OkHttpClient? = null

    private val base: OkHttpClient by lazy { build(OkHttpClient.Builder()) }

    fun build(b: OkHttpClient.Builder): OkHttpClient = b
        .cookieJar(object : CookieJar {   // indirection so the jar can be swapped after the client is built
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = cookieJar.saveFromResponse(url, cookies)
            override fun loadForRequest(url: HttpUrl): List<Cookie> = cookieJar.loadForRequest(url)
        })
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** Client for API/page requests (40 s hard ceiling per call). */
    val api: OkHttpClient get() = clientOverride ?: base

    /** Client for large media downloads: no overall call timeout, generous read timeout. */
    val media: OkHttpClient by lazy {
        api.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    }

    class Fetched(val code: Int, val finalUrl: String, val body: String)

    /** GET following redirects; returns the final URL too. Throws IOException on network errors / HTTP ≥ 500. */
    fun fetch(url: String, ua: String, referer: String? = null): Fetched {
        val b = okhttp3.Request.Builder().url(url).header("User-Agent", ua).header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        if (referer != null) b.header("Referer", referer)
        api.newCall(b.get().build()).execute().use { r ->
            if (r.code >= 500) throw java.io.IOException("HTTP ${r.code}")
            return Fetched(r.code, r.request.url.toString(), r.body?.string().orEmpty())
        }
    }

    /** Same as [api] but redirects are handled by the caller (to watch every hop of a short link). */
    val noRedirect: OkHttpClient by lazy { api.newBuilder().followRedirects(false).followSslRedirects(false).build() }
}

/** Simple in-memory jar (JVM tests, and before App installs the WebView-backed jar). */
class MemoryCookieJar : CookieJar {
    private val store = ConcurrentHashMap<String, Cookie>()
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) store["${c.domain}|${c.path}|${c.name}"] = c
    }
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        store.values.removeIf { it.expiresAt < now }
        return store.values.filter { it.matches(url) }
    }
    fun names(): List<String> = store.values.map { it.name }
}
