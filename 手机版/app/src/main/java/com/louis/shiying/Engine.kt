package com.louis.shiying

import android.content.Context
import android.webkit.CookieManager
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Android half of the yt-dlp integration (youtubedl-android 0.18.1: Python 3.12 + yt-dlp + QuickJS, ffmpeg for merging).
 * Pure logic (options, JSON → Post, error texts) lives in [YtdlpSupport].
 */
object Engine {
    private val ready = CountDownLatch(1)
    @Volatile var initError: String? = null
        private set
    @Volatile private var started = false
    private const val KV_AUTO_UPDATE = "engine_auto_update_at"
    private const val AUTO_UPDATE_EVERY_MS = 3L * 24 * 3600 * 1000
    /** yt-dlp release bundled in res/raw/ytdlp (overrides the library's 2025.11.12 copy). */
    const val BUNDLED_YTDLP = "2026.11.23"
    private const val KV_BUNDLED = "bundled_ytdlp"
    /** 2.3: nightly like YTDLnis' default (yt-dlp-nightly-builds); YouTube fixes land there first. */
    private val UPDATE_CHANNEL = YoutubeDL.UpdateChannel.NIGHTLY
    /** On a YouTube failure, update yt-dlp before retrying unless an update was tried within this window. */
    private const val FAIL_UPDATE_EVERY_MS = 6L * 3600 * 1000

    /** youtubedl-android keeps the installed yt-dlp version in SharedPreferences "youtubedl-android" (keys dlpVersion / dlpVersionName). */
    private object LibPrefs {
        fun get(ctx: Context, k: String): String? = ctx.getSharedPreferences("youtubedl-android", Context.MODE_PRIVATE).getString(k, null)
        fun update(ctx: Context, k: String, v: String) = ctx.getSharedPreferences("youtubedl-android", Context.MODE_PRIVATE).edit().putString(k, v).apply()
    }

    /**
     * The library copies res/raw/ytdlp only when no yt-dlp is installed yet, so an update from 2.0 would keep the old engine.
     * Remove the installed copy once per new bundle when it is older than the bundle (a newer self-updated one is kept).
     */
    private fun applyBundledEngine(app: Context) {
        if (Kv.get(app, KV_BUNDLED) == BUNDLED_YTDLP) return
        val installed = runCatching { LibPrefs.get(app, "dlpVersion") }.getOrNull()
        if (installed == null || installed < BUNDLED_YTDLP) {
            File(app.noBackupFilesDir, "youtubedl-android/yt-dlp").deleteRecursively()
            runCatching { LibPrefs.update(app, "dlpVersion", BUNDLED_YTDLP); LibPrefs.update(app, "dlpVersionName", BUNDLED_YTDLP) }
        }
        Kv.set(app, KV_BUNDLED, BUNDLED_YTDLP)
    }

    /** Release date of the installed yt-dlp (from its version tag), or null. */
    private fun engineDate(ctx: Context): Long? {
        val v = runCatching { LibPrefs.get(ctx, "dlpVersion") }.getOrNull() ?: BUNDLED_YTDLP
        val m = Regex("""(\d{4})\.(\d{2})\.(\d{2})""").find(v) ?: return null
        return runCatching {
            java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
                clear(); set(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt())
            }.timeInMillis
        }.getOrNull()
    }

    /** Unpacks Python/yt-dlp/ffmpeg on first run (a few seconds) on a background thread. */
    fun initAsync(ctx: Context) {
        if (started) return
        started = true
        val app = ctx.applicationContext
        Thread({
            try {
                runCatching { applyBundledEngine(app) }
                YoutubeDL.getInstance().init(app)
                FFmpeg.getInstance().init(app)
                runCatching { Deno.prepare(app) }
            } catch (e: Throwable) {
                initError = "解析引擎初始化失败：${e.message?.take(80) ?: e.javaClass.simpleName}"
            } finally { ready.countDown() }
            // The bundled yt-dlp is from Nov 2025; sites change often, so refresh it quietly every few days.
            if (initError == null) runCatching {
                val last = Kv.get(app, KV_AUTO_UPDATE)?.toLongOrNull() ?: 0L
                if (System.currentTimeMillis() - last > AUTO_UPDATE_EVERY_MS) {
                    Kv.set(app, KV_AUTO_UPDATE, System.currentTimeMillis().toString())
                    YoutubeDL.getInstance().updateYoutubeDL(app, UPDATE_CHANNEL)
                }
            }
        }, "engine-init").start()
    }

    fun awaitReady(log: (String) -> Unit) {
        if (ready.count > 0) log("正在准备解析引擎（首次启动需要几秒）…")
        if (!ready.await(90, TimeUnit.SECONDS)) throw UserError("解析引擎准备超时，请重启拾影")
        initError?.let { throw UserError(it) }
    }

    fun version(ctx: Context): String = runCatching { YoutubeDL.getInstance().versionName(ctx) ?: YoutubeDL.getInstance().version(ctx) }.getOrNull() ?: "内置版本"

    fun quality(ctx: Context): String = Quality.normalize(Kv.get(ctx, "quality"))
    fun setQuality(ctx: Context, q: String) = Kv.set(ctx, "quality", q)

    /** Manual 更新解析引擎. Returns a Chinese status line. */
    fun update(ctx: Context): String {
        awaitReady {}
        return try {
            val st = YoutubeDL.getInstance().updateYoutubeDL(ctx.applicationContext, UPDATE_CHANNEL)
            Kv.set(ctx, KV_AUTO_UPDATE, System.currentTimeMillis().toString())
            if (st == YoutubeDL.UpdateStatus.ALREADY_UP_TO_DATE) "解析引擎已是最新（${version(ctx)}）" else "解析引擎已更新到 ${version(ctx)}"
        } catch (e: Throwable) {
            val m = (e.message ?: e.cause?.message ?: e.javaClass.simpleName).lowercase()
            "更新失败：" + when {
                m.contains("resolve") || m.contains("unknownhost") -> "无法连接 GitHub（无网络或被拦截，国内通常需要开启 VPN）"
                m.contains("timeout") || m.contains("timed out") -> "连接 GitHub 超时（国内通常需要开启 VPN）"
                m.contains("ssl") || m.contains("reset") -> "连接 GitHub 被拦截（国内通常需要开启 VPN）"
                m.contains("403") || m.contains("rate") -> "GitHub 暂时限制了请求，请过一会儿再试"
                else -> (e.message ?: e.javaClass.simpleName).take(80)
            }
        }
    }

    private fun proxyArgs(): List<String> {
        val host = System.getProperty("https.proxyHost") ?: System.getProperty("http.proxyHost") ?: return emptyList()
        val port = System.getProperty("https.proxyPort") ?: System.getProperty("http.proxyPort") ?: "8080"
        return listOf("--proxy", "http://$host:$port")
    }

    private fun request(url: String?, options: List<String>, autoProxy: Boolean = true): YoutubeDLRequest {
        val r = YoutubeDLRequest(url?.let { listOf(it) } ?: emptyList())
        var i = 0
        val opts = if (autoProxy && "--proxy" !in options) options + proxyArgs() else options
        while (i < opts.size) {
            val k = opts[i]
            val v = opts.getOrNull(i + 1)
            if (v != null && !v.startsWith("--") && k.startsWith("-") && takesValue(k)) { r.addOption(k, v); i += 2 } else { r.addOption(k); i++ }
        }
        return r
    }

    private fun takesValue(k: String) = k in setOf("-f", "-S", "-o", "--playlist-items", "--socket-timeout", "--retries", "--extractor-retries",
        "--cookies", "--load-info-json", "--merge-output-format", "--concurrent-fragments", "--proxy", "--extractor-args", "--plugin-dirs",
        "--cache-dir", "--js-runtimes")

    private class Run(val out: String, val err: String)

    private fun runInfo(url: String, options: List<String>, procId: String, autoProxy: Boolean = true): Run = try {
        val r = YoutubeDL.getInstance().execute(request(url, options, autoProxy), procId, false)
        Run(r.out, r.err)
    } catch (e: YoutubeDL.CanceledException) {
        throw Cancelled()
    } catch (e: YoutubeDLException) {
        if (Downloader.cancelRequested) throw Cancelled()
        Run("", e.message ?: "")
    }

    /** Parse step: yt-dlp --dump-single-json. Writes the JSON to cacheDir/info for the download step. */
    fun info(ctx: Context, url: String, platform: Platform, procId: String, log: (String) -> Unit): Post {
        awaitReady(log)
        log("正在用解析引擎读取${if (platform == Platform.OTHER) "" else platform.label}作品…")
        val cookies = Cookies.export(ctx, platform)
        val base = YtdlpSupport.infoOptions(platform, quality(ctx), cookies?.absolutePath)
        val out = if (platform == Platform.YOUTUBE) youtubeInfo(ctx, url, base, procId, log) else {
            val r = runInfo(url, base, procId)
            if (r.out.isBlank()) throw UserError(YtdlpSupport.errorMessage(r.err, platform))
            Info(r.out)
        }
        val dir = File(ctx.cacheDir, "info").apply { mkdirs() }
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 3600 * 1000 }?.forEach { it.delete() }
        val f = File(dir, sha1(url + System.nanoTime()) + ".json")
        f.writeText(out.json)
        val post = YtdlpSupport.parseInfo(out.json, platform, url, f.absolutePath)
        return if (out.args.isEmpty()) post else post.copy(ytdlpArgs = out.args)
    }

    private class Info(val json: String, val args: List<String> = emptyList())

    /**
     * YouTube with automatic fallbacks (each only when YouTube blocked the previous one):
     *  1. YTDLnis defaults (yt-dlp default clients, QuickJS, no --proxy, cookies only when really logged in)
     *     1b. same through the system proxy, only when 1 failed to connect and a proxy is set
     *  2. engine auto-update (if the engine is > 3 days old) 3. player clients that need no PO token
     *  4. PO token minted on-device in a hidden WebView (BotGuard).
     * Every attempt's full yt-dlp -v log goes to [Diag] for 「复制诊断日志」.
     */
    private fun youtubeInfo(ctx: Context, url: String, base: List<String>, procId: String, log: (String) -> Unit): Info {
        val steps = ArrayList<YtdlpSupport.YtStep>()
        var auth = YtdlpSupport.YtAuth.NONE
        var js = false
        val diag = Diag.start(ctx, url, version(ctx), base.contains("--cookies"), proxyArgs())
        // 2.3: Deno JS runtime (YTDLnis' Deno package); the library adds QuickJS, yt-dlp prefers Deno and falls back to QuickJS.
        val denoSt = runCatching { Deno.status(ctx) }.getOrNull()
        val denoExe = runCatching { Deno.prepare(ctx) }.getOrNull()
        diag.line("JS 引擎：Deno " + (denoSt?.describe() ?: "状态未知") + (if (denoExe != null) " → 使用 Deno" else " → 只用 QuickJS"))
        @Suppress("NAME_SHADOWING") val base = base + DenoSupport.jsRuntimeArgs(denoExe?.absolutePath)
        var netArgs = emptyList<String>()   // what reached YouTube: nothing (VPN / direct) or the system proxy
        fun ok(r: Run) = r.out.isNotBlank() && r.out.contains('{')
        fun note(name: String, opts: List<String>, r: Run) {
            diag.attempt(name, opts, r.err)
            YtdlpSupport.ytAuth(r.err).let { if (it != YtdlpSupport.YtAuth.NONE) auth = it }
            if (YtdlpSupport.jsProblem(r.err)) js = true
        }
        fun attempt(name: String, extra: List<String>): Run {
            val opts = base + netArgs + extra
            val r = runInfo(url, opts, procId, autoProxy = false)
            note(name, opts, r)
            return r
        }
        fun fail(r: Run): Nothing { diag.finish("失败"); throw UserError(YtdlpSupport.errorMessage(r.err, Platform.YOUTUBE)) }
        fun done(r: Run): Info { diag.finish("成功"); return Info(r.out, netArgs) }

        // 1. exactly what YTDLnis does by default
        var r = attempt("默认（同 YTDLnis）", emptyList())
        if (ok(r)) return done(r)
        if (YtdlpSupport.netProblem(r.err) && proxyArgs().isNotEmpty()) {
            log("连接失败，改用系统代理重试…")
            netArgs = proxyArgs()
            r = attempt("系统代理 ${netArgs.last()}", emptyList())
            if (ok(r)) return done(r)
            if (YtdlpSupport.netProblem(r.err)) netArgs = emptyList()
        }
        if (!YtdlpSupport.ytBlocked(r.err)) fail(r)
        steps += YtdlpSupport.YtStep("解析引擎 ${version(ctx)}", YtdlpSupport.ytReason(r.err))

        // 2. newer engine (nightly, like YTDLnis), unless one was tried recently
        val lastTry = Kv.get(ctx, KV_AUTO_UPDATE)?.toLongOrNull() ?: 0L
        if (System.currentTimeMillis() - lastTry > FAIL_UPDATE_EVERY_MS) {
            log("YouTube 拒绝了请求，正在更新解析引擎（nightly）后重试…")
            val msg = update(ctx)
            diag.line("自动更新引擎：$msg")
            if (msg.startsWith("解析引擎已更新")) {
                r = attempt("更新后的引擎 ${version(ctx)}", emptyList())
                if (ok(r)) return done(r)
                if (!YtdlpSupport.ytBlocked(r.err)) fail(r)
                steps += YtdlpSupport.YtStep("更新后的引擎 ${version(ctx)}", YtdlpSupport.ytReason(r.err))
            } else steps += YtdlpSupport.YtStep("自动更新引擎", msg.removePrefix("更新失败：").take(40))
        }

        // 3. alternative player clients
        log("YouTube 拒绝了请求，正在换用备用客户端重试…")
        r = attempt("备用客户端", listOf("--extractor-args", YtdlpSupport.YT_ALT_CLIENTS))
        if (ok(r)) return done(r)
        if (!YtdlpSupport.ytBlocked(r.err)) fail(r)
        steps += YtdlpSupport.YtStep("备用客户端（tv / ios / visionos 等）", YtdlpSupport.ytReason(r.err))

        // 4. PO token from a hidden WebView
        log("正在生成 YouTube 验证令牌（PO Token）后重试…")
        val pot = try {
            val id = YtdlpSupport.youtubeId(url)
            PoToken.mint(ctx, listOfNotNull(id))
        } catch (e: Cancelled) { throw e } catch (e: Throwable) {
            diag.line("PO Token 生成失败：${e.message}")
            steps += YtdlpSupport.YtStep("PO Token 验证", "生成失败（${e.message?.take(50) ?: e.javaClass.simpleName}）")
            null
        }
        if (Downloader.cancelRequested) throw Cancelled()
        if (pot != null) {
            val authed = auth == YtdlpSupport.YtAuth.OK
            r = attempt("PO Token", YtdlpSupport.ytPotArgs(PoToken.pluginDir(ctx).absolutePath, pot.file.absolutePath, pot.visitorData, authed, pot.dataSyncId))
            if (ok(r)) return done(r)
            if (!YtdlpSupport.ytBlocked(r.err)) fail(r)
            steps += YtdlpSupport.YtStep("PO Token 验证", YtdlpSupport.ytReason(r.err))
        }
        diag.finish("全部失败")
        throw UserError(YtdlpSupport.youtubeSummary(steps, auth, js, deno = if (denoSt?.supported == true) denoExe != null else null))
    }

    /** Download step into [outDir]; returns the produced media files in order. */
    fun download(ctx: Context, post: Post, outDir: File, procId: String, progress: (Float, String) -> Unit): List<File> {
        awaitReady {}
        val info = post.infoJson?.let { File(it) }?.takeIf { it.exists() } ?: throw UserError("作品信息已过期，请重新解析")
        val cookies = Cookies.export(ctx, post.platform)
        val q = post.qualityOverride ?: quality(ctx)
        val js = if (post.platform == Platform.YOUTUBE) DenoSupport.jsRuntimeArgs(runCatching { Deno.prepare(ctx) }.getOrNull()?.absolutePath) else emptyList()
        val opts = YtdlpSupport.downloadOptions(post.platform, q, cookies?.absolutePath, info.absolutePath, outDir.absolutePath) + post.ytdlpArgs + js
        // YouTube stream URLs are bound to the IP that parsed them: download the same way (VPN directly, or the proxy if parse used it).
        val req = request(null, opts, autoProxy = post.platform != Platform.YOUTUBE)
        try {
            YoutubeDL.getInstance().execute(req, procId, false) { pct, _, line -> progress(pct, line) }
        } catch (e: YoutubeDL.CanceledException) {
            throw Cancelled()
        } catch (e: YoutubeDLException) {
            if (Downloader.cancelRequested) throw Cancelled()
            throw UserError(YtdlpSupport.errorMessage(e.message ?: "", post.platform).replace("解析失败", "下载失败"))
        }
        val files = outDir.listFiles()?.filter { f ->
            f.isFile && f.length() > 0 && !f.name.endsWith(".part") && !f.name.endsWith(".ytdl") && !f.name.endsWith(".json") &&
                !f.name.contains(".temp.") && !Regex("""\.f\d+\.""").containsMatchIn(f.name)
        }?.sortedBy { it.name }.orEmpty()
        if (files.isEmpty()) throw UserError("下载失败：没有得到视频文件")
        return files
    }

    fun cancel(procId: String) { runCatching { YoutubeDL.getInstance().destroyProcessById(procId) } }

    private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)
}

/** Pure helpers for Netscape cookies.txt (JVM-testable). */
object CookieText {
    /** yt-dlp treats YouTube cookies as a login only with LOGIN_INFO + one of the SAPISID cookies (YoutubeBaseInfoExtractor._has_auth_cookies). */
    fun youtubeAuth(names: Collection<String>): Boolean =
        "LOGIN_INFO" in names && listOf("SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID").any { it in names }

    /** Cookie names in a Netscape file whose domain is youtube.com (incl. #HttpOnly_ lines). */
    fun youtubeNames(text: String): Set<String> = text.lineSequence().map { it.trimEnd('\r') }
        .filter { it.isNotBlank() && (!it.startsWith("#") || it.startsWith("#HttpOnly_")) }
        .map { it.split('\t') }.filter { it.size >= 7 }
        .filter { it[0].removePrefix("#HttpOnly_").trimStart('.').let { d -> d == "youtube.com" || d.endsWith(".youtube.com") } }
        .map { it[5] }.toSet()

    /** One Netscape line: domain-wide (".d", TRUE), path /, secure, a real expiry (yt-dlp keeps 0 as a session cookie, but a date is safest). */
    fun line(domain: String, name: String, value: String, expires: Long): String =
        ".${domain.trimStart('.')}\tTRUE\t/\tTRUE\t$expires\t$name\t$value"

    /** Splits CookieManager.getCookie() output ("a=1; b=2") into pairs; values may contain '='. */
    fun pairs(raw: String): List<Pair<String, String>> = raw.split(';').mapNotNull { part ->
        val kv = part.trim(); val eq = kv.indexOf('=')
        if (eq <= 0) null else kv.substring(0, eq) to kv.substring(eq + 1)
    }
}

/**
 * Exports the WebView cookies of a platform to a Netscape cookies.txt for yt-dlp (only when there are any).
 * YouTube: only when the user is really logged in (LOGIN_INFO + SAPISID); anonymous WebView cookies (VISITOR_INFO1_LIVE, YSC…)
 * are never sent: they pin yt-dlp to a visitor id YouTube may have flagged, and YTDLnis sends no cookies by default either.
 */
object Cookies {
    /** cookies.txt imported by the user (file picker), currently only for YouTube. */
    fun importedFile(ctx: Context, platform: Platform): File = File(ctx.filesDir, "cookies-import-${platform.name.lowercase()}.txt")
    /** Persistent copy handed to yt-dlp: yt-dlp writes rotated cookies back into it, so they survive the next run. */
    private fun workFile(ctx: Context, platform: Platform): File = File(ctx.filesDir, "cookies-work-${platform.name.lowercase()}.txt")

    /** Validates and stores a Netscape cookies.txt. Returns null on success or a Chinese error. */
    fun importNetscape(ctx: Context, platform: Platform, text: String): String? {
        val lines = text.lineSequence().map { it.trimEnd('\r') }.filter { it.isNotBlank() }
            .filter { !it.startsWith("#") || it.startsWith("#HttpOnly_") }.toList()
        val valid = lines.filter { it.split('\t').size >= 7 }
        if (valid.isEmpty()) return "不是有效的 cookies.txt（需要 Netscape 格式，可用浏览器扩展「Get cookies.txt LOCALLY」导出）"
        val doms = platform.cookieDomains.filter { it != "google.com" }
        if (doms.isNotEmpty() && valid.none { l -> doms.any { d -> l.split('\t')[0].removePrefix("#HttpOnly_").trimStart('.').endsWith(d) } })
            return "文件里没有 ${doms.joinToString(" / ")} 的 cookies，请在已登录 ${platform.label} 的浏览器里导出"
        val body = "# Netscape HTTP Cookie File\n" + valid.joinToString("\n") + "\n"
        if (platform == Platform.YOUTUBE && !CookieText.youtubeAuth(CookieText.youtubeNames(body)))
            return "文件里没有 YouTube 登录 cookies（缺少 LOGIN_INFO / SAPISID）。请在已登录 YouTube 的浏览器里打开 youtube.com 后再导出"
        importedFile(ctx, platform).writeText(body)
        workFile(ctx, platform).delete()
        return null
    }

    fun export(ctx: Context, platform: Platform): File? {
        if (platform.cookieDomains.isEmpty()) return null
        importedFile(ctx, platform).takeIf { it.exists() && it.length() > 0 }?.let { imp ->
            if (platform != Platform.YOUTUBE)
                return File(ctx.cacheDir, "cookies-${platform.name.lowercase()}.txt").also { imp.copyTo(it, overwrite = true) }
            // Keep yt-dlp's updated jar between runs (re-seed only when a new file was imported or the work copy lost the login).
            val work = workFile(ctx, platform)
            if (!work.exists() || work.lastModified() < imp.lastModified() || !CookieText.youtubeAuth(CookieText.youtubeNames(work.readText())))
                imp.copyTo(work, overwrite = true)
            return work
        }
        val cm = runCatching { CookieManager.getInstance() }.getOrNull() ?: return null
        val doms = if (platform == Platform.YOUTUBE) listOf("youtube.com") else platform.cookieDomains
        val lines = StringBuilder("# Netscape HTTP Cookie File\n")
        val names = HashSet<String>()
        var n = 0
        val expires = System.currentTimeMillis() / 1000 + 30L * 24 * 3600
        for (d in doms) {
            val seen = HashSet<String>()
            for (u in urlsFor(d)) {
                val raw = runCatching { cm.getCookie(u) }.getOrNull() ?: continue
                for ((k, v) in CookieText.pairs(raw)) {
                    if (!seen.add(k)) continue
                    lines.append(CookieText.line(d, k, v, expires)).append('\n'); n++
                    if (d == "youtube.com") names += k
                }
            }
        }
        if (n == 0) return null
        if (platform == Platform.YOUTUBE && !CookieText.youtubeAuth(names)) return null
        val f = File(ctx.cacheDir, "cookies-${platform.name.lowercase()}.txt")
        f.writeText(lines.toString())
        return f
    }

    private fun urlsFor(d: String) = listOf("https://www.$d/", "https://m.$d/", "https://$d/") +
        if (d == "google.com") listOf("https://accounts.google.com/") else emptyList()

    @Volatile var appCtx: Context? = null

    fun isLoggedIn(platform: Platform): Boolean = runCatching {
        if (platform.sessionCookies.isEmpty() || platform.cookieDomains.isEmpty()) return false
        appCtx?.let { if (importedFile(it, platform).exists()) return true }
        val cm = CookieManager.getInstance()
        if (platform == Platform.YOUTUBE) {
            val names = urlsFor("youtube.com").flatMap { CookieText.pairs(cm.getCookie(it) ?: "") }.map { it.first }
            return CookieText.youtubeAuth(names)
        }
        platform.cookieDomains.any { d ->
            val c = urlsFor(d).joinToString(";") { cm.getCookie(it) ?: "" }
            platform.sessionCookies.any { name -> Regex("""(^|;\s*)${Regex.escape(name)}=[^;]+""").containsMatchIn(c) }
        }
    }.getOrDefault(false)
    /** Removes this platform's cookies (CookieManager has no per-domain delete, so expire them one by one). */
    fun logout(platform: Platform) = runCatching {
        appCtx?.let { importedFile(it, platform).delete(); workFile(it, platform).delete() }
        val cm = CookieManager.getInstance()
        for (d in platform.cookieDomains) for (u in urlsFor(d)) {
            val raw = cm.getCookie(u) ?: continue
            for (part in raw.split(';')) {
                val name = part.trim().substringBefore('=')
                if (name.isEmpty()) continue
                cm.setCookie(u, "$name=; Domain=.$d; Path=/; Max-Age=0")
                cm.setCookie(u, "$name=; Path=/; Max-Age=0")
            }
        }
        cm.flush()
    }
}
