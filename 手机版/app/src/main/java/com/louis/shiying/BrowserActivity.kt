package com.louis.shiying

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/**
 * In-app douyin.com browser.
 *  mode=login   : log in once; cookies are kept in the shared CookieManager and reused by the fallback.
 *  mode=capture : visible version of the fallback (for captcha / login walls); returns the captured post.
 */
class BrowserActivity : ComponentActivity() {
    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_ID = "id"
        const val EXTRA_IMAGES = "images"
        const val EXTRA_PLATFORM = "platform"
        /** Result of a capture run (Post is not Parcelable; it is handed back through here). */
        @Volatile var captured: Post? = null
        /** Set when Google refused the WebView login and the user chose 导入 cookies.txt (MainActivity opens the picker). */
        @Volatile var requestCookieImport: Platform? = null


        fun login(ctx: Context, platform: Platform = Platform.DOUYIN) = Intent(ctx, BrowserActivity::class.java)
            .putExtra(EXTRA_MODE, "login").putExtra(EXTRA_PLATFORM, platform.name)
        fun capture(ctx: Context, id: String, images: Boolean) = Intent(ctx, BrowserActivity::class.java)
            .putExtra(EXTRA_MODE, "capture").putExtra(EXTRA_ID, id).putExtra(EXTRA_IMAGES, images)
    }

    private lateinit var web: WebView
    private var capture: WebCapture? = null
    private lateinit var hint: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_browser)
        web = findViewById(R.id.web)
        hint = findViewById(R.id.hint)
        val title = findViewById<TextView>(R.id.title)
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "login"
        val platform = Platform.byName(intent.getStringExtra(EXTRA_PLATFORM)) ?: Platform.DOUYIN
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.done).setOnClickListener {
            if (mode == "login") Toast.makeText(this, if (Cookies.isLoggedIn(platform)) "已登录${platform.label}，之后解析会自动使用登录状态" else "尚未检测到${platform.label}登录", Toast.LENGTH_SHORT).show()
            CookieManager.getInstance().flush()
            finish()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })

        if (mode == "capture") {
            val id = intent.getStringExtra(EXTRA_ID) ?: run { finish(); return }
            val images = intent.getBooleanExtra(EXTRA_IMAGES, false)
            title.text = "网页模式解析"
            hint.text = "正在像普通浏览一样打开作品。如出现验证码或登录框，请在下方完成，拿到视频后会自动返回。"
            captured = null
            capture = WebCapture(web, id) { ev ->
                when (ev) {
                    is WebCapture.Event.Got -> { captured = ev.post; setResult(Activity.RESULT_OK); finish() }
                    is WebCapture.Event.Captcha -> hint.text = "请完成下方的安全验证，完成后会自动继续。"
                    is WebCapture.Event.Status -> hint.text = ev.text
                }
            }.also { it.start("https://www.douyin.com/${if (images) "note" else "video"}/$id") }
        } else {
            title.text = "登录${platform.label}"
            hint.text = if (Cookies.isLoggedIn(platform)) "当前已登录${platform.label}。登录状态只保存在本机，用于解析需要登录才能看的内容。" else
                (if (platform == Platform.DOUYIN) "点网页右上角「登录」，用手机验证码登录即可（只需一次）。" else "在下方网页里登录${platform.label}（只需一次）。") +
                    "登录状态只保存在本机，不是必需的：只有提示需要登录时才用得上。"
            WebCapture.configure(web, platform.desktopLogin)
            val google = platform == Platform.YOUTUBE
            if (google) {
                web.settings.userAgentString = GoogleLogin.chromeUa(runCatching { android.webkit.WebSettings.getDefaultUserAgent(this) }.getOrDefault(web.settings.userAgentString))
                // Don't announce the app package in X-Requested-With (Google uses it to spot embedded browsers).
                runCatching {
                    if (androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST))
                        androidx.webkit.WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
                }
                hint.text = (if (Cookies.isLoggedIn(platform)) "当前已登录 YouTube。" else "") +
                    "用 Google 账号登录 YouTube（建议用小号）。如果 Google 提示「此浏览器或应用可能不安全」，说明 Google 不允许在 App 内登录，请返回改用「导入 cookies.txt」。"
            }
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val s = req.url.scheme ?: return true
                    return s != "http" && s != "https"
                }
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) { findViewById<View>(R.id.loading).visibility = View.VISIBLE }
                override fun onPageFinished(view: WebView?, url: String?) {
                    findViewById<View>(R.id.loading).visibility = View.GONE
                    if (Cookies.isLoggedIn(platform)) hint.text = "✓ 已登录${platform.label}。点右上角「完成」返回。"
                    if (google && view != null) view.evaluateJavascript("(document.body&&document.body.innerText||'').slice(0,3000)") { t ->
                        if (GoogleLogin.isRejection(url, t)) googleRejected()
                    }
                }
            }
            web.loadUrl(platform.loginUrl ?: "https://www.douyin.com/")
        }
    }

    private var rejectedShown = false

    private fun googleRejected() {
        if (rejectedShown || isFinishing) return
        rejectedShown = true
        hint.text = "Google 拒绝了在 App 内置网页里登录（Google 的安全限制，不是密码问题）。请改用「导入 cookies.txt」。"
        android.app.AlertDialog.Builder(this).setTitle("Google 不允许在 App 内登录")
            .setMessage("Google 把 App 内置网页视为「可能不安全的浏览器」，所以这里无法登录。\n\n替代办法：在浏览器里登录 youtube.com，用扩展「Get cookies.txt LOCALLY」导出 cookies.txt，再在拾影里导入。")
            .setPositiveButton("导入 cookies.txt") { _, _ -> requestCookieImport = Platform.YOUTUBE; finish() }
            .setNegativeButton("留在这里", null).show()
    }

    override fun onDestroy() {
        capture?.stop()
        runCatching { CookieManager.getInstance().flush() }
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}

/** Pure helpers for the YouTube (Google) WebView login. */
object GoogleLogin {
    /** Google blocks "embedded browser" logins; true when the page shows that refusal. Pure. */
    fun isRejection(url: String?, text: String?): Boolean {
        val u = url.orEmpty().lowercase(); val t = text.orEmpty().lowercase()
        return u.contains("signin/rejected") || u.contains("disallowed_useragent") ||
            (u.contains("accounts.google.") && listOf("may not be secure", "couldn't sign you in", "couldn’t sign you in", "可能不安全", "无法登录", "無法登入", "disallowed_useragent").any { t.contains(it) })
    }

    /** The WebView UA without its "wv" / "Version/4.0" markers, i.e. what mobile Chrome sends. */
    fun chromeUa(webViewUa: String): String =
        webViewUa.replace("; wv)", ")").replace(Regex("""\s?Version/\d+(\.\d+)*"""), "").replace(Regex("""\s{2,}"""), " ")
}
