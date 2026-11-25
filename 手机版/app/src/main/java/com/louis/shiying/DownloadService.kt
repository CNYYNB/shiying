package com.louis.shiying

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/** Progress events for the UI (always delivered on the main thread). status: running / done / partial / failed / cancelled. */
object Bus {
    data class State(val key: String, val status: String, val pct: Int, val text: String)
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(State) -> Unit>()
    val states = ConcurrentHashMap<String, State>()
    fun add(l: (State) -> Unit) { listeners += l }
    fun remove(l: (State) -> Unit) { listeners -= l }
    fun post(s: State) {
        states[s.key] = s
        main.post { listeners.toList().forEach { it(s) } }
    }
}

/** Foreground service that runs download jobs one at a time, shows notification progress and a 取消 action. */
class DownloadService : Service() {
    class Job(val key: String, val post: Post)

    companion object {
        private const val CH = "downloads"
        private const val NOTIF_ID = 1001
        const val ACTION_CANCEL = "com.louis.shiying.CANCEL_DOWNLOAD"
        const val EXTRA_KEY = "key"
        private val queue = ConcurrentLinkedQueue<Job>()
        val active: MutableSet<String> = ConcurrentHashMap.newKeySet()
        @Volatile var runningKey: String? = null
            private set

        fun enqueue(ctx: Context, post: Post): String {
            val key = "${post.platform.name.lowercase()}-${post.id.take(40)}-${System.currentTimeMillis()}"
            History.put(ctx, History.Entry(key, post.id, post.title, post.author, post.isImages, System.currentTimeMillis(),
                "running", "等待下载", mutableListOf(), post.cover, post.platform.name, post.link))
            active += key
            val app = ctx.applicationContext
            Thread({ Thumbs.save(app, key, post) }, "thumb").start()
            queue += Job(key, post)
            Bus.post(Bus.State(key, "running", -1, "等待下载…"))
            ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java))
            return key
        }

        /** Cancel one job: a queued one is dropped, the running one is stopped (transfer, yt-dlp and ffmpeg) and rolled back. */
        fun cancel(ctx: Context, key: String?) {
            val k = key ?: runningKey ?: return
            val q = queue.firstOrNull { it.key == k }
            if (q != null && queue.remove(q)) {
                active -= k
                History.update(ctx, k) { it.status = "cancelled"; it.message = "已取消下载" }
                Bus.post(Bus.State(k, "cancelled", -1, "已取消下载"))
                return
            }
            if (k == runningKey) {
                Downloader.cancelNow()
                Engine.cancel(k)
            }
        }

        fun cancelAll() { queue.clear(); Downloader.cancelNow(); runningKey?.let { Engine.cancel(it) } }

        fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT >= 26) {
                val nm = ctx.getSystemService(NotificationManager::class.java)
                if (nm.getNotificationChannel(CH) == null)
                    nm.createNotificationChannel(NotificationChannel(CH, "下载进度", NotificationManager.IMPORTANCE_LOW))
            }
        }
    }

    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var running = false
    private var lastNotif = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel(this)
        if (intent?.action == ACTION_CANCEL) {
            cancel(this, intent.getStringExtra(EXTRA_KEY))
            if (!running && queue.isEmpty()) { stopSelf(); return START_NOT_STICKY }
            return START_NOT_STICKY
        }
        val n = notif("准备下载…", -1, true)
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n,
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        } catch (e: Exception) { /* foreground not allowed right now: still run the work */ }
        if (!running) {
            running = true
            exec.execute { loop() }
        }
        return START_NOT_STICKY
    }

    private fun notif(text: String, pct: Int, ongoing: Boolean): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(this, CH)
            .setSmallIcon(if (ongoing) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_download_done)
            .setContentTitle("拾影")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setContentIntent(pi)
        if (ongoing) {
            b.setProgress(100, pct.coerceAtLeast(0), pct < 0)
            val ci = Intent(this, DownloadService::class.java).setAction(ACTION_CANCEL).putExtra(EXTRA_KEY, runningKey)
            val cpi = PendingIntent.getService(this, 1, ci, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消", cpi)
        }
        return b.build()
    }

    private fun showNotif(text: String, pct: Int, ongoing: Boolean, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastNotif < 500) return
        lastNotif = now
        try { getSystemService(NotificationManager::class.java).notify(if (ongoing) NOTIF_ID else NOTIF_ID + 1, notif(text, pct, ongoing)) } catch (_: Exception) {}
    }

    private fun loop() {
        try {
            while (true) {
                val job = queue.poll() ?: break
                Downloader.cancelRequested = false
                runningKey = job.key
                try { run(job) } finally { runningKey = null; active -= job.key }
            }
        } finally {
            running = false
            Handler(Looper.getMainLooper()).post {
                if (queue.isEmpty() && !running) {
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                } else if (!running) { running = true; exec.execute { loop() } }
            }
        }
    }

    private fun run(job: Job) {
        val p = job.post
        val base = Links.fileBase(p.author, p.title, p.id, p.platform.label)
        val uris = mutableListOf<String>()
        val cleanup = JobCleanup()
        fun progress(text: String, pct: Int) {
            Bus.post(Bus.State(job.key, "running", pct, text))
            showNotif(text, pct, true)
        }
        try {
            if (p.engine == "telegram") {
                // MTProto (TgService): every file straight into MediaStore; a cancel / failure rolls back the whole job
                progress("正在连接 Telegram…", -1)
                try {
                    Tg.service().download(p, Tg.GallerySink(this, cleanup, uris), { Downloader.cancelRequested }, { text, pct -> progress(text, pct) })
                } catch (e: TgError) {
                    // like the PC version: files that finished stay (a cancel still removes everything)
                    if (uris.isEmpty() || Downloader.cancelRequested) throw e
                    cleanup.deleteTemp()
                    finish(job, "partial", "已保存 ${uris.size}/${p.tg?.items?.size ?: uris.size} 个文件，其余失败：${e.message}", uris); return
                }
            } else if (p.engine == "ytdlp") {
                runYtdlp(job, base, cleanup, uris, ::progress)
            } else if (!p.isImages) {
                val urls = Quality.order(p.videoUrls, p.heights, p.qualityOverride ?: Engine.quality(this))
                Downloader.fetch(this, urls, p.headers, true, base, cleanup) { done, total ->
                    progress("下载视频 " + sizeText(done, total), pct(done, total))
                }.let { uris += it.toString() }
            } else {
                val n = p.images.size
                val withLive = p.images.count { it.liveVideoUrls.isNotEmpty() }
                var failed = 0
                p.images.forEachIndexed { i, img ->
                    val name = if (n > 1) "$base-${i + 1}" else base
                    try {
                        Downloader.fetch(this, img.urls, p.headers, false, name, cleanup) { done, total ->
                            progress("图片 ${i + 1}/$n " + sizeText(done, total), (i * 100 + pct(done, total).coerceAtLeast(0)) / n)
                        }.let { uris += it.toString() }
                    } catch (e: Cancelled) { throw e } catch (e: Exception) { failed++ }
                    if (img.liveVideoUrls.isNotEmpty()) {
                        try {
                            Downloader.fetch(this, img.liveVideoUrls, p.headers, true, "$name-实况", cleanup) { done, total ->
                                progress("实况 ${i + 1}/$n " + sizeText(done, total), (i * 100 + pct(done, total).coerceAtLeast(0)) / n)
                            }.let { uris += it.toString() }
                        } catch (e: Cancelled) { throw e } catch (e: Exception) { failed++ }
                    }
                }
                val totalFiles = n + withLive
                if (uris.isEmpty()) throw UserError("图片全部下载失败，请稍后重试")
                if (failed > 0) {
                    cleanup.deleteTemp()
                    finish(job, "partial", "已保存 ${uris.size}/$totalFiles 个文件，$failed 个失败", uris); return
                }
            }
            cleanup.deleteTemp()
            if (Downloader.cancelRequested) throw Cancelled()
            val msg = when {
                p.engine == "telegram" && uris.size > 1 -> "已保存 ${uris.size} 个文件到 相册/拾影"
                p.isImages -> "已保存 ${uris.size} 个文件到 相册/拾影"
                uris.size > 1 -> "已保存 ${uris.size} 个视频到 相册/Movies/拾影"
                else -> "已保存到 相册/Movies/拾影"
            }
            finish(job, "done", msg, uris)
        } catch (e: Cancelled) {
            cleanup.rollback { Saver.discard(this, Uri.parse(it)) }
            finish(job, "cancelled", "已取消下载", emptyList())
        } catch (e: UserError) {
            cleanup.rollback { Saver.discard(this, Uri.parse(it)) }
            finish(job, "failed", e.message ?: "下载失败", emptyList())
        } catch (e: TgError) {
            cleanup.rollback { Saver.discard(this, Uri.parse(it)) }
            finish(job, "failed", e.message ?: "下载失败", emptyList())
        } catch (e: Exception) {
            cleanup.rollback { Saver.discard(this, Uri.parse(it)) }
            finish(job, "failed", "下载失败：" + (e.message ?: e.javaClass.simpleName), emptyList())
        }
    }

    /** yt-dlp path: download (and merge) into a private temp dir, then copy each file into the gallery. */
    private fun runYtdlp(job: Job, base: String, cleanup: JobCleanup, uris: MutableList<String>, progress: (String, Int) -> Unit) {
        val p = job.post
        val dir = File(cacheDir, "dl/${job.key}").apply { deleteRecursively(); mkdirs() }
        cleanup.addFile(dir)
        progress("正在下载…", -1)
        var lastLine = ""
        val files = Engine.download(this, p, dir, job.key) { pct, line ->
            if (Downloader.cancelRequested) return@download
            if (line.contains("[Merger]") || line.contains("[VideoRemuxer]") || line.contains("[FixupM3u8]")) { progress("正在合并音视频…", -1); return@download }
            val m = Regex("""(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+\s*\S+)""").find(line)
            if (m != null || pct > 0) {
                val part = Regex("""Downloading item (\d+) of (\d+)""").find(lastLine)?.let { " ${it.groupValues[1]}/${it.groupValues[2]}" } ?: ""
                progress("下载中$part ${pct.toInt().coerceIn(0, 100)}%" + (m?.let { " · ${it.groupValues[2]}" } ?: ""), pct.toInt().coerceIn(0, 100))
            }
            if (line.contains("Downloading item")) lastLine = line
        }
        if (Downloader.cancelRequested) throw Cancelled()
        files.forEachIndexed { i, f ->
            val name = if (files.size > 1) "$base-${i + 1}" else base
            progress("正在保存到相册${if (files.size > 1) " ${i + 1}/${files.size}" else ""}…", -1)
            Saver.importFile(this, f, name, cleanup, { Downloader.cancelRequested }) { _, _ -> }.let { uris += it.toString() }
            f.delete()
        }
    }

    private fun finish(job: Job, status: String, msg: String, uris: List<String>) {
        History.update(this, job.key) { it.status = status; it.message = msg; it.uris.clear(); it.uris.addAll(uris) }
        Bus.post(Bus.State(job.key, status, if (status == "failed" || status == "cancelled") -1 else 100, msg))
        if (status == "cancelled") {
            runCatching { getSystemService(NotificationManager::class.java).cancel(NOTIF_ID + 1) }
            showNotif("已取消下载：${job.post.title.take(20)}", 100, false, force = true)
        } else showNotif("${job.post.title.take(20)}：$msg", 100, false, force = true)
    }

    private fun pct(done: Long, total: Long) = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else -1

    private fun sizeText(done: Long, total: Long): String {
        fun mb(b: Long) = "%.1f MB".format(b / 1048576.0)
        return if (total > 0) "${mb(done)} / ${mb(total)}" else mb(done)
    }

    override fun onDestroy() { exec.shutdown(); super.onDestroy() }
}
