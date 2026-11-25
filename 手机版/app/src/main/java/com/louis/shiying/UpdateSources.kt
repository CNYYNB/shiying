package com.louis.shiying

import java.io.IOException
import java.net.URI

/** Pure helpers for the updater (JVM-testable): mirror list, APK URL resolution, error summary. */
object UpdateSources {
    class HttpError(val code: Int) : IOException("HTTP $code")

    /** Manifest URLs from BuildConfig.UPDATE_URLS (comma separated), in order. */
    fun manifestUrls(cfg: String): List<String> = cfg.split(',', ' ', '\n').map { it.trim() }.filter { it.startsWith("https://") }.distinct()

    /**
     * APK download candidates: version.json "apk" resolved against the manifest URL that served it,
     * then absolute "apkMirrors" entries (needed when the manifest mirror can't host a ~55 MB file, e.g. jsDelivr's 20 MB cap).
     */
    fun apkUrls(manifestUrl: String, apk: String, mirrors: List<String>): List<String> {
        val out = LinkedHashSet<String>()
        if (apk.startsWith("https://")) out += apk
        else if (apk.isNotBlank()) out += URI(manifestUrl).resolve(apk.trimStart('/').split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }).toString()
        out += mirrors.filter { it.startsWith("https://") }
        return out.toList()
    }

    enum class Kind { NO_NETWORK, NOT_PUBLISHED, BLOCKED, SERVER, BAD, OTHER }

    fun kindOf(e: Throwable): Kind = when (e) {
        is HttpError -> if (e.code == 404 || e.code == 403 || e.code == 410) Kind.NOT_PUBLISHED else Kind.SERVER
        is javax.net.ssl.SSLException, is java.net.SocketTimeoutException, is java.net.ConnectException,
        is java.net.NoRouteToHostException, is java.net.UnknownHostException, is java.net.SocketException -> Kind.BLOCKED
        is java.io.InterruptedIOException -> Kind.BLOCKED
        is org.json.JSONException, is IllegalArgumentException -> Kind.BAD
        is IOException -> if ((e.message ?: "").contains("reset", true) || (e.message ?: "").contains("closed", true)) Kind.BLOCKED else Kind.OTHER
        else -> Kind.OTHER
    }

    /** One clear Chinese message for the errors of all mirrors. [online] = the phone has a working network connection. */
    fun summarize(errors: List<Throwable>, online: Boolean): Pair<Kind, String> {
        if (!online) return Kind.NO_NETWORK to "无网络：手机当前没有连接到网络，请连上 Wi-Fi 或移动数据后再试"
        val kinds = errors.map { kindOf(it) }
        return when {
            kinds.isEmpty() -> Kind.OTHER to "检查更新失败"
            kinds.any { it == Kind.NOT_PUBLISHED } -> Kind.NOT_PUBLISHED to "更新服务器未上线（HTTP 404）：新版本还没有发布到更新服务器，请以后再试"
            kinds.all { it == Kind.BLOCKED } -> Kind.BLOCKED to "网络被拦截：连不上更新服务器（安全连接被重置 / 超时）。pages.dev 在国内常被拦截，请开启或切换 VPN 节点后再试"
            kinds.any { it == Kind.BAD } -> Kind.BAD to "更新服务器上的版本信息格式错误"
            kinds.any { it == Kind.SERVER } -> Kind.SERVER to "更新服务器出错（HTTP ${(errors.firstOrNull { it is HttpError } as? HttpError)?.code}），请稍后再试"
            else -> Kind.OTHER to "检查更新失败：${errors.last().javaClass.simpleName}${errors.last().message?.let { "（${it.take(60)}）" } ?: ""}"
        }
    }
}
