package com.louis.shiying

import android.content.Context
import android.net.Uri
import okhttp3.Call
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

class Cancelled : Exception("已取消")

/** Pure stream copy with cancellation and progress (JVM-testable). */
object Transfer {
    /**
     * Copies [ins] to [os]. [first] = bytes already read into [buf] (the caller peeks at the first chunk).
     * Checks [cancelled] before every write and throws [Cancelled] as soon as it turns true.
     */
    fun copy(ins: InputStream, os: OutputStream, total: Long, cancelled: () -> Boolean, buf: ByteArray = ByteArray(128 * 1024),
             first: Int = 0, onProgress: (Long, Long) -> Unit = { _, _ -> }): Long {
        var n = first
        var done = 0L
        var lastT = 0L
        if (n == 0) n = ins.read(buf)
        while (n >= 0) {
            if (cancelled()) throw Cancelled()
            if (n > 0) { os.write(buf, 0, n); done += n }
            val now = System.currentTimeMillis()
            if (now - lastT > 200) { lastT = now; onProgress(done, total) }
            n = ins.read(buf)
        }
        if (cancelled()) throw Cancelled()
        onProgress(done, if (total > 0) total else done)
        return done
    }
}

/**
 * Everything a download job created, so a cancel (or failure) can undo it:
 * temp files/dirs are deleted, gallery entries are removed through [deleteUri].
 */
class JobCleanup {
    private val files = mutableListOf<File>()
    private val uris = mutableListOf<String>()
    @Synchronized fun addFile(f: File) { files += f }
    @Synchronized fun addUri(u: String) { uris += u }
    @Synchronized fun forgetUri(u: String) { uris -= u }
    @Synchronized fun uris(): List<String> = uris.toList()

    /** Deletes temp files only (after a successful job). */
    @Synchronized fun deleteTemp() { files.forEach { it.deleteRecursively() }; files.clear() }

    /** Deletes temp files and every gallery entry this job wrote. */
    @Synchronized fun rollback(deleteUri: (String) -> Unit) {
        deleteTemp()
        uris.forEach { runCatching { deleteUri(it) } }
        uris.clear()
    }
}

/** Streams one media file (trying each candidate URL) into MediaStore. */
object Downloader {
    @Volatile var cancelRequested = false
    @Volatile private var currentCall: Call? = null

    /** Stops the running transfer right away (the stream read fails, the loop sees [cancelRequested]). */
    fun cancelNow() {
        cancelRequested = true
        runCatching { currentCall?.cancel() }
    }

    fun fetch(
        ctx: Context, urls: List<String>, headers: Map<String, String>, isVideo: Boolean, baseName: String,
        cleanup: JobCleanup? = null,
        onProgress: (done: Long, total: Long) -> Unit,
    ): Uri {
        if (urls.isEmpty()) throw UserError(if (isVideo) "没有找到可下载的视频地址" else "没有找到图片地址")
        var lastErr: String = "下载失败"
        for (url in urls.take(8)) {
            for (attempt in 0 until 2) {
                if (cancelRequested) throw Cancelled()
                val rb = Request.Builder().url(url)
                    .header("User-Agent", headers["User-Agent"] ?: Net.UA_IPHONE)
                    .header("Accept", "*/*")
                    .header("Accept-Language", "zh-CN,zh;q=0.9")
                headers["Referer"]?.let { rb.header("Referer", it) }
                var target: Saver.Target? = null
                try {
                    val call = Net.media.newCall(rb.get().build())
                    currentCall = call
                    call.execute().use { r ->
                        if (!r.isSuccessful) { lastErr = "服务器拒绝下载（HTTP ${r.code}）"; return@use null }
                        val body = r.body ?: run { lastErr = "服务器没有返回内容"; return@use null }
                        val ctype = body.contentType()?.toString().orEmpty()
                        if (ctype.contains("text/") || ctype.contains("json")) { lastErr = "下载地址返回的不是媒体文件"; return@use null }
                        val total = body.contentLength()
                        if (isVideo && total in 0 until 20_000) { lastErr = "视频文件过小，可能已失效"; return@use null }
                        val ins = body.byteStream()
                        val buf = ByteArray(128 * 1024)
                        // Read the first chunk before creating the gallery entry, to reject error pages.
                        val n = ins.read(buf)
                        if (n <= 0) { lastErr = "下载内容为空"; return@use null }
                        if (isVideo && n >= 8) {
                            val head = String(buf, 4, 4, Charsets.ISO_8859_1)
                            if (head != "ftyp" && head != "moov" && head != "mdat" && head != "free" && head != "skip" && head != "wide") {
                                lastErr = "下载地址返回的不是 MP4 视频"; return@use null
                            }
                        }
                        val t = Saver.open(ctx, baseName, if (isVideo) "video/mp4" else ctype, isVideo)
                        target = t
                        cleanup?.addUri(t.uri.toString())
                        val done = t.out.use { os -> Transfer.copy(ins, os, total, { cancelRequested }, buf, n, onProgress) }
                        if (total > 0 && done != total) throw IOException("下载不完整（$done/$total）")
                        Saver.finish(ctx, t.uri)
                        t.uri
                    }?.let { return it }
                    break // non-retryable for this url → next candidate
                } catch (e: Cancelled) {
                    target?.let { Saver.discard(ctx, it.uri); cleanup?.forgetUri(it.uri.toString()) }; throw e
                } catch (e: IOException) {
                    target?.let { Saver.discard(ctx, it.uri); cleanup?.forgetUri(it.uri.toString()) }
                    if (cancelRequested) throw Cancelled()
                    lastErr = e.message?.takeIf { it.startsWith("下载") || it.startsWith("无法") } ?: Extractor.netMessage(e)
                    Thread.sleep(800L * (attempt + 1))
                } catch (e: SecurityException) {
                    target?.let { Saver.discard(ctx, it.uri); cleanup?.forgetUri(it.uri.toString()) }
                    throw UserError("没有存储权限，无法保存到相册")
                } finally { currentCall = null }
            }
        }
        throw UserError(lastErr)
    }
}
