package com.louis.shiying

import android.Manifest
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.util.Size
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import okhttp3.Request
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val main = Handler(Looper.getMainLooper())
    private val bg = Executors.newFixedThreadPool(3)
    private val imgExec = Executors.newFixedThreadPool(3)
    private val imgCache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    private lateinit var input: EditText
    private lateinit var status: TextView
    private lateinit var spin: ProgressBar
    private lateinit var btnParse: TextView
    private lateinit var btnWebMode: TextView
    private lateinit var preview: View
    private lateinit var cover: ImageView
    private lateinit var pTitle: TextView
    private lateinit var pMeta: TextView
    private lateinit var pQuality: TextView
    private lateinit var btnDownload: TextView
    private lateinit var dlBar: ProgressBar
    private lateinit var dlText: TextView
    private lateinit var historyList: LinearLayout
    private lateinit var historyEmpty: TextView
    private lateinit var btnLogin: TextView
    private lateinit var updateBanner: TextView

    private var gen = 0                // parse generation; stale results are dropped
    private var post: Post? = null
    private var currentKey: String? = null
    private var pendingFallback: NeedFallback? = null
    private var hiddenWeb: WebView? = null
    private var hiddenCapture: WebCapture? = null
    private var lastClip: String? = null
    private var denoAwaitInstall = false     // the system installer for the Deno package was opened
    private var denoPendingParse: String? = null
    private var downloading = false
    private var infoProc: String? = null

    private val busListener: (Bus.State) -> Unit = { s -> onBus(s) }

    private val captureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val p = BrowserActivity.captured
        BrowserActivity.captured = null
        if (p != null) { setBusy(false); showPreview(p); setStatus(if (p.isImages) "网页模式解析成功（图集 ${p.images.size} 张，实况 ${p.liveCount} 个）" else "网页模式解析成功", ok = true) }
    }
    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted && Build.VERSION.SDK_INT < 29) Toast.makeText(this, "没有存储权限，无法保存到相册", Toast.LENGTH_LONG).show()
        else post?.let { startDownload(it) }
    }
    private val notifLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private var importFor: Platform = Platform.YOUTUBE
    private val cookiesPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) importCookies(uri) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        applyBars()
        input = findViewById(R.id.input)
        status = findViewById(R.id.status)
        spin = findViewById(R.id.parseSpin)
        btnParse = findViewById(R.id.btnParse)
        btnWebMode = findViewById(R.id.btnWebMode)
        preview = findViewById(R.id.preview)
        cover = findViewById(R.id.cover)
        pTitle = findViewById(R.id.pTitle)
        pMeta = findViewById(R.id.pMeta)
        pQuality = findViewById(R.id.pQuality)
        pQuality.setOnClickListener { post?.let { pickQualityFor(it) } }
        btnDownload = findViewById(R.id.btnDownload)
        dlBar = findViewById(R.id.dlBar)
        dlText = findViewById(R.id.dlText)
        historyList = findViewById(R.id.historyList)
        historyEmpty = findViewById(R.id.historyEmpty)
        btnLogin = findViewById(R.id.btnLogin)
        updateBanner = findViewById(R.id.updateBanner)

        btnParse.setOnClickListener { parse(input.text.toString()) }
        findViewById<View>(R.id.btnPaste).setOnClickListener {
            val t = clipText()
            if (t.isNullOrBlank()) Toast.makeText(this, "剪贴板是空的", Toast.LENGTH_SHORT).show()
            else { input.setText(t); lastClip = t; if (Links.looksSupported(t) || Links.bareId(t) != null) parse(t) }
        }
        findViewById<View>(R.id.btnClear).setOnClickListener {
            input.setText(""); setStatus(""); preview.visibility = View.GONE; btnWebMode.visibility = View.GONE; post = null; gen++; stopHidden(); stopInfo(); setBusy(false)
        }
        btnDownload.setOnClickListener {
            if (downloading) { currentKey?.let { DownloadService.cancel(this, it) }; btnDownload.isEnabled = false; btnDownload.text = "正在取消…" }
            else post?.let { startDownload(it) }
        }
        btnWebMode.setOnClickListener {
            val nf = pendingFallback ?: return@setOnClickListener
            captureLauncher.launch(BrowserActivity.capture(this, nf.id, nf.likelyImages))
        }
        btnLogin.setOnClickListener { showLoginChooser() }
        findViewById<View>(R.id.btnMore).setOnClickListener { showMenu(it) }
        findViewById<View>(R.id.btnClearHistory).setOnClickListener {
            AlertDialog.Builder(this).setMessage("清空全部下载记录？（已保存到相册的文件不会删除）")
                .setPositiveButton("清空") { _, _ -> History.clear(this); renderHistory() }
                .setNegativeButton("取消", null).show()
        }
        updateBanner.setOnClickListener { startUpdate() }

        Bus.add(busListener)
        renderHistory()
        handleIntent(intent)
        silentUpdateCheck()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        Updater.onResume(this)
        if (denoAwaitInstall) onDenoInstallReturned()
        btnLogin.text = if (Platform.loginable.any { Cookies.isLoggedIn(it) }) "账号" else "登录"
        renderHistory()
        BrowserActivity.requestCookieImport?.let { BrowserActivity.requestCookieImport = null; main.postDelayed({ startCookieImport(it) }, 300) }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Android 10+ only lets the focused app read the clipboard.
        if (hasFocus) main.postDelayed({ autoFillFromClipboard() }, 150)
    }

    override fun onDestroy() {
        Bus.remove(busListener)
        stopHidden(); stopInfo()
        bg.shutdownNow(); imgExec.shutdownNow()
        super.onDestroy()
    }

    private fun applyBars() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = !night
        c.isAppearanceLightNavigationBars = !night
    }

    // ---------------------------------------------------------------- input

    private fun handleIntent(i: Intent?) {
        i ?: return
        val text = when (i.action) {
            Intent.ACTION_SEND -> listOfNotNull(i.getStringExtra(Intent.EXTRA_TEXT), i.getStringExtra(Intent.EXTRA_SUBJECT)).joinToString(" ")
            Intent.ACTION_VIEW -> i.dataString
            else -> null
        }
        if (!text.isNullOrBlank()) {
            input.setText(text)
            lastClip = text
            i.action = null // don't re-handle on recreate
            parse(text)
        }
    }

    private fun clipText(): String? = try {
        val cm = getSystemService(ClipboardManager::class.java)
        val clip = cm.primaryClip
        if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
    } catch (e: Exception) { null }

    private fun autoFillFromClipboard() {
        val t = clipText() ?: return
        if (!Links.looksSupported(t)) return
        val seen = getSharedPreferences("kv", 0).getString("last_clip", null)
        if (t == lastClip || t == seen || t == input.text.toString()) return
        lastClip = t
        getSharedPreferences("kv", 0).edit().putString("last_clip", t).apply()
        input.setText(t)
        setStatus("已从剪贴板读取${Links.detect(t)?.label ?: ""}链接，点「解析」开始")
    }

    // ---------------------------------------------------------------- parsing

    private fun setBusy(b: Boolean) {
        spin.visibility = if (b) View.VISIBLE else View.GONE
        btnParse.isEnabled = !b
        btnParse.text = if (b) "解析中…" else "解析"
    }

    private fun setStatus(text: String, error: Boolean = false, ok: Boolean = false) {
        status.text = text
        status.setTextColor(ContextCompat.getColor(this, when { error -> R.color.error; ok -> R.color.ok; else -> R.color.text2 }))
    }

    private fun parse(raw: String, skipDenoAsk: Boolean = false) {
        val text = raw.trim()
        if (text.isEmpty()) { setStatus("请先粘贴分享链接", error = true); return }
        if (!skipDenoAsk && Links.detect(text) == Platform.YOUTUBE && shouldAskDeno()) { askDeno(text); return }
        val my = ++gen
        stopHidden(); stopInfo()
        pendingFallback = null
        btnWebMode.visibility = View.GONE
        preview.visibility = View.GONE
        post = null
        setBusy(true)
        val detected = Links.detect(text)
        setStatus(if (detected != null && detected != Platform.OTHER) "正在解析${detected.label}链接…" else "正在解析…")
        hideKeyboard()
        bg.execute {
            val log: (String) -> Unit = { s -> main.post { if (my == gen) setStatus(s) } }
            try {
                val p = when (val r = Extractor.route(text, log)) {
                    is Extractor.Route.Native -> r.post
                    is Extractor.Route.Ytdlp -> {
                        val proc = "info-$my-${System.currentTimeMillis()}"
                        infoProc = proc
                        try { Engine.info(this, r.url, r.platform, proc, log) } finally { if (infoProc == proc) infoProc = null }
                    }
                }
                main.post { if (my == gen) { setBusy(false); showPreview(p); setStatus("解析成功（${p.platform.label}）", ok = true) } }
            } catch (e: Cancelled) {
                main.post { if (my == gen) setBusy(false) }
            } catch (e: PostUnavailable) {
                main.post { if (my == gen) { setBusy(false); setStatus(e.message ?: "作品无法查看", error = true) } }
            } catch (e: UserError) {
                main.post { if (my == gen) { setBusy(false); setStatus(e.message ?: "解析失败", error = true) } }
            } catch (e: NeedFallback) {
                main.post { if (my == gen) startHiddenFallback(e, my) }
            } catch (e: Exception) {
                main.post { if (my == gen) { setBusy(false); setStatus("解析失败：${e.message ?: e.javaClass.simpleName}", error = true) } }
            }
        }
    }

    /** Step 2: invisible WebView opens the post on douyin.com and captures the data the page loads. */
    private fun startHiddenFallback(nf: NeedFallback, my: Int) {
        pendingFallback = nf
        setStatus("分享页没有拿到数据，正在用网页方式解析…")
        val web = try { WebView(this) } catch (e: Exception) {
            setBusy(false); setStatus("系统 WebView 不可用，无法使用网页方式解析", error = true); return
        }
        findViewById<FrameLayout>(R.id.webHolder).addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        hiddenWeb = web
        var captcha = false
        val cap = WebCapture(web, nf.id) { ev ->
            if (my != gen) return@WebCapture
            when (ev) {
                is WebCapture.Event.Got -> { stopHidden(); setBusy(false); showPreview(ev.post); setStatus("解析成功（网页方式）", ok = true) }
                is WebCapture.Event.Captcha -> captcha = true
                is WebCapture.Event.Status -> setStatus(ev.text)
            }
        }
        hiddenCapture = cap
        cap.start("https://www.douyin.com/${if (nf.likelyImages) "note" else "video"}/${nf.id}")
        main.postDelayed({
            if (my != gen || hiddenCapture !== cap) return@postDelayed
            stopHidden(); setBusy(false)
            val why = nf.filtered?.message
            val msg = when {
                why != null -> "$why\n如果你能在抖音里正常看到它，可以点下方「用网页模式重试」（可能需要登录）。"
                captcha -> "抖音要求安全验证，自动解析被拦下了。点下方「用网页模式重试」，完成验证后会自动继续。"
                else -> "两种方式都没拿到作品数据（作品可能已删除/私密，或网络受限）。可以点下方「用网页模式重试」，必要时先登录抖音。"
            }
            setStatus(msg, error = true)
            btnWebMode.text = "用网页模式重试（可登录 / 完成验证）"
            btnWebMode.visibility = View.VISIBLE
        }, 25_000)
    }

    private fun stopInfo() { infoProc?.let { Engine.cancel(it) }; infoProc = null }

    private fun stopHidden() {
        hiddenCapture?.stop(); hiddenCapture = null
        hiddenWeb?.let { w -> (w.parent as? ViewGroup)?.removeView(w); runCatching { w.stopLoading(); w.destroy() } }
        hiddenWeb = null
    }

    private fun showPreview(p: Post) {
        post = p
        preview.visibility = View.VISIBLE
        pTitle.text = p.title
        val parts = mutableListOf<String>()
        parts += p.platform.label
        if (p.author.isNotBlank()) parts += "@${p.author}"
        if (p.isImages) {
            parts += "图集 ${p.images.size} 张"
            if (p.liveCount > 0) parts += "含 ${p.liveCount} 个实况"
        } else {
            if (p.entries > 1) parts += "共 ${p.entries} 个视频"
            Parser.formatDuration(p.durationMs).takeIf { it.isNotEmpty() }?.let { parts += "时长 $it" }
            val h = if (p.engine == "ytdlp") p.height else Quality.shownHeight(p, p.qualityOverride ?: Engine.quality(this))
            if (h > 0) parts += "${h}p"
        }
        parts += "来源：${p.source}"
        pMeta.text = parts.joinToString(" · ")
        downloading = false
        btnDownload.text = downloadLabel(p)
        btnDownload.isEnabled = true
        dlBar.visibility = View.GONE; dlText.visibility = View.GONE
        currentKey = null
        cover.setImageDrawable(null)
        p.cover?.let { loadImage(it, cover, null, Thumbs.refererFor(it, p.platform, p.headers["Referer"])) }
        updateQualityLine(p)
        // The share page usually omits live-photo videos; offer the web mode, which sees what the web player sees.
        if (p.platform == Platform.DOUYIN && p.isImages && p.liveCount == 0 && p.source != "网页") {
            pendingFallback = NeedFallback(p.id, true, "", null)
            btnWebMode.text = "图集里有实况照片？用网页模式获取实况视频"
            btnWebMode.visibility = View.VISIBLE
        } else {
            btnWebMode.visibility = View.GONE
        }
    }

    private fun downloadLabel(p: Post): String {
        val clean = p.platform in setOf(Platform.DOUYIN, Platform.KUAISHOU, Platform.XIAOHONGSHU, Platform.TIKTOK)
        return when {
            !p.isImages && p.entries > 1 -> "下载全部视频（${p.entries} 个）"
            !p.isImages -> if (clean) "下载视频（无水印）" else "下载视频"
            p.liveCount > 0 -> "下载全部图片和实况（${p.images.size} 张）"
            else -> "下载全部图片（${p.images.size} 张）"
        }
    }

    // ---------------------------------------------------------------- download

    private fun startDownload(p: Post) {
        if (Build.VERSION.SDK_INT < 29 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            permLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE); return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !getSharedPreferences("kv", 0).getBoolean("asked_notif", false)) {
            getSharedPreferences("kv", 0).edit().putBoolean("asked_notif", true).apply()
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        currentKey = DownloadService.enqueue(this, p)
        downloading = true
        btnDownload.isEnabled = true
        btnDownload.text = "取消下载"
        dlBar.visibility = View.VISIBLE; dlBar.isIndeterminate = true
        dlText.visibility = View.VISIBLE; dlText.text = "准备下载…"
        dlText.setTextColor(ContextCompat.getColor(this, R.color.text2))
        renderHistory()
    }

    private fun onBus(s: Bus.State) {
        if (s.key == currentKey) {
            dlBar.visibility = View.VISIBLE; dlText.visibility = View.VISIBLE
            dlText.text = s.text
            when (s.status) {
                "running" -> { dlBar.isIndeterminate = s.pct < 0; if (s.pct >= 0) dlBar.progress = s.pct }
                "done", "partial" -> {
                    downloading = false
                    dlBar.isIndeterminate = false; dlBar.progress = 100
                    dlText.setTextColor(ContextCompat.getColor(this, if (s.status == "done") R.color.ok else R.color.error))
                    btnDownload.isEnabled = true; btnDownload.text = "再次下载"
                }
                "failed" -> {
                    downloading = false
                    dlBar.visibility = View.GONE
                    dlText.setTextColor(ContextCompat.getColor(this, R.color.error))
                    btnDownload.isEnabled = true; btnDownload.text = "重试下载"
                }
                "cancelled" -> {
                    downloading = false
                    dlBar.visibility = View.GONE
                    dlText.setTextColor(ContextCompat.getColor(this, R.color.text2))
                    btnDownload.isEnabled = true; btnDownload.text = post?.let { downloadLabel(it) } ?: "下载"
                }
            }
        }
        if (s.status != "running") renderHistory() else updateHistoryRow(s)
    }

    // ---------------------------------------------------------------- history

    private val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.CHINA)

    private fun renderHistory() {
        val list = History.all(this)
        historyList.removeAllViews()
        historyEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
        val inf = LayoutInflater.from(this)
        for (e in list) {
            val v = inf.inflate(R.layout.item_history, historyList, false)
            v.tag = e.key
            v.findViewById<TextView>(R.id.hTitle).text = e.title
            v.findViewById<TextView>(R.id.hMeta).text = listOf(fmt.format(Date(e.time)), e.platformLabel, if (e.isImages) "图集" else "视频", e.author).filter { it.isNotBlank() }.joinToString(" · ")
            val st = v.findViewById<TextView>(R.id.hStatus)
            val live = Bus.states[e.key]
            st.text = if (e.status == "running") (live?.text ?: e.message) else e.message
            st.setTextColor(ContextCompat.getColor(this, when (e.status) { "done" -> R.color.ok; "running", "cancelled" -> R.color.text2; else -> R.color.error }))
            loadHistoryImage(e, v.findViewById(R.id.hCover))
            v.setOnClickListener { openEntry(e) }
            v.setOnLongClickListener { entryMenu(e); true }
            historyList.addView(v)
        }
    }

    private fun updateHistoryRow(s: Bus.State) {
        for (i in 0 until historyList.childCount) {
            val v = historyList.getChildAt(i)
            if (v.tag == s.key) { v.findViewById<TextView>(R.id.hStatus).text = s.text; return }
        }
    }

    private fun openEntry(e: History.Entry) {
        val uri = History.firstUri(e)
        if (e.status == "running") { Toast.makeText(this, "正在下载…", Toast.LENGTH_SHORT).show(); return }
        if (uri == null || !Saver.exists(this, uri)) {
            if (e.status == "failed" || e.status == "cancelled") { reparse(e) } else Toast.makeText(this, "文件已被删除或移动", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, contentResolver.getType(uri) ?: if (e.isImages) "image/*" else "video/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (ex: Exception) { Toast.makeText(this, "没有可以打开这个文件的应用", Toast.LENGTH_SHORT).show() }
    }

    private fun reparse(e: History.Entry) {
        val link = e.reparseLink
        input.setText(link); parse(link)
        findViewById<android.widget.ScrollView>(R.id.scroll).smoothScrollTo(0, 0)
    }

    private fun entryMenu(e: History.Entry) {
        val items = arrayOf("打开", "重新解析", "复制作品链接", "删除这条记录")
        AlertDialog.Builder(this).setTitle(e.title).setItems(items) { _, which ->
            when (which) {
                0 -> openEntry(e)
                1 -> reparse(e)
                2 -> {
                    val cm = getSystemService(ClipboardManager::class.java)
                    val link = e.reparseLink
                    lastClip = link
                    getSharedPreferences("kv", 0).edit().putString("last_clip", link).apply()
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("作品链接", link))
                    Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show()
                }
                3 -> { History.remove(this, e.key); renderHistory() }
            }
        }.show()
    }

    // ---------------------------------------------------------------- images

    /** History thumbnail: the copy saved at download time, else the saved media's thumbnail, else the remote cover. */
    private fun loadHistoryImage(e: History.Entry, iv: ImageView) {
        val key = "h:" + e.key
        iv.tag = key
        iv.setImageDrawable(null)
        imgCache.get(key)?.let { iv.setImageBitmap(it); return }
        val uri = History.firstUri(e)
        imgExec.execute {
            val bmp: Bitmap? = runCatching {
                Thumbs.file(this, e.key).takeIf { it.exists() }?.let { BitmapFactory.decodeFile(it.absolutePath) }
            }.getOrNull() ?: runCatching {
                if (uri != null && e.status != "running" && Build.VERSION.SDK_INT >= 29) contentResolver.loadThumbnail(uri, Size(240, 320), null) else null
            }.getOrNull() ?: e.cover?.let { c ->
                runCatching {
                    val u = c.replaceFirst("http://", "https://")
                    val rb = Request.Builder().url(u).header("User-Agent", Net.UA_IPHONE)
                    Thumbs.refererFor(u, Platform.byName(e.platform), null)?.let { rb.header("Referer", it) }
                    Net.api.newCall(rb.build()).execute().use { r -> if (r.isSuccessful) r.body?.bytes()?.let { decode(it, 360) } else null }
                }.getOrNull()
            }
            if (bmp != null) {
                imgCache.put(key, bmp)
                main.post { if (iv.tag == key) iv.setImageBitmap(bmp) }
            }
        }
    }

    // ---------------------------------------------------------------- quality

    /** Heights the user can pick for this post (with approximate size when known). */
    private fun availableHeights(p: Post): List<Pair<Int, Long>> =
        if (p.isImages) emptyList()
        else if (p.engine == "ytdlp") p.infoJson?.let { runCatching { Quality.ytdlpHeights(java.io.File(it).readText()) }.getOrNull() }.orEmpty()
        else p.heights.values.filter { it > 0 }.distinct().sortedDescending().map { it to 0L }

    private fun updateQualityLine(p: Post) {
        val hs = availableHeights(p)
        if (hs.size < 2 || p.entries > 1) { pQuality.visibility = View.GONE; return }
        val q = p.qualityOverride ?: Engine.quality(this)
        val h = Quality.pick(hs.map { it.first }, q)
        pQuality.text = "本次画质：${if (h > 0) "${h}p" else Quality.label(q)}" + (hs.firstOrNull { it.first == h }?.second?.takeIf { it > 0 }?.let { " · 约 ${mb(it)}" } ?: "") + "  ▾ 更换"
        pQuality.visibility = View.VISIBLE
    }

    private fun mb(b: Long): String = if (b >= 1024L * 1024 * 1024) "%.1f GB".format(b / 1073741824.0) else "%.0f MB".format(maxOf(1.0, b / 1048576.0))

    private fun pickQualityFor(p: Post) {
        if (downloading) return
        val hs = availableHeights(p)
        if (hs.isEmpty()) return
        val cur = Quality.pick(hs.map { it.first }, p.qualityOverride ?: Engine.quality(this))
        val items = hs.map { (h, sz) -> "${h}p" + if (sz > 0) "（约 ${mb(sz)}）" else "" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("本次下载画质")
            .setSingleChoiceItems(items, hs.indexOfFirst { it.first == cur }) { d, w ->
                d.dismiss()
                val np = p.copy(qualityOverride = Quality.forHeight(hs[w].first))
                post = np
                showPreview(np)
            }.setNegativeButton("取消", null).show()
    }

    private fun showQualityDialog() {
        val keys = Quality.keys
        val opts = keys.map { Quality.menuLabel(it) }.toTypedArray()
        AlertDialog.Builder(this).setTitle("下载画质")
            .setSingleChoiceItems(opts, keys.indexOf(Engine.quality(this)).coerceAtLeast(0)) { d, w ->
                Engine.setQuality(this, keys[w]); d.dismiss()
                Toast.makeText(this, "已设置为 ${Quality.label(keys[w])}（选不到时用最接近的画质）", Toast.LENGTH_SHORT).show()
                post?.let { if (!downloading && it.qualityOverride == null) showPreview(it) }
            }.setNegativeButton("取消", null).show()
    }

    // ---------------------------------------------------------------- cookies import

    private fun importCookies(uri: Uri) {
        val p = importFor
        bg.execute {
            val err = runCatching {
                val text = contentResolver.openInputStream(uri)?.use { it.readBytes().take(4 * 1024 * 1024).toByteArray().toString(Charsets.UTF_8) } ?: ""
                Cookies.importNetscape(this, p, text)
            }.getOrElse { "读取文件失败：${it.message?.take(60)}" }
            main.post {
                if (err == null) { btnLogin.text = "账号"; AlertDialog.Builder(this).setTitle("已导入 ${p.label} cookies").setMessage("之后解析 ${p.label} 会自动使用这份登录状态（只保存在本机）。如需删除：登录 → ${p.label} → 退出登录。").setPositiveButton("好", null).show() }
                else AlertDialog.Builder(this).setTitle("导入失败").setMessage(err).setPositiveButton("好", null).show()
            }
        }
    }

    private fun startCookieImport(p: Platform) {
        importFor = p
        runCatching { cookiesPicker.launch(arrayOf("text/plain", "text/*", "application/octet-stream", "*/*")) }
            .onFailure { Toast.makeText(this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show() }
    }

    private fun youtubeLoginMenu() {
        val p = Platform.YOUTUBE
        val logged = Cookies.isLoggedIn(p)
        val items = mutableListOf("网页登录 YouTube（Google 账号）", "导入 cookies.txt（从电脑浏览器导出）")
        if (logged) items += "退出 YouTube 登录 / 删除已导入的 cookies"
        AlertDialog.Builder(this).setTitle("YouTube" + if (logged) "（已登录）" else "")
            .setItems(items.toTypedArray()) { _, w ->
                when (w) {
                    0 -> startActivity(BrowserActivity.login(this, p))
                    1 -> AlertDialog.Builder(this).setTitle("导入 cookies.txt")
                        .setMessage("在电脑或手机浏览器（Chrome / Edge / Firefox / Kiwi）里登录 youtube.com，用扩展「Get cookies.txt LOCALLY」导出 youtube.com 的 cookies（Netscape 格式），把文件传到手机，然后在这里选择它。\n\n建议用一个不常用的小号：cookies 等同于登录状态，只保存在本机。")
                        .setPositiveButton("选择文件") { _, _ -> startCookieImport(p) }.setNegativeButton("取消", null).show()
                    2 -> { Cookies.logout(p); onResume(); Toast.makeText(this, "已退出 YouTube 登录", Toast.LENGTH_SHORT).show() }
                }
            }.setNegativeButton("关闭", null).show()
    }

    private fun loadImage(key: String, iv: ImageView, local: Uri?, referer: String? = null) {
        iv.tag = key
        imgCache.get(key)?.let { iv.setImageBitmap(it); return }
        imgExec.execute {
            val bmp: Bitmap? = try {
                if (local != null) {
                    if (Build.VERSION.SDK_INT >= 29) contentResolver.loadThumbnail(local, Size(240, 320), null) else null
                } else {
                    val rb = Request.Builder().url(key).header("User-Agent", Net.UA_IPHONE)
                    if (referer != null) rb.header("Referer", referer) else if (Links.isDouyin(key) || key.contains("douyinpic")) rb.header("Referer", Net.REFERER)
                    val req = rb.build()
                    Net.api.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.bytes()?.let { decode(it, 720) } else null }
                }
            } catch (e: Exception) { null }
            if (bmp != null) {
                imgCache.put(key, bmp)
                main.post { if (iv.tag == key) iv.setImageBitmap(bmp) }
            }
        }
    }

    private fun decode(b: ByteArray, maxW: Int): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(b, 0, b.size, o)
        var s = 1
        while (o.outWidth / (s * 2) >= maxW) s *= 2
        return BitmapFactory.decodeByteArray(b, 0, b.size, BitmapFactory.Options().apply { inSampleSize = s })
    }

    private fun hideKeyboard() {
        runCatching {
            (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
            input.clearFocus()
        }
    }

    // ---------------------------------------------------------------- menu & update

    private fun showMenu(anchor: View) {
        val m = PopupMenu(this, anchor)
        m.menu.add(0, 1, 0, "检查更新")
        m.menu.add(0, 5, 1, "更新解析引擎")
        m.menu.add(0, 6, 2, "下载画质：" + Quality.label(Engine.quality(this)))
        m.menu.add(0, 7, 3, "登录平台账号（可选）")
        if (Platform.loginable.any { Cookies.isLoggedIn(it) }) m.menu.add(0, 2, 4, "退出全部登录")
        m.menu.add(0, 9, 2, denoMenuLabel())
        m.menu.add(0, 8, 5, "复制诊断日志（YouTube）")
        m.menu.add(0, 3, 5, "使用说明")
        m.menu.add(0, 4, 6, "关于 拾影 ${Updater.currentName}")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> manualUpdateCheck()
                2 -> AlertDialog.Builder(this).setMessage("退出所有平台的登录？（会清除本机保存的全部登录状态）")
                    .setPositiveButton("退出") { _, _ -> Login.logout(); btnLogin.text = "登录"; Toast.makeText(this, "已退出", Toast.LENGTH_SHORT).show() }
                    .setNegativeButton("取消", null).show()
                3 -> AlertDialog.Builder(this).setTitle("使用说明").setMessage(
                    "1. 在 App 里点「分享」→「复制链接」，回到拾影会自动填入，点「解析」。也可以在分享面板里选「拾影」。\n" +
                    "2. 支持：抖音、快手、小红书、哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo，" +
                    "其他网站也会尝试解析。微信视频号没有公开分享链接，无法支持。\n" +
                    "3. 视频保存到 相册 / Movies/拾影，图片保存到 Pictures/拾影。默认 1080p，可在 ⋮ → 下载画质 改为 最高 / 720p / 480p / 360p / 最低画质（省流量）；预览卡片上的「本次画质」可以只改这一次。\n" +
                    "4. 海外平台在国内需要开启 VPN。解析失败时先点 ⋮ →「更新解析引擎」再试。YouTube 和 YTDLnis 一样优先用 Deno 引擎（⋮ →「安装 Deno 引擎」，64 位手机）；被拒绝时自动依次尝试：更新引擎（nightly） → 备用客户端 → 生成验证令牌（PO Token）；仍不行请换 VPN 节点，或在「登录 → YouTube」登录 / 导入 cookies.txt。需要反馈问题时点 ⋮ →「复制诊断日志」。\n" +
                    "5. 私密、已删除、付费 / 会员专享内容无法下载。部分内容需要登录：点右上角「登录」选择平台登录一次即可（可选，登录状态只保存在本机）。\n" +
                    "6. 下载中可以点「取消下载」或通知栏里的「取消」。\n" +
                    "7. 仅供个人保存观看，请尊重作者版权。").setPositiveButton("知道了", null).show()
                4 -> AlertDialog.Builder(this).setTitle("拾影 ${Updater.currentName}")
                    .setMessage("国内外主流平台视频 / 图集保存工具（个人使用）。\n版本号 ${Updater.currentCode}\n解析引擎：yt-dlp ${Engine.version(this)}（youtubedl-android，GPL-3.0）\nDeno：${runCatching { Deno.status(this).describe() }.getOrDefault("未知")}")
                    .setPositiveButton("好", null).show()
                5 -> engineUpdate()
                6 -> showQualityDialog()
                7 -> showLoginChooser()
                8 -> copyDiag()
                9 -> denoDialog()
            }
            true
        }
        m.show()
    }

    // ---------------------------------------------------------------- Deno (2.3, same package YTDLnis installs)

    private fun denoMenuLabel(): String {
        val st = runCatching { Deno.status(this) }.getOrNull()
        return when {
            st == null || !st.supported -> "Deno 引擎（本机不支持）"
            st.usable -> "Deno 引擎：已安装 ${st.version}"
            else -> "安装 Deno 引擎（YouTube 需要）"
        }
    }

    /** Ask once a day on a YouTube link while the Deno package is missing (and could be installed). */
    private fun shouldAskDeno(): Boolean {
        val st = runCatching { Deno.status(this) }.getOrNull() ?: return false
        if (!st.supported || st.usable || Deno.downloading) return false
        val last = Kv.get(this, "deno_ask_at")?.toLongOrNull() ?: 0L
        return System.currentTimeMillis() - last > 24 * 3600 * 1000L
    }

    private val denoWhy = "YouTube 现在要求用 JS 引擎解开网页里的校验。YTDLnis 也是装上 Deno 之后才能下载 YouTube，拾影用同样的方式：" +
        "从 GitHub（YTDLnis 作者的 deniscerri/ytdlnis-packages）下载「YTDLnis Deno Package」（约 87 MB），由系统安装后拾影直接调用。\n\n" +
        "• 下载需要开启 VPN\n• 如果已经在 YTDLnis 里装过 Deno，拾影会自动使用，不用再装\n• 不装也能解析，但只能用内置的 QuickJS"

    private fun askDeno(text: String) {
        Kv.set(this, "deno_ask_at", System.currentTimeMillis().toString())
        AlertDialog.Builder(this).setTitle("YouTube 需要 Deno 引擎").setMessage(denoWhy)
            .setPositiveButton("下载安装") { _, _ -> startDenoInstall(text) }
            .setNegativeButton("先不装，直接解析") { _, _ -> parse(text, skipDenoAsk = true) }
            .show()
    }

    private fun denoDialog() {
        val st = runCatching { Deno.status(this) }.getOrNull()
        val b = AlertDialog.Builder(this).setTitle("Deno 引擎")
        if (st == null || !st.supported) {
            b.setMessage("本机 CPU（${Build.SUPPORTED_ABIS.firstOrNull()}）没有 Deno 版本（Deno 只支持 64 位）。YouTube 会继续使用内置的 QuickJS。")
                .setPositiveButton("好", null).show(); return
        }
        b.setMessage("状态：${st.describe()}\n\n$denoWhy")
        if (st.usable) {
            b.setPositiveButton("好", null).setNeutralButton("检查更新 / 重新安装") { _, _ -> startDenoInstall(null) }
        } else {
            b.setPositiveButton("下载安装") { _, _ -> startDenoInstall(null) }.setNegativeButton("取消", null)
        }
        b.show()
    }

    /** Downloads the Deno package from GitHub and opens the system installer; [after] = YouTube text to parse once it's installed. */
    private fun startDenoInstall(after: String?) {
        if (Deno.downloading) { Toast.makeText(this, "Deno 正在下载中…", Toast.LENGTH_SHORT).show(); return }
        val dlg = AlertDialog.Builder(this).setTitle("安装 Deno 引擎").setMessage("准备中…").setCancelable(false)
            .setNegativeButton("取消", null).show()
        dlg.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { Deno.cancel(); dlg.dismiss() }
        bg.execute {
            Deno.downloadAndInstall(this) { kind, pct, msg ->
                main.post {
                    when (kind) {
                        "status", "progress" -> if (dlg.isShowing) dlg.setMessage(msg + if (pct >= 0) "（$pct%）" else "")
                        "installing" -> {
                            dlg.dismiss()
                            denoAwaitInstall = true; denoPendingParse = after
                            Toast.makeText(this, "请在系统安装界面点「安装」（若提示，请允许拾影安装应用）", Toast.LENGTH_LONG).show()
                        }
                        "cancelled" -> { dlg.dismiss(); Toast.makeText(this, "已取消下载（再次安装会接着下载）", Toast.LENGTH_SHORT).show() }
                        else -> {
                            dlg.dismiss()
                            val e = AlertDialog.Builder(this).setTitle("Deno 引擎安装失败").setMessage(msg)
                                .setPositiveButton("重试") { _, _ -> startDenoInstall(after) }
                            if (after != null) e.setNegativeButton("直接解析（QuickJS）") { _, _ -> parse(after, skipDenoAsk = true) }
                            else e.setNegativeButton("关闭", null)
                            e.show()
                        }
                    }
                }
            }
        }
    }

    private fun onDenoInstallReturned() {
        denoAwaitInstall = false
        val after = denoPendingParse; denoPendingParse = null
        val st = runCatching { Deno.status(this) }.getOrNull()
        if (st?.usable == true) {
            Deno.cleanupDownloads(this)
            Toast.makeText(this, "Deno 引擎已安装（${st.version}），YouTube 将优先使用 Deno", Toast.LENGTH_LONG).show()
            if (after != null) { input.setText(after); parse(after, skipDenoAsk = true) }
        } else {
            val b = AlertDialog.Builder(this).setTitle("Deno 引擎未安装")
                .setMessage(if (st?.installed == true) st.describe() else "系统安装没有完成（可能被取消）。可以重新打开安装，或先用内置 QuickJS 解析。")
                .setPositiveButton("重新安装") { _, _ -> startDenoInstall(after) }
            if (after != null) b.setNegativeButton("直接解析（QuickJS）") { _, _ -> parse(after, skipDenoAsk = true) } else b.setNegativeButton("关闭", null)
            b.show()
        }
    }

    /** Copies the last YouTube parse log (yt-dlp -v of every attempt, cookie values / tokens removed). */
    private fun copyDiag() {
        val text = Diag.lastRedacted(this)
        if (text == null) { Toast.makeText(this, "还没有 YouTube 解析记录：先解析一次 YouTube 链接", Toast.LENGTH_LONG).show(); return }
        val cm = getSystemService(android.content.ClipboardManager::class.java)
        cm.setPrimaryClip(android.content.ClipData.newPlainText("拾影诊断日志", text))
        lastClip = cm.primaryClip?.getItemAt(0)?.text?.toString()   // don't auto-paste our own log
        Toast.makeText(this, "已复制诊断日志（${text.length / 1024 + 1} KB，已隐藏 cookies 和令牌），可以直接粘贴发送", Toast.LENGTH_LONG).show()
    }

    private fun showLoginChooser() {
        val ps = Platform.loginable
        val items = ps.map { p -> p.label + if (Cookies.isLoggedIn(p)) "（已登录）" else "" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("登录平台账号（可选）")
            .setItems(items) { _, w ->
                val p = ps[w]
                if (p == Platform.YOUTUBE) youtubeLoginMenu()
                else if (Cookies.isLoggedIn(p)) {
                    AlertDialog.Builder(this).setTitle(p.label).setItems(arrayOf("打开${p.label}网页", "退出${p.label}登录")) { _, x ->
                        if (x == 0) startActivity(BrowserActivity.login(this, p))
                        else { Cookies.logout(p); onResume(); Toast.makeText(this, "已退出${p.label}登录", Toast.LENGTH_SHORT).show() }
                    }.show()
                } else startActivity(BrowserActivity.login(this, p))
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    private fun engineUpdate() {
        val dlg = AlertDialog.Builder(this).setTitle("更新解析引擎").setMessage("正在从 GitHub 下载最新的 yt-dlp…\n当前：${Engine.version(this)}").setCancelable(false).show()
        bg.execute {
            val msg = Engine.update(this)
            main.post { dlg.dismiss(); AlertDialog.Builder(this).setTitle("更新解析引擎").setMessage(msg).setPositiveButton("好", null).show() }
        }
    }

    private fun silentUpdateCheck() {
        bg.execute {
            val r = runCatching { JSONObject(Updater.check(this, silent = true)) }.getOrNull() ?: return@execute
            if (r.optBoolean("ok") && r.optBoolean("hasUpdate")) main.post {
                updateBanner.text = "发现新版本 ${r.optString("versionName")}，点这里更新"
                updateBanner.visibility = View.VISIBLE
            }
        }
    }

    private fun manualUpdateCheck() {
        val dlg = AlertDialog.Builder(this).setMessage("正在检查更新…").setCancelable(true).show()
        bg.execute {
            val r = runCatching { JSONObject(Updater.check(this, silent = false)) }.getOrElse { JSONObject().put("ok", false).put("message", "检查失败") }
            main.post {
                dlg.dismiss()
                if (!r.optBoolean("ok")) {
                    AlertDialog.Builder(this).setTitle("检查更新失败").setMessage(r.optString("message", "检查失败")).setPositiveButton("好", null).show()
                } else if (r.optBoolean("hasUpdate")) {
                    AlertDialog.Builder(this).setTitle("发现新版本 ${r.optString("versionName")}")
                        .setMessage(r.optString("notes").ifBlank { "有新版本可用" })
                        .setPositiveButton("立即更新") { _, _ -> startUpdate() }
                        .setNegativeButton("以后再说", null).show()
                } else {
                    Toast.makeText(this, "已是最新版本（${Updater.currentName}）", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun startUpdate() {
        if (Updater.downloading) { Toast.makeText(this, "正在下载更新…", Toast.LENGTH_SHORT).show(); return }
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100; isIndeterminate = true; progressDrawable = ContextCompat.getDrawable(this@MainActivity, R.drawable.progress_red)
        }
        val tv = TextView(this).apply { text = "正在下载更新…"; setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text)) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; val p = (20 * resources.displayMetrics.density).toInt(); setPadding(p, p, p, p / 2)
            addView(tv); addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (10 * resources.displayMetrics.density).toInt()).apply { topMargin = p / 2 })
        }
        val dlg = AlertDialog.Builder(this).setTitle("更新拾影").setView(box).setCancelable(false)
            .setNegativeButton("取消") { _, _ -> Updater.cancel() }.show()
        bg.execute {
            Updater.downloadAndInstall(this) { kind, pct, _, msg ->
                main.post {
                    when (kind) {
                        "progress" -> { bar.isIndeterminate = pct < 0; if (pct >= 0) { bar.progress = pct; tv.text = "正在下载更新… $pct%" } }
                        "installing" -> { dlg.dismiss(); updateBanner.visibility = View.GONE }
                        "cancelled" -> dlg.dismiss()
                        "error" -> { dlg.dismiss(); AlertDialog.Builder(this).setTitle("更新失败").setMessage(msg ?: "更新失败").setPositiveButton("好", null).show() }
                    }
                }
            }
        }
    }
}
