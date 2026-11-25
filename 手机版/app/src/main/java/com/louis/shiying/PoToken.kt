package com.louis.shiying

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * YouTube PO Token (proof-of-origin) via a hidden WebView that runs YouTube's BotGuard (assets/potoken.js).
 * Tokens are minted for the video id, the visitor data and the datasync id, written to a JSON file and picked up by the
 * bundled yt-dlp provider plugin (assets/ytdlp-plugins, provider "shiying").
 */
object PoToken {
    /** Desktop Chrome UA: the desktop homepage carries the BotGuard challenge (mobile UA is redirected to m.youtube.com). */
    private const val UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    data class Result(val file: File, val visitorData: String, val loggedIn: Boolean, val dataSyncId: String = "")

    /** Copies the yt-dlp plugin out of the APK; returns the directory for --plugin-dirs. */
    fun pluginDir(ctx: Context): File {
        val root = File(ctx.filesDir, "ytdlp-plugins")
        val f = File(root, "shiying/yt_dlp_plugins/extractor/shiying_pot.py")
        val stamp = File(root, ".v${Updater.currentCode}")
        if (!f.exists() || !stamp.exists()) {
            root.deleteRecursively(); f.parentFile?.mkdirs()
            ctx.assets.open("ytdlp-plugins/shiying/yt_dlp_plugins/extractor/shiying_pot.py").use { i -> f.outputStream().use { i.copyTo(it) } }
            stamp.writeText("1")
        }
        return root
    }

    /** Blocking (call off the main thread). Throws [UserError]-free exceptions with a short reason on failure. */
    fun mint(ctx: Context, videoIds: List<String>, timeoutSec: Long = 35): Result {
        check(Looper.myLooper() != Looper.getMainLooper())
        val app = ctx.applicationContext
        val js = app.assets.open("potoken.js").bufferedReader().use { it.readText() }
        val done = CountDownLatch(1)
        var out: String? = null
        var err: String? = null
        var web: WebView? = null
        val main = Handler(Looper.getMainLooper())
        main.post {
            try {
                web = create(app).apply {
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String?) {
                            if (out != null || err != null) return
                            view.evaluateJavascript(js) { _ ->
                                // evaluateJavascript cannot await a Promise: the result comes back through the JS bridge.
                                view.evaluateJavascript("shiyingPot(${org.json.JSONArray(videoIds)}).then(function(r){ShiyingPot.done(r)});", null)
                            }
                        }
                    }
                    addJavascriptInterface(object {
                        @android.webkit.JavascriptInterface fun done(r: String) { out = r; done.countDown() }
                    }, "ShiyingPot")
                    loadDataWithBaseURL("https://www.youtube.com/", "<!DOCTYPE html><html><head></head><body></body></html>", "text/html", "utf-8", null)
                }
            } catch (e: Throwable) { err = "WebView 不可用（${e.javaClass.simpleName}）"; done.countDown() }
        }
        val ok = done.await(timeoutSec, TimeUnit.SECONDS)
        main.post { runCatching { web?.stopLoading(); web?.destroy() } }
        err?.let { throw IllegalStateException(it) }
        if (!ok || out == null) throw IllegalStateException("生成超时")
        val o = JSONObject(out!!)
        if (!o.optBoolean("ok")) throw IllegalStateException(o.optString("error").take(100))
        val tokens = o.optJSONObject("tokens") ?: JSONObject()
        if (tokens.length() == 0) throw IllegalStateException("没有生成任何 token")
        val ttl = o.optLong("ttl", 21600).coerceIn(600, 43200)
        val f = File(app.cacheDir, "potokens.json")
        f.writeText(JSONObject().put("tokens", tokens).put("visitorData", o.optString("visitorData"))
            .put("expires", System.currentTimeMillis() / 1000 + ttl - 300).toString())
        return Result(f, o.optString("visitorData"), o.optBoolean("loggedIn"), o.optString("dataSyncId"))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(ctx: Context): WebView = WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.userAgentString = UA_DESKTOP
        settings.blockNetworkImage = true
        runCatching { CookieManager.getInstance().setAcceptThirdPartyCookies(this, true) }
    }
}
