package com.louis.shiying

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app updater. BuildConfig.UPDATE_URLS = manifest mirrors tried in order (short timeouts, system proxy respected):
 *   version.json = {"versionCode":2,"versionName":"2.0","apk":"shiying-2.0-arm64-v8a.apk","sha256":"…","notes":"…",
 *                   "apkMirrors":["https://…/shiying-2.0-arm64-v8a.apk"]}
 * "apk" is resolved against the manifest URL that answered; "apkMirrors" are absolute fallbacks.
 */
object Updater {
    private const val KV_LAST_CHECK = "upd_last_check"
    private const val KV_LATEST = "upd_latest"
    private const val SILENT_INTERVAL_MS = 12L * 3600 * 1000
    const val ACTION_INSTALL_STATUS = "com.louis.shiying.UPDATE_INSTALL_STATUS"

    private fun HttpError(code: Int) = UpdateSources.HttpError(code)

    @Volatile var downloading = false
        private set
    @Volatile private var cancelRequested = false

    /** APK verified and waiting for the "install unknown apps" permission. */
    @Volatile var pendingApk: File? = null
    @Volatile var waitingInstallPermission = false

    val currentCode: Int get() = BuildConfig.VERSION_CODE
    val currentName: String get() = BuildConfig.VERSION_NAME

    val manifestUrls: List<String> get() = UpdateSources.manifestUrls(BuildConfig.UPDATE_URLS)

    /** Which manifest URL answered last (APK paths are relative to it). */
    @Volatile private var lastManifestUrl: String? = null
    @Volatile var appContext: Context? = null

    private fun online(): Boolean = runCatching {
        val cm = appContext?.getSystemService(android.net.ConnectivityManager::class.java) ?: return true
        if (Build.VERSION.SDK_INT >= 23) {
            val n = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(n) ?: return false
            caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } else true
    }.getOrDefault(true)

    private fun open(url: String, connectMs: Int = 5_000, readMs: Int = 7_000): HttpURLConnection {
        // URL.openConnection() goes through the system ProxySelector, so a Wi-Fi / system proxy is respected; VPNs are transparent.
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = connectMs
        c.readTimeout = readMs
        c.instanceFollowRedirects = true
        c.useCaches = false
        c.setRequestProperty("Cache-Control", "no-cache")
        c.setRequestProperty("User-Agent", "ShiYing/${currentName} (Android ${Build.VERSION.RELEASE})")
        return c
    }

    /**
     * Returns a JSON string for the web UI:
     *  {ok:true, hasUpdate, current, currentCode, versionCode, versionName, notes, cached}
     *  {ok:false, error:"network"|"notfound"|"bad", silentSkipped?}
     * silent = launch check: throttled to once per 12h (cached result reused in between).
     */
    fun check(ctx: Context, silent: Boolean): String {
        appContext = ctx.applicationContext
        return try {
            val now = System.currentTimeMillis()
            if (silent) {
                val last = Kv.get(ctx, KV_LAST_CHECK)?.toLongOrNull() ?: 0L
                if (now - last in 0 until SILENT_INTERVAL_MS) {
                    val cached = Kv.get(ctx, KV_LATEST)?.let { runCatching { JSONObject(it) }.getOrNull() }
                    return result(cached, cached = true).toString()
                }
                Kv.set(ctx, KV_LAST_CHECK, now.toString())
            }
            val info = fetchInfo()
            try {
                Kv.set(ctx, KV_LATEST, info.toString())
                if (!silent) Kv.set(ctx, KV_LAST_CHECK, now.toString())
            } catch (_: Throwable) {}
            result(info, cached = false).toString()
        } catch (e: Throwable) {
            failure(e).toString()
        }
    }

    /** Always-valid failure JSON with a short Chinese reason the UI shows as-is. */
    class AllFailed(val errors: List<Throwable>) : IOException("all update mirrors failed")

    fun failure(e: Throwable): JSONObject {
        val errs = if (e is AllFailed) e.errors else listOf(e)
        val (kind, msg) = UpdateSources.summarize(errs, online())
        return JSONObject().put("ok", false).put("error", kind.name.lowercase()).put("message", msg)
    }

    fun describe(e: Throwable): Pair<String, String> = when (e) {
        is UpdateSources.HttpError -> (if (e.code == 404) "notfound" else "http") to
            (if (e.code == 404) "服务器上没有版本信息（HTTP 404）" else "服务器返回错误（HTTP ${e.code}）")
        is java.net.SocketTimeoutException, is java.util.concurrent.TimeoutException -> "timeout" to "连接超时，更新服务器暂时无法访问"
        is java.net.UnknownHostException -> "dns" to "无法解析更新服务器域名（无网络或被拦截）"
        is java.net.ConnectException, is java.net.NoRouteToHostException -> "connect" to "无法连接更新服务器"
        is javax.net.ssl.SSLException -> "ssl" to "安全连接失败（SSL），可能是网络/代理拦截"
        is IOException -> "network" to "网络错误：${e.javaClass.simpleName}${e.message?.let { "（${it.take(60)}）" } ?: ""}"
        is org.json.JSONException, is IllegalArgumentException -> "bad" to "版本信息格式错误"
        else -> "error" to "检查失败：${e.javaClass.simpleName}${e.message?.let { "（${it.take(60)}）" } ?: ""}"
    }

    private fun result(info: JSONObject?, cached: Boolean): JSONObject {
        val r = JSONObject().put("ok", true).put("cached", cached)
            .put("current", currentName).put("currentCode", currentCode)
        val code = info?.optInt("versionCode", 0) ?: 0
        r.put("hasUpdate", info != null && code > currentCode)
        if (info != null) {
            r.put("versionCode", code)
                .put("versionName", info.optString("versionName"))
                .put("notes", info.optString("notes"))
        }
        return r
    }

    /** Tries every manifest mirror in order; throws [AllFailed] with each mirror's error. */
    private fun fetchInfo(): JSONObject {
        val errors = ArrayList<Throwable>()
        for (u in manifestUrls) {
            try {
                val c = open(u + (if (u.contains('?')) "&" else "?") + "t=${System.currentTimeMillis()}")
                try {
                    val code = c.responseCode
                    if (code != 200) throw HttpError(code)
                    val text = c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val j = JSONObject(text)
                    if (j.optInt("versionCode", 0) <= 0 || j.optString("apk").isBlank() || j.optString("sha256").length != 64)
                        throw IllegalArgumentException("bad version.json")
                    lastManifestUrl = u
                    return j
                } finally { c.disconnect() }
            } catch (e: Throwable) { errors += e }
        }
        throw AllFailed(errors)
    }

    fun cancel() { cancelRequested = true }

    /**
     * Downloads the APK named in the latest version.json into cacheDir/update/, verifies sha256,
     * then installs. Progress/status go to [cb]: ("progress", pct 0..100 or -1, bytes) / ("error", msg) / ("installing") / ("cancelled").
     */
    fun downloadAndInstall(activity: Activity, cb: (String, Int, Long, String?) -> Unit) {
        if (downloading) return
        downloading = true; cancelRequested = false
        try {
            // Always re-read version.json so the hash matches what's on the server right now.
            appContext = activity.applicationContext
            val info = try { fetchInfo() } catch (e: Throwable) {
                cb("error", 0, 0, failure(e).optString("message")); return
            }
            Kv.set(activity, KV_LATEST, info.toString())
            if (info.optInt("versionCode") <= currentCode) { cb("error", 0, 0, "已是最新版本"); return }
            val mirrors = info.optJSONArray("apkMirrors")?.let { arr -> (0 until arr.length()).map { arr.optString(it) } }.orEmpty()
            // Per-ABI builds: "abis": {"arm64-v8a": {"apk": "…", "sha256": "…", "apkMirrors": […]}, …}
            val abiEntry = info.optJSONObject("abis")?.let { m -> Build.SUPPORTED_ABIS.firstNotNullOfOrNull { m.optJSONObject(it) } }
            val apkName = abiEntry?.optString("apk")?.takeIf { it.isNotBlank() } ?: info.getString("apk")
            val wantSha = abiEntry?.optString("sha256")?.takeIf { it.length == 64 } ?: info.getString("sha256")
            val abiMirrors = abiEntry?.optJSONArray("apkMirrors")?.let { arr -> (0 until arr.length()).map { arr.optString(it) } }
            val urls = UpdateSources.apkUrls(lastManifestUrl ?: manifestUrls.first(), apkName, abiMirrors ?: if (abiEntry != null) emptyList() else mirrors)
            val dir = File(activity.cacheDir, "update").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val out = File(dir, "shiying-update.apk")
            val part = File(dir, "shiying-update.apk.part")
            var md = MessageDigest.getInstance("SHA-256")
            var ok = false
            var lastErr = "下载失败，请检查网络"
            var done = 0L
            for (url in urls) {
                md = MessageDigest.getInstance("SHA-256"); done = 0L; part.delete()
                val c = try { open(url, 8_000, 20_000) } catch (e: IOException) { lastErr = "下载失败：" + describe(e).second; continue }
                try {
                    val code = c.responseCode
                    if (code != 200) { lastErr = if (code == 404) "下载失败：更新服务器上没有找到安装包（404）" else "下载失败（HTTP $code）"; continue }
                    val total = c.contentLengthLong
                    var lastPct = -2
                    var lastT = 0L
                    c.inputStream.use { ins ->
                        part.outputStream().use { os ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                if (cancelRequested) { part.delete(); cb("cancelled", 0, 0, null); return }
                                val n = ins.read(buf); if (n < 0) break
                                os.write(buf, 0, n); md.update(buf, 0, n); done += n
                                val pct = if (total > 0) (done * 100 / total).toInt() else -1
                                val t = System.currentTimeMillis()
                                if (pct != lastPct && (t - lastT > 150 || pct == 100)) { lastPct = pct; lastT = t; cb("progress", pct, done, null) }
                            }
                        }
                    }
                    if (total > 0 && done != total) { part.delete(); lastErr = "下载不完整，请重试"; continue }
                    ok = true
                } catch (e: IOException) {
                    part.delete(); lastErr = "下载失败：" + describe(e).second
                } finally { c.disconnect() }
                if (ok) break
            }
            if (!ok) { cb("error", 0, 0, lastErr); return }

            val hex = md.digest().joinToString("") { "%02x".format(it) }
            if (!hex.equals(wantSha.trim(), ignoreCase = true)) {
                part.delete(); cb("error", 0, 0, "安装包校验失败（SHA-256 不一致），已删除"); return
            }
            if (!part.renameTo(out)) { part.copyTo(out, true); part.delete() }

            // Sanity check: same package, newer version.
            val pi = activity.packageManager.getPackageArchiveInfo(out.absolutePath, 0)
            @Suppress("DEPRECATION")
            val newCode = if (pi == null) -1L else if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong()
            if (pi == null || pi.packageName != activity.packageName || newCode <= currentCode) {
                out.delete(); cb("error", 0, 0, "安装包无效"); return
            }
            cb("installing", 100, out.length(), null)
            activity.runOnUiThread { requestInstall(activity, out) }
        } catch (e: Throwable) {
            cb("error", 0, 0, "更新失败：" + describe(e).second)
        } finally {
            downloading = false
        }
    }

    private fun done(f: File) = f.length()

    /** Install, asking for the "install unknown apps" permission first if needed. */
    fun requestInstall(activity: Activity, apk: File) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            pendingApk = apk
            waitingInstallPermission = true
            Toast.makeText(activity, "请允许「安装未知应用」，返回后将继续更新", Toast.LENGTH_LONG).show()
            try {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            } catch (_: Exception) {
                try { activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) } catch (_: Exception) {}
            }
            return
        }
        pendingApk = null
        installWithSession(activity, apk)
    }

    /** Call from Activity.onResume: resumes an install that was waiting on the permission screen. */
    fun onResume(activity: Activity) {
        if (!waitingInstallPermission) return
        val apk = pendingApk
        waitingInstallPermission = false
        if (apk == null || !apk.exists()) return
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "未允许安装未知应用，无法完成更新", Toast.LENGTH_LONG).show()
            return
        }
        pendingApk = null
        installWithSession(activity, apk)
    }

    private fun installWithSession(ctx: Context, apk: File) {
        lastApk = apk
        try {
            val pi = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(ctx.packageName)
            params.setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 26) params.setInstallReason(PackageManager.INSTALL_REASON_USER)
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            val id = pi.createSession(params)
            pi.openSession(id).use { s ->
                s.openWrite("base.apk", 0, apk.length()).use { os ->
                    FileInputStream(apk).use { it.copyTo(os, 64 * 1024) }
                    s.fsync(os)
                }
                val intent = Intent(ctx, UpdateInstallReceiver::class.java).setAction(ACTION_INSTALL_STATUS)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getBroadcast(ctx, id, intent, flags)
                s.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            installWithIntent(ctx, apk)
        }
    }

    @Volatile var lastApk: File? = null

    /** Fallback: hand the APK to the system installer UI via FileProvider. */
    fun installWithIntent(ctx: Context, apk: File) {
        try {
            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", apk)
            @Suppress("DEPRECATION")
            val i = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
        } catch (e: Exception) {
            Toast.makeText(ctx, "无法打开安装程序：${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}

/** Receives PackageInstaller session status. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33)
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try { ctx.startActivity(confirm) } catch (_: Exception) {
                        Updater.lastApk?.let { Updater.installWithIntent(ctx, it) }
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> { /* app process is replaced; nothing to do */ }
            PackageInstaller.STATUS_FAILURE_ABORTED -> Toast.makeText(ctx, "已取消安装", Toast.LENGTH_SHORT).show()
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE) {
                    Toast.makeText(ctx, "安装失败：签名或版本不兼容${if (msg != null) "（$msg）" else ""}", Toast.LENGTH_LONG).show()
                } else {
                    // Some ROMs block session installs from apps; fall back to the system installer UI.
                    val apk = Updater.lastApk
                    if (apk != null && apk.exists()) Updater.installWithIntent(ctx, apk)
                    else Toast.makeText(ctx, "安装失败${if (msg != null) "：$msg" else ""}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}

/** Tiny key/value store (same API as myplayer's Kv). */
object Kv {
    fun get(ctx: Context, k: String): String? = ctx.getSharedPreferences("kv", 0).getString(k, null)
    fun set(ctx: Context, k: String, v: String) { ctx.getSharedPreferences("kv", 0).edit().putString(k, v).apply() }
}
