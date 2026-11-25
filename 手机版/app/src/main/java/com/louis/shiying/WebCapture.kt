package com.louis.shiying

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * Fallback extractor: lets a WebView open the post on www.douyin.com like a normal viewer, and captures
 *  - the aweme detail JSON the page fetches (fetch/XHR hooked by an injected script),
 *  - the SSR data embedded in the page (RENDER_DATA / _ROUTER_DATA),
 *  - any mp4 request the page makes (douyinvod / zjcdn …) via shouldInterceptRequest / <video> src.
 * Cookies live in the shared WebView CookieManager, so a login done in 登录抖音 is used here too, and the
 * OkHttp jar (WebkitCookieJar) sends the same cookies when downloading.
 * All methods must be called on the main thread.
 */
class WebCapture(
    private val web: WebView,
    private val wantId: String?,
    private val onEvent: (Event) -> Unit,
) {
    sealed class Event {
        class Got(val post: Post) : Event()
        class Captcha(val title: String) : Event()
        class Status(val text: String) : Event()
    }

    private val main = Handler(Looper.getMainLooper())
    private var done = false
    private val videoUrls = LinkedHashSet<String>()
    private var pageTitle = ""
    private var polls = 0

    companion object {
        val HOOK_JS = """
(function(){ if(window.__shiying)return; window.__shiying=1;
 function want(u){u=String(u||'');return /aweme\/v1\/web\/aweme\/detail|aweme\/v1\/web\/multi\/aweme|\/aweme\/detail|slidesinfo|aweme\/v1\/web\/aweme\/post|aweme\/v2\/web\/module\/feed|aweme\/v1\/web\/tab\/feed/.test(u);}
 function send(u,t){try{if(t&&t.length>80)ShiYing.onJson(String(u),String(t));}catch(e){}}
 try{var of=window.fetch; if(of){window.fetch=function(i,o){var u=(i&&i.url)||i; var p=of.apply(this,arguments); try{if(want(u))p.then(function(r){try{r.clone().text().then(function(t){send(u,t)})}catch(e){}});}catch(e){} return p;};}}catch(e){}
 try{var oo=XMLHttpRequest.prototype.open, os=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(m,u){this.__syu=u;return oo.apply(this,arguments);};
 XMLHttpRequest.prototype.send=function(){var x=this; try{if(want(x.__syu))x.addEventListener('load',function(){try{var t=(x.responseType===''||x.responseType==='text')?x.responseText:(x.responseType==='json'?JSON.stringify(x.response):'');send(x.__syu,t);}catch(e){}});}catch(e){} return os.apply(this,arguments);};}catch(e){}
})();
""".trimIndent()

        val POLL_JS = """
(function(){ try{
 var r={title:document.title||'',videos:[],render:null,router:null};
 var vs=document.querySelectorAll('video, video source'); for(var i=0;i<vs.length;i++){var s=vs[i].currentSrc||vs[i].src; if(s&&s.indexOf('blob:')!==0)r.videos.push(s);}
 var rd=document.getElementById('RENDER_DATA'); if(rd&&rd.textContent){try{r.render=decodeURIComponent(rd.textContent)}catch(e){}}
 if(window._ROUTER_DATA){try{r.router=JSON.stringify(window._ROUTER_DATA)}catch(e){}}
 if(!r.render&&!r.router&&window.self&&self.__pace_f){try{var a=[];self.__pace_f.forEach(function(x){if(x&&x[1]&&String(x[1]).indexOf('aweme_id')>=0||String(x&&x[1]).indexOf('awemeId')>=0)a.push(String(x[1]))});if(a.length)r.render=a.join('\n')}catch(e){}}
 ShiYing.onPoll(JSON.stringify(r));
}catch(e){} })();
""".trimIndent()

        private val VIDEO_URL = Regex("""(douyinvod\.com|zjcdn\.com|bytecdn\.cn|/aweme/v1/play/|mime_type=video_mp4|\.mp4(\?|$))""")

        @SuppressLint("SetJavaScriptEnabled")
        fun configure(web: WebView, desktop: Boolean = true) {
            val s = web.settings
            s.javaScriptEnabled = true
            s.domStorageEnabled = true
            s.databaseEnabled = true
            s.mediaPlaybackRequiresUserGesture = true
            s.loadWithOverviewMode = true
            s.useWideViewPort = true
            s.builtInZoomControls = true
            s.displayZoomControls = false
            s.cacheMode = WebSettings.LOAD_DEFAULT
            s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            if (desktop) s.userAgentString = Net.UA_DESKTOP
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        }
    }

    @SuppressLint("JavascriptInterface", "RequiresFeature")
    fun start(url: String) {
        configure(web)
        web.addJavascriptInterface(Bridge(), "ShiYing")
        val docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (docStart) runCatching { WebViewCompat.addDocumentStartJavaScript(web, HOOK_JS, setOf("https://*.douyin.com", "https://douyin.com", "https://*.iesdouyin.com")) }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, u: String?, favicon: Bitmap?) {
                if (!docStart) view.evaluateJavascript(HOOK_JS, null)
            }
            override fun onPageFinished(view: WebView, u: String?) {
                if (!docStart) view.evaluateJavascript(HOOK_JS, null)
                poll()
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val s = req.url.scheme ?: return true
                return s != "http" && s != "https"   // block snssdk1128:// / intent:// "open the app" jumps
            }
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url.toString()
                if (VIDEO_URL.containsMatchIn(u) && !u.contains(".mp3") && !u.contains("/obj/") && !u.contains(".m4a")) {
                    main.post { if (!done) { videoUrls += u; scheduleVideoOnly() } }
                }
                return null
            }
        }
        web.loadUrl(url)
        schedulePolls()
    }

    private fun schedulePolls() {
        main.postDelayed(object : Runnable {
            override fun run() {
                if (done) return
                poll(); polls++
                if (polls < 120) main.postDelayed(this, 1500)
            }
        }, 1500)
    }

    private fun poll() { if (!done) runCatching { web.evaluateJavascript(POLL_JS, null) } }

    private var videoOnlyScheduled = false
    /** If we only ever see the mp4 request (no JSON), use it after a grace period. */
    private fun scheduleVideoOnly() {
        if (videoOnlyScheduled) return
        videoOnlyScheduled = true
        main.postDelayed({
            if (!done && videoUrls.isNotEmpty()) {
                val title = pageTitle.replace(Regex("""\s*-\s*抖音\s*$"""), "").ifBlank { "抖音视频" }
                deliver(Post(wantId ?: "web${System.currentTimeMillis()}", false, title, "", null, 0, videoUrls.toList(), emptyList(), "网页"))
            }
        }, 6000)
    }

    fun stop() {
        done = true
        main.removeCallbacksAndMessages(null)
    }

    private fun deliver(p: Post) {
        if (done) return
        done = true
        main.removeCallbacksAndMessages(null)
        onEvent(Event.Got(p))
    }

    private fun handleJson(text: String) {
        if (done) return
        val p = Parser.fromWebDetail(text, wantId) ?: deepFind(text) ?: return
        deliver(p)
    }

    /** Search any JSON blob for the wanted aweme (snake_case or camelCase RENDER_DATA). */
    private fun deepFind(text: String): Post? {
        val root: Any = try { if (text.trimStart().startsWith("[")) JSONArray(text) else JSONObject(text) } catch (e: Exception) { return null }
        var found: Post? = null
        fun walk(x: Any?, depth: Int) {
            if (found != null || depth > 14) return
            when (x) {
                is JSONObject -> {
                    val id = x.optString("aweme_id").ifEmpty { x.optString("awemeId") }
                    if (id.isNotEmpty() && (wantId == null || id == wantId) && (x.has("video") || x.has("images"))) {
                        val p = if (x.has("aweme_id")) Parser.fromItem(x, "网页") else fromCamel(x)
                        if (p != null && (p.isImages || p.videoUrls.isNotEmpty())) { found = p; return }
                    }
                    val ks = x.keys(); while (ks.hasNext()) walk(x.opt(ks.next()), depth + 1)
                }
                is JSONArray -> for (i in 0 until x.length()) walk(x.opt(i), depth + 1)
            }
        }
        walk(root, 0)
        return found
    }

    /** RENDER_DATA (camelCase) aweme → Post. */
    private fun fromCamel(o: JSONObject): Post? {
        fun srcs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).mapNotNull {
            val e = a.opt(it)
            val s = if (e is JSONObject) e.optString("src") else e?.toString()
            s?.let { u -> if (u.startsWith("//")) "https:$u" else u }?.takeIf { u -> u.startsWith("http") }
        }
        val v = o.optJSONObject("video")
        val urls = LinkedHashSet<String>()
        v?.optJSONArray("bitRateList")?.let { br ->
            val list = (0 until br.length()).mapNotNull { br.optJSONObject(it) }
                .sortedWith(compareByDescending<JSONObject> { minOf(it.optInt("height"), it.optInt("width")).takeIf { h -> h > 0 } ?: it.optInt("height") }.thenByDescending { it.optLong("bitRate") })
            for (b in list) urls += srcs(b.optJSONArray("playAddr"))
        }
        urls += srcs(v?.optJSONArray("playAddr"))
        v?.optString("playApi")?.takeIf { it.isNotBlank() }?.let { urls += if (it.startsWith("//")) "https:$it" else it }
        val imgs = o.optJSONArray("images")
        val images = if (imgs == null) emptyList() else (0 until imgs.length()).mapNotNull { i ->
            val im = imgs.optJSONObject(i) ?: return@mapNotNull null
            val u = srcs(im.optJSONArray("urlList")).sortedBy { if (it.contains(".webp")) 1 else 0 }
            if (u.isEmpty()) null else ImageItem(u, srcs(im.optJSONObject("video")?.optJSONArray("playAddr")))
        }
        val author = o.optJSONObject("authorInfo")?.optString("nickname") ?: o.optJSONObject("author")?.optString("nickname") ?: ""
        val cover = v?.optString("originCover")?.ifBlank { null } ?: v?.optString("cover")
        var dur = v?.optLong("duration") ?: 0L
        if (dur in 1..999) dur *= 1000
        return Post(o.optString("awemeId"), images.isNotEmpty(), o.optString("desc"), author,
            (if (images.isNotEmpty()) images.first().urls.first() else cover?.let { if (it.startsWith("//")) "https:$it" else it }),
            if (images.isNotEmpty()) 0 else dur, if (images.isNotEmpty()) emptyList() else urls.toList(), images, "网页")
    }

    private inner class Bridge {
        @JavascriptInterface fun onJson(url: String, text: String) { main.post { handleJson(text) } }

        @JavascriptInterface fun onPoll(json: String) {
            main.post {
                if (done) return@post
                val o = try { JSONObject(json) } catch (e: Exception) { return@post }
                pageTitle = o.optString("title")
                if (pageTitle.contains("验证码") || pageTitle.contains("验证")) { onEvent(Event.Captcha(pageTitle)) }
                o.optString("render").takeIf { it.isNotBlank() && it != "null" }?.let { r ->
                    for (part in r.split('\n')) { handleJson(part.substringAfter(':', part).let { if (it.trimStart().startsWith("{") || it.trimStart().startsWith("[")) it else part }); if (done) return@post }
                }
                o.optString("router").takeIf { it.isNotBlank() && it != "null" }?.let { handleJson(it) }
                val vs = o.optJSONArray("videos")
                if (vs != null) for (i in 0 until vs.length()) { val s = vs.optString(i); if (s.startsWith("http")) { videoUrls += s; scheduleVideoOnly() } }
            }
        }
    }
}
