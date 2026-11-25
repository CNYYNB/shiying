package com.louis.shiying

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import okhttp3.Request
import java.io.File

/**
 * History thumbnails, saved locally when a download starts: remote cover urls expire (抖音 signed urls) or need a
 * Referer (微博 sinaimg, B站 hdslb), so a later redraw of the list from the url often came out blank.
 */
object Thumbs {
    fun file(ctx: Context, key: String): File = File(File(ctx.filesDir, "thumbs"), key.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".jpg")

    /** Referer that image CDNs of each platform accept. Pure. */
    fun refererFor(url: String, platform: Platform?, postReferer: String?): String? {
        val h = Links.host(url)
        return when {
            h.endsWith("sinaimg.cn") || h.endsWith("weibocdn.com") -> "https://weibo.com/"
            h.endsWith("hdslb.com") || h.endsWith("biliimg.com") -> "https://www.bilibili.com/"
            h.contains("douyinpic") || h.endsWith("douyin.com") || h.endsWith("byteimg.com") -> Net.REFERER
            h.endsWith("xhscdn.com") || h.endsWith("xiaohongshu.com") -> "https://www.xiaohongshu.com/"
            h.endsWith("yximgs.com") || h.endsWith("kwimgs.com") || h.endsWith("kuaishou.com") -> "https://www.kuaishou.com/"
            postReferer != null -> postReferer
            platform == Platform.WEIBO -> "https://weibo.com/"
            platform == Platform.BILIBILI -> "https://www.bilibili.com/"
            else -> null
        }
    }

    /** Download, shrink and store the cover. Blocking; failures are ignored (the list falls back to the media thumbnail). */
    fun save(ctx: Context, key: String, post: Post) {
        post.cover?.takeIf { it.startsWith("file:") }?.let { c ->
            runCatching {
                val bytes = java.io.File(android.net.Uri.parse(c).path ?: return).readBytes()
                val bmp = decode(bytes, 360) ?: return
                val f = file(ctx, key); f.parentFile?.mkdirs()
                f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            }
            return
        }
        val url = post.cover?.replaceFirst("http://", "https://")?.takeIf { it.startsWith("https://") } ?: return
        runCatching {
            val rb = Request.Builder().url(url).header("User-Agent", if (post.platform.native) Net.UA_IPHONE else Net.UA_DESKTOP)
            refererFor(url, post.platform, post.headers["Referer"])?.let { rb.header("Referer", it) }
            val bytes = Net.api.newCall(rb.build()).execute().use { r -> if (r.isSuccessful) r.body?.bytes() else null } ?: return
            if (bytes.size > 8 * 1024 * 1024) return
            val bmp = decode(bytes, 360) ?: return
            val f = file(ctx, key); f.parentFile?.mkdirs()
            f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        }
    }

    fun delete(ctx: Context, key: String) { runCatching { file(ctx, key).delete() } }
    fun clear(ctx: Context) { runCatching { File(ctx.filesDir, "thumbs").deleteRecursively() } }

    private fun decode(b: ByteArray, maxW: Int): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(b, 0, b.size, o)
        if (o.outWidth <= 0) return null
        var s = 1
        while (o.outWidth / (s * 2) >= maxW) s *= 2
        return BitmapFactory.decodeByteArray(b, 0, b.size, BitmapFactory.Options().apply { inSampleSize = s })
    }
}
