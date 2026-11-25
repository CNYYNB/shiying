package com.louis.shiying

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/** 下载记录, newest first, kept in SharedPreferences as a JSON array (max 200). */
object History {
    data class Entry(
        val key: String, val id: String, val title: String, val author: String, val isImages: Boolean,
        val time: Long, var status: String, var message: String, val uris: MutableList<String>, val cover: String?,
        val platform: String = Platform.DOUYIN.name, val link: String = "",
    ) {
        val platformLabel: String get() = Platform.byName(platform)?.label ?: "抖音"
        /** Link used for 重新解析 / 复制链接 (old 1.0 entries have none: rebuild the douyin link). */
        val reparseLink: String get() = link.ifEmpty { "https://www.douyin.com/${if (isImages) "note" else "video"}/$id" }
        fun toJson(): JSONObject = JSONObject().put("key", key).put("id", id).put("title", title).put("author", author)
            .put("images", isImages).put("time", time).put("status", status).put("message", message)
            .put("uris", JSONArray(uris)).put("cover", cover ?: "")
            .put("platform", platform).put("link", link)

        companion object {
            fun from(o: JSONObject) = Entry(
                o.optString("key"), o.optString("id"), o.optString("title"), o.optString("author"), o.optBoolean("images"),
                o.optLong("time"), o.optString("status"), o.optString("message"),
                o.optJSONArray("uris")?.let { a -> (0 until a.length()).map { a.optString(it) }.toMutableList() } ?: mutableListOf(),
                o.optString("cover").ifEmpty { null },
                o.optString("platform").ifEmpty { Platform.DOUYIN.name },
                o.optString("link"),
            )
        }
    }

    private const val PREF = "history"
    private val lock = Any()
    private var cache: MutableList<Entry>? = null

    private fun load(ctx: Context): MutableList<Entry> {
        cache?.let { return it }
        val s = ctx.getSharedPreferences(PREF, 0).getString("list", "[]") ?: "[]"
        val list = try { JSONArray(s).let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(Entry::from) } } } catch (e: Exception) { emptyList() }
        return list.toMutableList().also { cache = it }
    }

    private fun save(ctx: Context, list: List<Entry>) {
        ctx.getSharedPreferences(PREF, 0).edit().putString("list", JSONArray(list.map { it.toJson() }).toString()).apply()
    }

    fun all(ctx: Context): List<Entry> = synchronized(lock) { load(ctx).map { it.copy(uris = it.uris.toMutableList()) } }

    fun put(ctx: Context, e: Entry) = synchronized(lock) {
        val l = load(ctx)
        l.removeAll { it.key == e.key }
        l.add(0, e)
        while (l.size > 200) Thumbs.delete(ctx, l.removeAt(l.size - 1).key)
        save(ctx, l)
    }

    fun update(ctx: Context, key: String, f: (Entry) -> Unit) = synchronized(lock) {
        val l = load(ctx)
        l.firstOrNull { it.key == key }?.let { f(it); save(ctx, l) }
    }

    fun remove(ctx: Context, key: String) = synchronized(lock) { val l = load(ctx); l.removeAll { it.key == key }; save(ctx, l); Thumbs.delete(ctx, key) }

    fun clear(ctx: Context) = synchronized(lock) { val l = load(ctx); l.clear(); save(ctx, l); Thumbs.clear(ctx) }

    /** Entries left "running" by a killed process become failed on start. */
    fun fixStale(ctx: Context, activeKeys: Set<String>) = synchronized(lock) {
        val l = load(ctx); var ch = false
        for (e in l) if (e.status == "running" && e.key !in activeKeys) { e.status = "failed"; e.message = "下载被中断"; ch = true }
        if (ch) save(ctx, l)
    }

    fun firstUri(e: Entry): Uri? = e.uris.firstOrNull()?.let { Uri.parse(it) }
}
