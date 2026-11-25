package com.louis.shiying

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.zip.ZipFile

/** 2.3: Deno JS runtime via YTDLnis' Deno package. */
class DenoTest {
    /** GitHub releases API shape (fields YTDLnis reads: tag_name, assets[].name/size/browser_download_url; digest is GitHub's). */
    private val releases = """[
      {"tag_name":"ffmpeg-9.0.2","draft":false,"prerelease":false,"assets":[{"name":"app-arm64-v8a-release.apk","size":1,"browser_download_url":"https://x/ffmpeg.apk"}]},
      {"tag_name":"deno-2.7.7","draft":false,"prerelease":false,"assets":[
        {"name":"app-arm64-v8a-release.apk","size":91165390,"digest":"sha256:835568431693dd49f210bb7e82592692fd82940696fe892f9ebcee1fe859e614",
         "browser_download_url":"https://github.com/deniscerri/ytdlnis-packages/releases/download/deno-2.7.7/app-arm64-v8a-release.apk"},
        {"name":"app-x86_64-release.apk","size":94700000,"browser_download_url":"https://github.com/deniscerri/ytdlnis-packages/releases/download/deno-2.7.7/app-x86_64-release.apk"}]},
      {"tag_name":"deno-2.6.10","draft":false,"prerelease":false,"assets":[{"name":"app-arm64-v8a-release.apk","size":80000000,"browser_download_url":"https://x/old.apk"}]},
      {"tag_name":"deno-2.9.0","draft":true,"prerelease":false,"assets":[{"name":"app-arm64-v8a-release.apk","size":1,"browser_download_url":"https://x/draft.apk"}]}
    ]"""

    @Test fun abiSelection() {
        assertEquals("arm64-v8a", DenoSupport.assetAbi(listOf("arm64-v8a", "armeabi-v7a", "armeabi")))
        assertEquals("x86_64", DenoSupport.assetAbi(listOf("x86_64", "x86")))
        assertNull("no 32-bit ARM deno → QuickJS", DenoSupport.assetAbi(listOf("armeabi-v7a", "armeabi")))
    }

    @Test fun picksNewestDenoReleaseForAbi() {
        val r = DenoSupport.pickRelease(releases, "arm64-v8a")!!
        assertEquals("2.7.7", r.version)
        assertEquals(91165390L, r.size)
        assertEquals("835568431693dd49f210bb7e82592692fd82940696fe892f9ebcee1fe859e614", r.sha256)
        assertTrue(r.url.endsWith("deno-2.7.7/app-arm64-v8a-release.apk"))
        assertEquals("2.7.7", DenoSupport.pickRelease(releases, "x86_64")!!.version)
        assertNull(DenoSupport.pickRelease(releases, "armeabi-v7a"))
        assertNull(DenoSupport.pickRelease("""{"message":"API rate limit exceeded"}""", "arm64-v8a"))
        assertEquals(DenoSupport.FALLBACK.url, "https://github.com/deniscerri/ytdlnis-packages/releases/download/deno-2.7.7/app-arm64-v8a-release.apk")
        assertTrue(DenoSupport.compareVersions("2.10.0", "2.7.7") > 0)
    }

    @Test fun ldPathAppendedAfterPythonOnce() {
        val py = "/data/user/0/com.louis.shiying/no_backup/youtubedl-android/packages/python/usr/lib:/data/app/x/lib/arm64"
        val d = "/data/user/0/com.louis.shiying/no_backup/deno-runtime/usr/lib"
        val once = DenoSupport.appendLdPath(py, d)
        assertEquals("$py:$d", once)
        assertEquals(once, DenoSupport.appendLdPath(once, d))
        assertEquals(d, DenoSupport.appendLdPath(null, d))
    }

    @Test fun jsRuntimeArgs() {
        assertEquals(listOf("--js-runtimes", "deno:/data/app/~~a/com.deniscerri.ytdl.deno-b/lib/arm64/libdeno.so"),
            DenoSupport.jsRuntimeArgs("/data/app/~~a/com.deniscerri.ytdl.deno-b/lib/arm64/libdeno.so"))
        assertTrue(DenoSupport.jsRuntimeArgs(null).isEmpty())
    }

    @Test fun zipEntryFilterAndSymlinks() {
        assertTrue(DenoSupport.wantedZipEntry("usr/lib/libsqlite3.so.3.52.0"))
        assertTrue(DenoSupport.wantedZipEntry("usr/lib/libz.so.1"))
        assertTrue(DenoSupport.wantedZipEntry("usr/lib/libandroid.so"))
        assertFalse(DenoSupport.wantedZipEntry("usr/bin/deno"))
        assertFalse(DenoSupport.wantedZipEntry("usr/lib/pkgconfig/zlib.pc"))
        assertFalse(DenoSupport.wantedZipEntry("usr/include/zlib.h"))
        assertFalse(DenoSupport.wantedZipEntry("usr/lib/pkgIndex.tcl"))
        assertEquals("libz.so.1.3.2", DenoSupport.symlinkTarget("libz.so.1.3.2".toByteArray()))
        assertNull(DenoSupport.symlinkTarget(byteArrayOf(0x7f, 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte())))
    }

    /** Runs the entry filter + symlink detection over the real libdeno.zip.so from deno-2.7.7 when it is available locally. */
    @Test fun realDenoZip() {
        val f = File(System.getenv("DENO_ZIP") ?: "/tmp/deno/lib/arm64-v8a/libdeno.zip.so")
        assumeTrue(f.exists())
        val files = HashMap<String, Long>(); val links = HashMap<String, String>()
        ZipFile(f).use { z ->
            for (e in z.entries()) {
                if (e.isDirectory || !DenoSupport.wantedZipEntry(e.name)) continue
                val b = if (e.size in 0..128) z.getInputStream(e).use { it.readBytes() } else null
                val t = b?.let { DenoSupport.symlinkTarget(it) }
                if (t != null) links[e.name.substringAfterLast('/')] = t else files[e.name.substringAfterLast('/')] = e.size
            }
        }
        println("deno zip libs: files=$files links=$links")
        assertEquals("libz.so.1.3.2", links["libz.so.1"])
        assertEquals("libsqlite3.so.3.52.0", links["libsqlite3.so"])
        assertTrue(files.keys.containsAll(listOf("libz.so.1.3.2", "libsqlite3.so.3.52.0", "libandroid.so")))
        assertTrue("every link points at an extracted file", links.values.all { it in files })
    }

    @Test fun summaryHintsDenoOnlyWhenMissing() {
        val steps = listOf(YtdlpSupport.YtStep("解析引擎", "要求验证不是机器人"))
        assertTrue(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE, deno = false).contains("安装 Deno 引擎"))
        assertFalse(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE, deno = true).contains("安装 Deno"))
        assertFalse(YtdlpSupport.youtubeSummary(steps, YtdlpSupport.YtAuth.NONE, deno = null).contains("安装 Deno"))
        assertTrue(YtdlpSupport.jsProblem("WARNING: [youtube] [jsc] Error solving 2 challenge requests using \"deno\" provider: Error running deno process (returncode: 1)"))
    }
}
