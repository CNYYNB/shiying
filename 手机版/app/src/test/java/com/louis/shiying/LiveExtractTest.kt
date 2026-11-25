package com.louis.shiying

import okhttp3.Authenticator
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

/**
 * Live test, opt-in: SHIYING_LIVE=1 gradle :app:testReleaseUnitTest (see tools/run-live-test.sh).
 * - Native platforms (抖音/快手/小红书): the real Kotlin [Extractor.route] + a range fetch of the first media URL (checks ftyp / image bytes).
 * - yt-dlp platforms: the same [Extractor.route] (short-link expansion, URL normalisation), then the sandbox's python3 + yt-dlp run
 *   with exactly the options the app builds ([YtdlpSupport.infoOptions] / [YtdlpSupport.downloadOptions]) and the output parsed by
 *   [YtdlpSupport.parseInfo]. With SHIYING_LIVE_DL=1 the video is really downloaded (+ merged by ffmpeg) and checked with ffprobe.
 *   The app ships Python 3.12 + yt-dlp too, so this exercises the same extractor code; only the Android process wrapper differs.
 * Uses HTTPS_PROXY from the environment when set (sandbox).
 */
class LiveExtractTest {
    private fun setup() {
        assumeTrue(System.getenv("SHIYING_LIVE") == "1")
        val p = System.getenv("HTTPS_PROXY") ?: System.getenv("https_proxy")
        val b = OkHttpClient.Builder()
        if (!p.isNullOrBlank()) {
            val u = URI(p)
            b.proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(u.host, u.port)))
            val ui = u.rawUserInfo
            if (ui != null) {
                val user = URLDecoder.decode(ui.substringBefore(':'), "UTF-8"); val pw = URLDecoder.decode(ui.substringAfter(':'), "UTF-8")
                b.proxyAuthenticator(Authenticator { _, resp -> resp.request.newBuilder().header("Proxy-Authorization", Credentials.basic(user, pw)).build() })
            }
        }
        Net.clientOverride = Net.build(b)
    }

    private fun probe(url: String, headers: Map<String, String>): String {
        val rb = Request.Builder().url(url).header("User-Agent", headers["User-Agent"] ?: Net.UA_IPHONE).header("Range", "bytes=0-65535")
        headers["Referer"]?.let { rb.header("Referer", it) }
        Net.api.newCall(rb.build()).execute().use { r ->
            val b = r.body!!.bytes()
            val head = if (b.size >= 8) String(b, 4, 4, Charsets.ISO_8859_1) else ""
            val img = b.size > 3 && ((b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte()) || String(b, 0, 4, Charsets.ISO_8859_1) == "RIFF" || b[1] == 'P'.code.toByte())
            return "HTTP ${r.code} ${r.header("Content-Type")} head=$head${if (img) " image" else ""} host=${r.request.url.host}"
        }
    }

    private fun sh(cmd: List<String>, timeoutS: Long): Triple<Int, String, String> {
        val out = File.createTempFile("ytout", ".txt"); val err = File.createTempFile("yterr", ".txt")
        val p = ProcessBuilder(cmd).redirectOutput(out).redirectError(err).start()
        if (!p.waitFor(timeoutS, TimeUnit.SECONDS)) { p.destroyForcibly(); return Triple(-1, out.readText(), "timeout after ${timeoutS}s\n" + err.readText()) }
        return Triple(p.exitValue(), out.readText(), err.readText()).also { out.delete(); err.delete() }
    }

    private fun ytdlp(url: String, platform: Platform): String {
        val py = System.getenv("SHIYING_PYTHON") ?: "python3"
        val (code, out, err) = sh(listOf(py, "-m", "yt_dlp") + YtdlpSupport.infoOptions(platform, "1080", null) + url, 120)
        if (code != 0 || out.isBlank() || out.trim() == "null") return "FAIL [${platform.label}] ${YtdlpSupport.errorMessage(err, platform)} | raw: ${YtdlpSupport.errorLine(err).take(150)}"
        val info = File.createTempFile("info", ".json").apply { writeText(out) }
        val p = YtdlpSupport.parseInfo(out, platform, url, info.absolutePath)
        var dl = ""
        if (System.getenv("SHIYING_LIVE_DL") == "1") {
            val dir = File.createTempFile("shiying-dl", "").apply { delete(); mkdirs() }
            val (c2, _, e2) = sh(listOf(py, "-m", "yt_dlp") + YtdlpSupport.downloadOptions(platform, "1080", null, info.absolutePath, dir.absolutePath), 300)
            val f = dir.listFiles()?.filter { !it.name.endsWith(".part") && !Regex("""\.f\d+\.""").containsMatchIn(it.name) }?.maxByOrNull { it.length() }
            dl = if (c2 != 0 || f == null) " | DL FAIL ${YtdlpSupport.errorMessage(e2, platform)} ${YtdlpSupport.errorLine(e2).take(100)}" else {
                val (_, probeOut, _) = sh(listOf("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,height", "-of", "csv=p=0", f.absolutePath), 30)
                " | DL ${f.name.substringAfterLast('.')} ${"%.1f".format(f.length() / 1048576.0)}MB streams=[${probeOut.trim().replace('\n', ' ')}]"
            }
            dir.deleteRecursively()
        }
        info.delete()
        return "OK   [${platform.label}] ${p.height}p x${p.entries} ${Parser.formatDuration(p.durationMs)} @${p.author.take(20)} 《${p.title.take(20).replace('\n', ' ')}》$dl"
    }

    @Test fun live() {
        setup()
        val inputs = (System.getenv("SHIYING_INPUTS") ?: "").split('|').map { it.trim() }.filter { it.isNotBlank() && !it.startsWith("#") }
        var ok = 0
        for (i in inputs) {
            val line = try {
                when (val r = Extractor.route(i)) {
                    is Extractor.Route.Native -> {
                        val p = r.post
                        val check = if (p.isImages) probe(p.images[0].urls[0], p.headers) else probe(p.videoUrls[0], p.headers)
                        val good = check.startsWith("HTTP 20") && (if (p.isImages) check.contains("image") || check.contains("image/") else check.contains("head=ftyp"))
                        "${if (good) "OK  " else "BAD "} [${p.platform.label}] ${p.id} ${if (p.isImages) "图集x${p.images.size} live=${p.liveCount}" else "视频 ${Parser.formatDuration(p.durationMs)}"} @${p.author} 《${p.title.take(16)}》 | $check"
                    }
                    is Extractor.Route.Ytdlp -> ytdlp(r.url, r.platform) + "  <- ${r.url.take(70)}"
                }
            } catch (e: PostUnavailable) { "UNAV ${i.take(60)} -> ${e.reason}: ${e.message}" }
            catch (e: NeedFallback) { "FALL ${i.take(60)} -> ${e.why}" }
            catch (e: Exception) { "ERR  ${i.take(60)} -> ${e.javaClass.simpleName}: ${e.message}" }
            if (line.startsWith("OK")) ok++
            println("LIVE| $line")
        }
        println("LIVE| summary ok=$ok/${inputs.size}")
    }
}
