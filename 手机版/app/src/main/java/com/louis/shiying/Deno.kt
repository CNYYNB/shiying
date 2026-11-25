package com.louis.shiying

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import com.yausername.youtubedl_android.YoutubeDL
import org.json.JSONArray
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipFile

/**
 * Pure helpers for the Deno JS runtime (JVM-testable).
 *
 * How YTDLnis does it (deniscerri/ytdlnis v1.9.1.1 + main, core/packages/Deno.kt + PackageBase.kt + RuntimeManager.kt, read Nov 25 2026):
 * Deno is NOT a file in YTDLnis' own data dir (Android W^X forbids exec of downloaded files). It is a separate companion APK,
 * "YTDLnis Deno Package" (package com.deniscerri.ytdl.deno, extractNativeLibs=true), published as GitHub releases of
 * deniscerri/ytdlnis-packages (tag deno-<ver>, assets app-<abi>-release.apk; only arm64-v8a and x86_64 exist). Settings → Packages
 * downloads it and hands it to the system installer. YTDLnis then runs `<companion nativeLibraryDir>/libdeno.so` (a Termux build
 * of deno, linker64) — files in an installed APK's lib dir are executable — unzips `libdeno.zip.so` (usr/lib: sqlite, zlib,
 * libandroid stub…) into its own files and appends usr/lib to LD_LIBRARY_PATH, and passes `--js-runtimes deno:<libdeno.so>`
 * (plus quickjs) to yt-dlp. 拾影 does exactly the same, and reuses the companion app if YTDLnis already installed it.
 */
object DenoSupport {
    const val PACKAGE = "com.deniscerri.ytdl.deno"
    const val REPO = "deniscerri/ytdlnis-packages"
    const val RELEASES_API = "https://api.github.com/repos/$REPO/releases"
    /** Signing cert of the companion APK (CN=Denis Cerri), checked before install and before every use. */
    const val CERT_SHA256 = "263645cb5272eb290759fe1f59149ae24df6ce171e9f6666eead981d3fc64c95"
    /** Known-good release, used when the GitHub API is rate-limited / unreachable. */
    val FALLBACK = Release("2.7.7", "https://github.com/$REPO/releases/download/deno-2.7.7/app-arm64-v8a-release.apk",
        91_165_390L, "835568431693dd49f210bb7e82592692fd82940696fe892f9ebcee1fe859e614")

    data class Release(val version: String, val url: String, val size: Long, val sha256: String? = null)

    /** ABI suffix of the release asset for this device, or null when Deno has no build for it (32-bit ARM). */
    fun assetAbi(abis: List<String>): String? = when {
        abis.firstOrNull()?.startsWith("arm64") == true -> "arm64-v8a"
        abis.firstOrNull()?.startsWith("x86_64") == true -> "x86_64"
        abis.any { it == "arm64-v8a" } -> "arm64-v8a"
        else -> null
    }

    /** Newest "deno-<ver>" release with an asset for [abi] from the GitHub releases API JSON (array). */
    fun pickRelease(json: String, abi: String): Release? {
        val arr = runCatching { JSONArray(json) }.getOrNull() ?: return null
        val out = ArrayList<Release>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val tag = r.optString("tag_name")
            if (!tag.startsWith("deno-") || r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val assets = r.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                val name = a.optString("name")
                if (name.contains(abi) && name.endsWith(".apk")) {
                    val digest = a.optString("digest").removePrefix("sha256:").takeIf { it.length == 64 }
                    out += Release(tag.removePrefix("deno-"), a.optString("browser_download_url"), a.optLong("size"), digest)
                    break
                }
            }
        }
        return out.maxWithOrNull { a, b -> compareVersions(a.version, b.version) }
    }

    fun compareVersions(a: String, b: String): Int {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }; val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) { val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 }); if (c != 0) return c }
        return 0
    }

    /** LD_LIBRARY_PATH with Deno's lib dir appended (after Python's, the order YTDLnis uses), idempotent. */
    fun appendLdPath(current: String?, denoLib: String): String {
        val parts = (current ?: "").split(':').filter { it.isNotBlank() }
        return if (denoLib in parts) parts.joinToString(":") else (parts + denoLib).joinToString(":")
    }

    /** yt-dlp options that enable Deno (the library adds quickjs itself; yt-dlp prefers deno 1000 > quickjs 850, falls back on error). */
    fun jsRuntimeArgs(denoExe: String?): List<String> = if (denoExe.isNullOrBlank()) emptyList() else listOf("--js-runtimes", "deno:$denoExe")

    /** Entries of libdeno.zip.so worth extracting: shared libraries in usr/lib (no headers, docs, pkgconfig, or the 100 MB usr/bin/deno). */
    fun wantedZipEntry(name: String): Boolean =
        name.startsWith("usr/lib/") && !name.endsWith("/") && name.count { it == '/' } == 2 && Regex("""\.so(\.[0-9.]+)?$""").containsMatchIn(name)

    /** A zip "file" whose bytes are just another file name = a symlink stored without its unix mode bits (java.util.zip can't see them). */
    fun symlinkTarget(bytes: ByteArray): String? {
        if (bytes.isEmpty() || bytes.size > 128) return null
        val s = String(bytes, Charsets.UTF_8)
        return s.takeIf { Regex("""^[A-Za-z0-9._+\-]+$""").matches(it) && it.startsWith("lib") }
    }

    /** Chinese text for a download / network failure. */
    fun describeError(e: Throwable): String {
        val m = (e.message ?: e.javaClass.simpleName).lowercase()
        return when {
            m.contains("resolve") || m.contains("unknownhost") || m.contains("unable to resolve") -> "无法连接 GitHub（无网络或被拦截，国内需要开启 VPN）"
            m.contains("timeout") || m.contains("timed out") -> "连接 GitHub 超时（国内需要开启 VPN）"
            m.contains("ssl") || m.contains("reset") || m.contains("handshake") || m.contains("closed") -> "连接 GitHub 被拦截（国内需要开启 VPN）"
            m.contains("enospc") || m.contains("no space") -> "手机存储空间不足（需要约 200 MB）"
            else -> (e.message ?: e.javaClass.simpleName).take(80)
        }
    }
}

/** Android half: status, download + install of the companion APK, wiring into youtubedl-android. */
object Deno {
    data class Status(val supported: Boolean, val installed: Boolean, val version: String?, val exe: File?, val trusted: Boolean, val problem: String?) {
        val usable get() = installed && trusted && exe != null && problem == null
        fun describe(): String = when {
            !supported -> "本机 CPU（${Build.SUPPORTED_ABIS.firstOrNull()}）没有 Deno 版本，使用内置 QuickJS"
            !installed -> "未安装（使用内置 QuickJS）"
            !trusted -> "已安装 $version，但签名不是 YTDLnis 作者的，已忽略"
            problem != null -> "已安装 $version，但不可用：$problem"
            else -> "已安装 $version（${exe?.absolutePath}）"
        }
    }

    @Volatile private var ldPatched: String? = null
    @Volatile var downloading = false
        private set
    @Volatile private var cancelRequested = false

    fun status(ctx: Context): Status {
        val supported = DenoSupport.assetAbi(Build.SUPPORTED_ABIS.toList()) != null
        val pm = ctx.packageManager
        val pi: PackageInfo = try { packageInfo(pm) } catch (e: PackageManager.NameNotFoundException) {
            return Status(supported, false, null, null, false, null)
        } catch (e: Throwable) { return Status(supported, false, null, null, false, null) }
        val trusted = certOk(pi)
        val libDir = pi.applicationInfo?.nativeLibraryDir
        val exe = libDir?.let { File(it, "libdeno.so") }
        val problem = when {
            exe == null || !exe.exists() -> "找不到 libdeno.so（请重新安装 Deno 引擎）"
            !exe.canExecute() -> "libdeno.so 无法执行"
            else -> null
        }
        return Status(supported, true, pi.versionName, exe, trusted, problem)
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager): PackageInfo =
        if (Build.VERSION.SDK_INT >= 28) pm.getPackageInfo(DenoSupport.PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES)
        else pm.getPackageInfo(DenoSupport.PACKAGE, PackageManager.GET_SIGNATURES)

    @Suppress("DEPRECATION")
    private fun certOk(pi: PackageInfo?): Boolean {
        pi ?: return false
        val sigs = if (Build.VERSION.SDK_INT >= 28) pi.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory } else pi.signatures
        return sigs.orEmpty().any { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) } == DenoSupport.CERT_SHA256 }
    }

    /**
     * Deno executable to hand to yt-dlp, or null (→ QuickJS only). Prepares Deno's libraries (once per companion version)
     * and appends them to youtubedl-android's LD_LIBRARY_PATH, like YTDLnis' RuntimeManager.
     */
    fun prepare(ctx: Context): File? {
        val st = runCatching { status(ctx) }.getOrNull() ?: return null
        if (!st.usable) return null
        return runCatching {
            val lib = extractLibs(ctx, st)
            patchLdPath(lib.absolutePath)
            st.exe
        }.getOrElse { st.exe }   // libs are a nicety: Python's own usr/lib already has sqlite/zlib with every symbol deno needs
    }

    private fun extractLibs(ctx: Context, st: Status): File {
        val root = File(ctx.noBackupFilesDir, "deno-runtime")
        val lib = File(root, "usr/lib")
        val stamp = File(root, "version")
        val zip = File(st.exe!!.parentFile, "libdeno.zip.so")
        val want = "${st.version}:${zip.length()}"
        if (lib.isDirectory && stamp.exists() && stamp.readText() == want) return lib
        if (!zip.exists()) { lib.mkdirs(); return lib }
        root.deleteRecursively(); lib.mkdirs()
        val links = ArrayList<Pair<File, String>>()
        ZipFile(zip).use { z ->
            for (e in z.entries()) {
                if (e.isDirectory || !DenoSupport.wantedZipEntry(e.name)) continue
                val out = File(root, e.name)
                val bytes = if (e.size in 0..128) z.getInputStream(e).use { it.readBytes() } else null
                val target = bytes?.let { DenoSupport.symlinkTarget(it) }
                if (target != null) { links += out to target; continue }
                if (bytes != null) out.writeBytes(bytes) else z.getInputStream(e).use { ins -> out.outputStream().use { ins.copyTo(it, 64 * 1024) } }
            }
        }
        for ((f, target) in links) {
            runCatching { android.system.Os.symlink(target, f.absolutePath) }
                .onFailure { File(f.parentFile, target).takeIf { it.exists() }?.copyTo(f, overwrite = true) }
        }
        stamp.writeText(want)
        return lib
    }

    /** youtubedl-android 0.18.1 keeps LD_LIBRARY_PATH for the python process in a private static; append Deno's libs once. */
    private fun patchLdPath(dir: String) {
        if (ldPatched == dir) return
        val f = YoutubeDL::class.java.getDeclaredField("ENV_LD_LIBRARY_PATH").apply { isAccessible = true }
        f.set(null, DenoSupport.appendLdPath(f.get(null) as String?, dir))
        ldPatched = dir
    }

    fun cancel() { cancelRequested = true }

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000; readTimeout = 30_000; instanceFollowRedirects = true
            setRequestProperty("User-Agent", "Shiying/${Updater.currentName} (Android)")
            setRequestProperty("Accept", "application/vnd.github+json, */*")
        }

    /** Latest release for this device from the GitHub API (falls back to the known 2.7.7 asset). */
    fun latestRelease(abi: String): DenoSupport.Release {
        val fromApi = runCatching {
            val c = open(DenoSupport.RELEASES_API)
            try { if (c.responseCode == 200) DenoSupport.pickRelease(c.inputStream.bufferedReader().readText(), abi) else null } finally { c.disconnect() }
        }.getOrNull()
        if (fromApi != null) return fromApi
        if (abi != "arm64-v8a") throw IOException("无法读取 GitHub 上的 Deno 版本列表（国内需要开启 VPN）")
        return DenoSupport.FALLBACK
    }

    /**
     * Downloads the companion APK into cacheDir/deno/, checks its signer (+ SHA-256 when known) and opens the system installer.
     * [cb]: ("status", -1, text) / ("progress", pct, text) / ("error", 0, msg) / ("installing", 100, text) / ("cancelled", 0, "").
     */
    fun downloadAndInstall(activity: Activity, cb: (String, Int, String) -> Unit) {
        if (downloading) return
        downloading = true; cancelRequested = false
        try {
            val abi = DenoSupport.assetAbi(Build.SUPPORTED_ABIS.toList())
                ?: run { cb("error", 0, "本机是 32 位 CPU，Deno 没有这个版本，YouTube 将继续使用内置 QuickJS"); return }
            cb("status", -1, "正在读取 Deno 版本（GitHub）…")
            val rel = try { latestRelease(abi) } catch (e: Throwable) { cb("error", 0, "获取版本失败：" + DenoSupport.describeError(e)); return }
            val dir = File(activity.cacheDir, "deno").apply { mkdirs() }
            val out = File(dir, "deno-${rel.version}-$abi.apk")
            val part = File(dir, out.name + ".part")
            dir.listFiles()?.filter { it != out && it != part }?.forEach { it.delete() }
            if (!(out.exists() && rel.size > 0 && out.length() == rel.size)) {
                out.delete()
                val md = MessageDigest.getInstance("SHA-256")
                var done = if (part.exists()) part.length() else 0L
                // resume a broken download when possible (87 MB over a VPN)
                if (done > 0) part.inputStream().use { ins -> val b = ByteArray(64 * 1024); while (true) { val n = ins.read(b); if (n < 0) break; md.update(b, 0, n) } }
                val c = try { open(rel.url) } catch (e: IOException) { cb("error", 0, "下载失败：" + DenoSupport.describeError(e)); return }
                try {
                    if (done > 0) c.setRequestProperty("Range", "bytes=$done-")
                    val code = c.responseCode
                    if (code == 200 && done > 0) { done = 0; part.delete(); md.reset() }
                    if (code != 200 && code != 206) { cb("error", 0, if (code == 403 || code == 429) "GitHub 暂时限制了下载（HTTP $code），请过一会儿再试" else "下载失败（HTTP $code）"); return }
                    val total = if (rel.size > 0) rel.size else done + c.contentLengthLong
                    var lastPct = -2; var lastT = 0L
                    c.inputStream.use { ins ->
                        java.io.FileOutputStream(part, done > 0).use { os ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                if (cancelRequested) { cb("cancelled", 0, ""); return }
                                val n = ins.read(buf); if (n < 0) break
                                os.write(buf, 0, n); md.update(buf, 0, n); done += n
                                val pct = if (total > 0) (done * 100 / total).toInt() else -1
                                val t = System.currentTimeMillis()
                                if (pct != lastPct && (t - lastT > 200 || pct == 100)) {
                                    lastPct = pct; lastT = t
                                    cb("progress", pct, "正在下载 Deno ${rel.version}：${done / 1048576} / ${total / 1048576} MB")
                                }
                            }
                        }
                    }
                } catch (e: IOException) {
                    cb("error", 0, "下载中断：" + DenoSupport.describeError(e) + "（再点一次会接着下载）"); return
                } finally { c.disconnect() }
                if (rel.size > 0 && part.length() != rel.size) { cb("error", 0, "下载不完整（${part.length() / 1048576} MB），请重试"); return }
                val hex = md.digest().joinToString("") { "%02x".format(it) }
                if (rel.sha256 != null && !hex.equals(rel.sha256, true)) { part.delete(); cb("error", 0, "安装包校验失败（SHA-256 不一致），已删除"); return }
                if (!part.renameTo(out)) { part.copyTo(out, true); part.delete() }
            }
            @Suppress("DEPRECATION")
            val pi = if (Build.VERSION.SDK_INT >= 28) activity.packageManager.getPackageArchiveInfo(out.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
                else activity.packageManager.getPackageArchiveInfo(out.absolutePath, PackageManager.GET_SIGNATURES)
            if (pi == null || pi.packageName != DenoSupport.PACKAGE || (Build.VERSION.SDK_INT >= 28 && !certOk(pi))) {
                out.delete(); cb("error", 0, "下载的安装包无效（包名或签名不对），已删除"); return
            }
            cb("installing", 100, "下载完成，正在打开系统安装程序…")
            activity.runOnUiThread { install(activity, out) }
        } catch (e: Throwable) {
            cb("error", 0, "安装失败：" + DenoSupport.describeError(e))
        } finally { downloading = false }
    }

    private fun install(activity: Activity, apk: File) {
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
            @Suppress("DEPRECATION")
            activity.startActivity(Intent(Intent.ACTION_INSTALL_PACKAGE).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: Exception) {
            android.widget.Toast.makeText(activity, "无法打开安装程序：${e.message}", android.widget.Toast.LENGTH_LONG).show()
        }
    }

    /** After a successful install the 87 MB APK is no longer needed. */
    fun cleanupDownloads(ctx: Context) { runCatching { if (status(ctx).installed) File(ctx.cacheDir, "deno").deleteRecursively() } }
}
