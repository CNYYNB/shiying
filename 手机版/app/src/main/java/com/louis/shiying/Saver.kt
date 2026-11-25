package com.louis.shiying

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.OutputStream

/** Writes into public storage via MediaStore: Movies/拾影 for videos, Pictures/拾影 for images. */
object Saver {
    const val FOLDER = "拾影"

    class Target(val uri: Uri, val out: OutputStream)

    fun extFor(mime: String?, isVideo: Boolean): String {
        val m = mime?.lowercase().orEmpty()
        return when {
            isVideo && m.contains("webm") -> "webm"
            isVideo && (m.contains("matroska") || m.contains("mkv")) -> "mkv"
            isVideo -> "mp4"
            m.contains("png") -> "png"
            m.contains("webp") -> "webp"
            m.contains("heic") -> "heic"
            m.contains("gif") -> "gif"
            else -> "jpg"
        }
    }

    fun open(ctx: Context, baseName: String, mime: String, isVideo: Boolean): Target {
        val ext = extFor(mime, isVideo)
        val name = "$baseName.$ext"
        val realMime = if (isVideo) (when (ext) { "webm" -> "video/webm"; "mkv" -> "video/x-matroska"; else -> "video/mp4" }) else when (ext) { "png" -> "image/png"; "webp" -> "image/webp"; "heic" -> "image/heic"; "gif" -> "image/gif"; else -> "image/jpeg" }
        val cr = ctx.contentResolver
        val v = ContentValues()
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        v.put(MediaStore.MediaColumns.MIME_TYPE, realMime)
        v.put(MediaStore.MediaColumns.TITLE, baseName)
        val collection: Uri
        if (Build.VERSION.SDK_INT >= 29) {
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, (if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/" + FOLDER)
            v.put(MediaStore.MediaColumns.IS_PENDING, 1)
            collection = if (isVideo) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            // Android 7–9: needs WRITE_EXTERNAL_STORAGE (requested by MainActivity). MediaStore creates the file at DATA.
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), FOLDER)
            dir.mkdirs()
            var f = File(dir, name); var i = 1
            while (f.exists()) { f = File(dir, "$baseName ($i).$ext"); i++ }
            @Suppress("DEPRECATION")
            v.put(MediaStore.MediaColumns.DATA, f.absolutePath)
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
            collection = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val uri = cr.insert(collection, v) ?: throw java.io.IOException("无法在相册中创建文件（存储空间不足或没有权限）")
        val out = try { cr.openOutputStream(uri, "w") } catch (e: Exception) { null }
        if (out == null) { runCatching { cr.delete(uri, null, null) }; throw java.io.IOException("无法写入相册文件") }
        return Target(uri, out)
    }

    fun finish(ctx: Context, uri: Uri) {
        if (Build.VERSION.SDK_INT >= 29) {
            val v = ContentValues(); v.put(MediaStore.MediaColumns.IS_PENDING, 0)
            ctx.contentResolver.update(uri, v, null, null)
        }
    }

    /** Copies a finished yt-dlp output file into the gallery (cancellable). */
    fun importFile(ctx: Context, f: File, baseName: String, cleanup: JobCleanup?, cancelled: () -> Boolean, onProgress: (Long, Long) -> Unit): Uri {
        val ext = f.extension.lowercase()
        val isVideo = ext in setOf("mp4", "webm", "mkv", "mov", "m4v")
        val mime = when (ext) {
            "webm" -> "video/webm"; "mkv" -> "video/x-matroska"; "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"; "webp" -> "image/webp"
            "gif" -> "image/gif"; else -> if (isVideo) "video/mp4" else "image/jpeg"
        }
        val t = open(ctx, baseName, mime, isVideo)
        cleanup?.addUri(t.uri.toString())
        try {
            f.inputStream().use { ins -> t.out.use { os -> Transfer.copy(ins, os, f.length(), cancelled, onProgress = onProgress) } }
            finish(ctx, t.uri)
            return t.uri
        } catch (e: Throwable) {
            discard(ctx, t.uri); cleanup?.forgetUri(t.uri.toString()); throw e
        }
    }

    fun discard(ctx: Context, uri: Uri) { runCatching { ctx.contentResolver.delete(uri, null, null) } }

    fun exists(ctx: Context, uri: Uri): Boolean = try {
        ctx.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.moveToFirst() } ?: false
    } catch (e: Exception) { false }
}
