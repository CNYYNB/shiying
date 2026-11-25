package com.louis.shiying

import android.content.Context
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Log of the last YouTube parse (every attempt's options + full yt-dlp -v stderr) for ⋮ → 复制诊断日志.
 * Cookie values, tokens and visitor / sync ids are removed with [YtdlpSupport.redact] when the log is copied.
 */
class Diag private constructor(private val file: File) {
    private val sb = StringBuilder()

    fun line(s: String) { sb.append(s).append('\n'); flush() }

    fun attempt(name: String, options: List<String>, stderr: String) {
        sb.append("\n===== 尝试：").append(name).append(" =====\n")
        sb.append("选项：").append(options.joinToString(" ") { if (it.contains(' ')) "\"$it\"" else it }).append('\n')
        sb.append("yt-dlp 判断的登录状态：").append(
            when (YtdlpSupport.ytAuth(stderr)) {
                YtdlpSupport.YtAuth.OK -> "已登录（Found YouTube account cookies）"
                YtdlpSupport.YtAuth.ROTATED -> "cookies 已失效（no longer valid）"
                YtdlpSupport.YtAuth.NONE -> "未登录"
            }).append('\n')
        sb.append("结论：").append(if (stderr.isBlank()) "无输出" else YtdlpSupport.ytReason(stderr)).append('\n')
        sb.append("----- yt-dlp 输出 -----\n").append(stderr.takeLast(60_000)).append('\n')
        flush()
    }

    fun finish(result: String) { line("\n===== 结果：$result ====="); }

    private fun flush() = runCatching { file.parentFile?.mkdirs(); file.writeText(sb.toString()) }

    companion object {
        private fun file(ctx: Context) = File(ctx.filesDir, "diag/youtube-last.txt")

        fun start(ctx: Context, url: String, engine: String, cookies: Boolean, proxy: List<String>): Diag {
            val d = Diag(file(ctx))
            d.sb.append("拾影 ").append(Updater.currentName).append(" (").append(Updater.currentCode).append(") 诊断日志\n")
            d.sb.append("时间：").append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date())).append('\n')
            d.sb.append("设备：Android ").append(Build.VERSION.RELEASE).append(" / API ").append(Build.VERSION.SDK_INT)
                .append(" / ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append(" / ").append(Build.SUPPORTED_ABIS.firstOrNull()).append('\n')
            d.sb.append("链接：").append(url).append('\n')
            d.sb.append("解析引擎：yt-dlp ").append(engine).append('\n')
            d.sb.append("YouTube 登录 cookies：").append(if (cookies) "有（会传给 yt-dlp）" else "无（不传 cookies）").append('\n')
            d.sb.append("系统代理：").append(proxy.lastOrNull() ?: "无").append('\n')
            d.flush()
            return d
        }

        /** Redacted text of the last log, or null when there is none yet. */
        fun lastRedacted(ctx: Context): String? =
            file(ctx).takeIf { it.exists() && it.length() > 0 }?.readText()?.let { YtdlpSupport.redact(it) }
    }
}
