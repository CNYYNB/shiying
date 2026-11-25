package com.louis.shiying

import android.content.Context
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.louis.shiying.mtproto.TgDevice
import com.louis.shiying.mtproto.TlSchema
import java.io.File
import java.io.OutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Telegram settings / session encrypted with an AES-256-GCM key that lives in the Android Keystore (never leaves it, not in backups:
 * allowBackup=false). Files: filesDir/telegram/<name>.bin = 12-byte IV + ciphertext. If the Keystore is unusable nothing is written.
 */
class KeystoreTgStore(ctx: Context) : TgStore {
    private val dir = File(ctx.filesDir, "telegram")
    private val alias = "shiying_telegram_v1"

    private fun key(): SecretKey? = runCatching {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
    }.getOrNull()

    override val available: Boolean by lazy { key() != null }

    override fun read(name: String): String? = runCatching {
        val f = File(dir, "$name.bin"); if (!f.exists()) return null
        val b = f.readBytes()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key() ?: return null, GCMParameterSpec(128, b, 0, 12))
        String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
    }.getOrNull()

    override fun write(name: String, value: String): Boolean = runCatching {
        val k = key() ?: return false
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, k)
        val out = c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8))
        dir.mkdirs()
        val tmp = File(dir, "$name.bin.tmp"); tmp.writeBytes(out)
        if (!tmp.renameTo(File(dir, "$name.bin"))) { File(dir, "$name.bin").delete(); tmp.renameTo(File(dir, "$name.bin")) }
        true
    }.getOrDefault(false)

    override fun delete(name: String) { File(dir, "$name.bin").delete() }
}

/** App-wide Telegram objects (created on first use) + glue to the router, the download service and MediaStore. */
object Tg {
    @Volatile private var acc: TgAccount? = null
    @Volatile private var svc: TgService? = null
    private lateinit var app: Context
    private val schema by lazy {
        TlSchema(app.assets.open("telegram/schema.tl").bufferedReader().readText(), app.assets.open("telegram/api.tl").bufferedReader().readText())
    }

    fun init(ctx: Context) {
        app = ctx.applicationContext
        Extractor.telegram = object : Extractor.Telegram {
            override fun loggedIn() = account().loggedIn()
            override fun resolve(link: TgLink, log: (String) -> Unit): Post =
                try { service().resolve(link, log) { saveCover(it) } } catch (e: TgError) { throw UserError(e.message ?: "Telegram 出错了") }
        }
    }

    @Synchronized fun account(): TgAccount = acc ?: TgAccount(KeystoreTgStore(app), { schema },
        TgDevice("拾影 Android", "Android ${Build.VERSION.RELEASE}", Updater.currentName),
        systemProxy = {
            val h = System.getProperty("http.proxyHost"); val p = System.getProperty("http.proxyPort")?.toIntOrNull()
            if (!h.isNullOrBlank() && p != null && p > 0) h to p else null
        }).also { acc = it }

    @Synchronized fun service(): TgService = svc ?: TgService({ account().api() }) { account().log(it) }.also { svc = it }

    /** Cover bytes → cacheDir/tg-covers/… → "file://…" (MainActivity / Thumbs read it). */
    private fun saveCover(b: ByteArray): String? = runCatching {
        val d = File(app.cacheDir, "tg-covers").apply { mkdirs() }
        d.listFiles()?.sortedBy { it.lastModified() }?.dropLast(30)?.forEach { it.delete() }
        val f = File(d, "c${System.currentTimeMillis()}.jpg"); f.writeBytes(b)
        Uri.fromFile(f).toString()
    }.getOrNull()

    /** MediaStore sink for DownloadService: videos → Movies/拾影, images → Pictures/拾影; every entry registered for rollback. */
    class GallerySink(private val ctx: Context, private val cleanup: JobCleanup, private val uris: MutableList<String>) : TgSink {
        private val open = HashMap<Int, Saver.Target>()
        override fun open(index: Int, item: TgItem, baseName: String): OutputStream {
            val t = Saver.open(ctx, baseName, item.mime.ifEmpty { if (item.isVideo) "video/mp4" else "image/jpeg" }, item.isVideo)
            cleanup.addUri(t.uri.toString())
            open[index] = t
            return t.out
        }
        override fun commit(index: Int) { val t = open.remove(index) ?: return; Saver.finish(ctx, t.uri); uris += t.uri.toString() }
        override fun discard(index: Int) { val t = open.remove(index) ?: return; runCatching { t.out.close() }; Saver.discard(ctx, t.uri); cleanup.forgetUri(t.uri.toString()) }
    }
}
