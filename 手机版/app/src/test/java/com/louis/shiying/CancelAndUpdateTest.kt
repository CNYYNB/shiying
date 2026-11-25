package com.louis.shiying

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files

class CancelAndUpdateTest {
    /** An endless stream that flips the cancel flag after a few reads: copy must stop with [Cancelled]. */
    @Test fun transferStopsOnCancel() {
        var reads = 0
        var cancelled = false
        val endless = object : InputStream() {
            override fun read(): Int = 1
            override fun read(b: ByteArray, off: Int, len: Int): Int { reads++; if (reads == 5) cancelled = true; return len }
        }
        val out = ByteArrayOutputStream()
        try {
            Transfer.copy(endless, out, -1, { cancelled }, ByteArray(1024))
            fail("expected Cancelled")
        } catch (e: Cancelled) { /* ok */ }
        assertEquals(5, reads)
        assertEquals(4 * 1024, out.size())   // nothing written after the flag turned true
    }

    @Test fun transferCopiesAll() {
        val data = ByteArray(300_000) { (it % 251).toByte() }
        val out = ByteArrayOutputStream()
        var last = 0L
        val n = Transfer.copy(ByteArrayInputStream(data), out, data.size.toLong(), { false }, ByteArray(4096)) { d, _ -> last = d }
        assertEquals(data.size.toLong(), n)
        assertEquals(data.size.toLong(), last)
        assertArrayEquals(data, out.toByteArray())
    }

    @Test fun rollbackDeletesTempAndGalleryEntries() {
        val dir = Files.createTempDirectory("dl").toFile()
        File(dir, "001-x.mp4.part").writeText("partial")
        File(dir, "001-x.f137.mp4").writeText("video stream")
        val c = JobCleanup()
        c.addFile(dir)
        c.addUri("content://media/external/video/media/1")
        c.addUri("content://media/external/video/media/2")
        c.forgetUri("content://media/external/video/media/2")   // already discarded by the downloader
        val deleted = mutableListOf<String>()
        c.rollback { deleted += it }
        assertFalse(dir.exists())
        assertEquals(listOf("content://media/external/video/media/1"), deleted)
        assertTrue(c.uris().isEmpty())
    }

    @Test fun deleteTempKeepsGallery() {
        val dir = Files.createTempDirectory("dl").toFile()
        val c = JobCleanup(); c.addFile(dir); c.addUri("content://a")
        c.deleteTemp()
        assertFalse(dir.exists())
        assertEquals(listOf("content://a"), c.uris())
    }

    // ---------------------------------------------------------------- updater

    @Test fun manifestMirrors() {
        val urls = UpdateSources.manifestUrls("https://shiying-louis.pages.dev/version.json, https://fastly.jsdelivr.net/gh/a/b@main/version.json,http://insecure/x")
        assertEquals(listOf("https://shiying-louis.pages.dev/version.json", "https://fastly.jsdelivr.net/gh/a/b@main/version.json"), urls)
    }

    @Test fun apkUrlResolution() {
        assertEquals(listOf("https://shiying-louis.pages.dev/shiying-2.0-arm64-v8a.apk", "https://mirror/x.apk"),
            UpdateSources.apkUrls("https://shiying-louis.pages.dev/version.json", "shiying-2.0-arm64-v8a.apk", listOf("https://mirror/x.apk", "ftp://no")))
        assertEquals(listOf("https://h/a/b.apk"), UpdateSources.apkUrls("https://h/a/version.json", "https://h/a/b.apk", emptyList()))
    }

    @Test fun updateErrorSummary() {
        val ssl = javax.net.ssl.SSLHandshakeException("Connection reset by peer")
        val nf = UpdateSources.HttpError(404)
        assertEquals(UpdateSources.Kind.NO_NETWORK, UpdateSources.summarize(listOf(java.net.UnknownHostException("x")), online = false).first)
        assertEquals(UpdateSources.Kind.BLOCKED, UpdateSources.summarize(listOf(ssl, java.net.SocketTimeoutException()), online = true).first)
        assertEquals(UpdateSources.Kind.NOT_PUBLISHED, UpdateSources.summarize(listOf(ssl, nf), online = true).first)
        assertTrue(UpdateSources.summarize(listOf(nf), true).second.contains("未上线"))
        assertTrue(UpdateSources.summarize(listOf(ssl), true).second.contains("网络被拦截"))
        assertTrue(UpdateSources.summarize(emptyList(), false).second.contains("无网络"))
    }
}
