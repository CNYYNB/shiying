package com.louis.shiying

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/** Telegram login with the user's own api_id / api_hash (phone → code → 2FA password), proxy + 测试连接, 退出登录. All Chinese. */
class TelegramActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val bg = Executors.newSingleThreadExecutor()
    private lateinit var state: TextView
    private lateinit var stateSub: TextView
    private lateinit var msg: TextView
    private lateinit var busy: ProgressBar
    private lateinit var apiId: EditText
    private lateinit var apiHash: EditText
    private lateinit var phone: EditText
    private lateinit var proxy: EditText
    private lateinit var code: EditText
    private lateinit var password: EditText
    private var working = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_telegram)
        state = findViewById(R.id.state); stateSub = findViewById(R.id.stateSub); msg = findViewById(R.id.msg); busy = findViewById(R.id.busy)
        apiId = findViewById(R.id.apiId); apiHash = findViewById(R.id.apiHash); phone = findViewById(R.id.phone); proxy = findViewById(R.id.proxy)
        code = findViewById(R.id.code); password = findViewById(R.id.password)
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        val guide = findViewById<TextView>(R.id.guide)
        guide.text = GUIDE
        val toggle = findViewById<TextView>(R.id.guideToggle)
        toggle.setOnClickListener {
            val show = guide.visibility != View.VISIBLE
            guide.visibility = if (show) View.VISIBLE else View.GONE
            toggle.text = (if (show) "▾" else "▸") + " 第一步：申请 api_id 和 api_hash（只需要做一次" + (if (show) "）" else "，点开看步骤）")
        }
        findViewById<TextView>(R.id.help).text = HELP
        findViewById<View>(R.id.btnTest).setOnClickListener { testConnection() }
        findViewById<View>(R.id.btnSend).setOnClickListener { sendCode() }
        findViewById<View>(R.id.btnResend).setOnClickListener { run("正在重新发送验证码…", { Tg.account().resendCode() }) { setMsg("验证码已重新发送", ok = true) } }
        findViewById<View>(R.id.btnSignIn).setOnClickListener { signIn() }
        findViewById<View>(R.id.btnPassword).setOnClickListener { submitPassword() }
        findViewById<View>(R.id.btnLogout).setOnClickListener { confirmLogout() }
        findViewById<View>(R.id.btnDiag).setOnClickListener { copyDiag() }

        val st = Tg.account().status()
        apiId.setText(st.apiId)
        if (st.hasApiHash) apiHash.hint = "已保存（不用重填；要换就在这里重新粘贴）"
        proxy.setText(st.proxy)
        if (!st.apiIdSet) { guide.visibility = View.VISIBLE; toggle.text = "▾ 第一步：申请 api_id 和 api_hash（只需要做一次）" }
        render()
    }

    override fun onDestroy() { bg.shutdown(); super.onDestroy() }

    private fun render() {
        val st = Tg.account().status()
        if (st.loggedIn) {
            state.text = "✓ 已登录" + listOfNotNull(st.name.ifBlank { null }, st.username.ifBlank { null }?.let { "@$it" }).joinToString(" ").let { if (it.isEmpty()) "" else "：$it" }
            state.setTextColor(ContextCompat.getColor(this, R.color.ok))
            stateSub.text = "现在可以粘贴 Telegram 消息链接下载了（公开频道、私密频道 t.me/c/…、群组、话题、评论区）。\n代理：${st.proxyDesc}" +
                if (!st.encryption) "\n注意：本机加密存储不可用，登录只保持到拾影被关闭。" else ""
            findViewById<View>(R.id.loggedBox).visibility = View.VISIBLE
            findViewById<View>(R.id.form).visibility = View.GONE
        } else {
            state.text = "未登录"
            state.setTextColor(ContextCompat.getColor(this, R.color.text))
            stateSub.text = "不登录也能下载公开频道里的视频（交给解析引擎）。私密频道 / 群组、评论区、图片和相册需要登录。\n代理：${st.proxyDesc}"
            findViewById<View>(R.id.loggedBox).visibility = View.GONE
            findViewById<View>(R.id.form).visibility = View.VISIBLE
        }
    }

    private fun setMsg(text: String, error: Boolean = false, ok: Boolean = false) {
        msg.text = text
        msg.setTextColor(ContextCompat.getColor(this, when { error -> R.color.error; ok -> R.color.ok; else -> R.color.text2 }))
    }

    private fun hideKeyboard() = runCatching { (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(msg.windowToken, 0) }

    /** Runs [f] in the background with the busy UI; errors are shown in Chinese. */
    private fun <T> run(status: String, f: () -> T, done: (T) -> Unit = {}): Boolean {
        if (working) return false
        working = true
        hideKeyboard()
        busy.visibility = View.VISIBLE
        setButtons(false)
        setMsg(status)
        bg.execute {
            val r = runCatching { f() }
            main.post {
                if (isFinishing) return@post
                working = false
                busy.visibility = View.GONE
                setButtons(true)
                r.onSuccess { done(it) }.onFailure { e -> setMsg(TgSupport.classify(e, "login").message ?: "出错了", error = true) }
            }
        }
        return true
    }

    private fun setButtons(on: Boolean) {
        for (id in listOf(R.id.btnTest, R.id.btnSend, R.id.btnSignIn, R.id.btnPassword, R.id.btnLogout)) findViewById<Button>(id).isEnabled = on
    }

    private fun apiHashText(): String = apiHash.text.toString().trim().ifEmpty { if (Tg.account().status().hasApiHash) SAVED else "" }

    private fun testConnection() {
        val p = proxy.text.toString()
        run("正在测试连接 Telegram…", { Tg.account().testConnection(p) }) { via ->
            setMsg("✓ 连接成功（$via）", ok = true); render()
        }
    }

    private fun sendCode() {
        val id = apiId.text.toString(); val hash = apiHashText(); val ph = phone.text.toString(); val p = proxy.text.toString()
        run("正在发送验证码…", {
            val acc = Tg.account()
            acc.sendCode(id, if (hash == SAVED) acc.savedApiHash() else hash, ph, p)
        }) { st ->
            if (st.step == "done") { onLoggedIn(st); return@run }
            findViewById<View>(R.id.codeBox).visibility = View.VISIBLE
            findViewById<TextView>(R.id.codeLabel).text = if (st.viaApp) "验证码（看手机 Telegram App 里「Telegram」官方账号发来的消息，不是短信）" else "验证码（短信 / 电话）"
            if (st.codeLength > 0) code.hint = "${st.codeLength} 位数字"
            setMsg("验证码已发送" + if (st.viaApp) "到你手机上的 Telegram App" else "", ok = true)
            code.requestFocus()
        }
    }

    private fun signIn() {
        val c = code.text.toString()
        run("正在登录…", { Tg.account().signIn(c) }) { st ->
            if (st.step == "password") {
                findViewById<View>(R.id.pwBox).visibility = View.VISIBLE
                findViewById<TextView>(R.id.pwLabel).text = "两步验证密码" + if (st.hint.isNotBlank()) "（提示：${st.hint}）" else ""
                setMsg("这个账号开了两步验证，请输入两步验证密码")
                password.requestFocus()
            } else onLoggedIn(st)
        }
    }

    private fun submitPassword() {
        val pw = password.text.toString()
        run("正在验证密码…", { Tg.account().password(pw) }) { onLoggedIn(it) }
    }

    private fun onLoggedIn(st: TgAccount.Step) {
        code.setText(""); password.setText("")
        findViewById<View>(R.id.codeBox).visibility = View.GONE
        findViewById<View>(R.id.pwBox).visibility = View.GONE
        render()
        setMsg("✓ 已登录" + (if (st.name.isNotBlank()) "：${st.name}" else "") + "。手机 Telegram 的「设置 → 设备」里会多一个「拾影 Android」。" +
            if (!st.saved) "\n（本机加密存储不可用，登录只保持到拾影被关闭）" else "", ok = true)
    }

    private fun confirmLogout() {
        AlertDialog.Builder(this).setTitle("退出 Telegram 登录？")
            .setMessage("会通知 Telegram 结束这个会话，并删掉手机上保存的登录状态。api_id / api_hash 和代理设置会保留，下次登录不用重填。")
            .setPositiveButton("退出登录") { _, _ ->
                run("正在退出…", { Tg.account().logout() }) { remote ->
                    render()
                    setMsg(if (remote) "已退出 Telegram 登录（已通知 Telegram 结束会话）" else "已删除手机上的登录状态（没连上 Telegram，可以在手机 Telegram 的「设置 → 设备」里手动结束「拾影 Android」）", ok = remote)
                }
            }.setNegativeButton("取消", null).show()
    }

    private fun copyDiag() {
        val text = "拾影 ${Updater.currentName} Telegram 诊断日志\n" + Tg.account().diagText()
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("拾影 Telegram 诊断日志", text))
        Toast.makeText(this, "已复制（会话、api_hash、手机号、验证码和密码已隐藏）", Toast.LENGTH_LONG).show()
    }

    companion object {
        private const val SAVED = "\u0000saved"

        val GUIDE = """
拾影用你自己的 Telegram 账号登录（和手机上的 Telegram 一样是一个“设备”），只能下载这个账号本来就能看到的消息。拾影不内置任何别人的 api_id，需要你自己申请一次（免费，2 分钟）。

1. 用浏览器打开 https://my.telegram.org（国内需要先开代理 / VPN）。
2. 输入你的 Telegram 手机号（带国家区号，例如 +8613800138000），点 Next。
3. 验证码会发到你手机上的 Telegram App 里（「Telegram」官方账号发来的消息，不是短信），填到网页上，点 Sign In。
4. 点 API development tools。
5. 第一次会让你创建应用：App title 填 shiying，Short name 填 shiyingpc（5–32 位英文字母或数字），Platform 选 Desktop，其他留空，点 Create application。
   如果提示「ERROR」：换个代理节点、关掉浏览器的广告拦截插件，或过一会儿再试。
6. 页面上会显示 App api_id（一串数字）和 App api_hash（32 位字母数字）。这两个只属于你的账号，不要发给别人。复制到下面。
   在电脑版拾影里已经申请过的话，直接用同一组 api_id / api_hash（每个账号只能建一个应用）。
""".trim()

        val HELP = """
下载：在 Telegram 里长按消息 →「复制消息链接」，回到拾影粘贴，点「解析」后下载（也可以在 Telegram 里分享给拾影）。
• 支持：t.me/频道名/123、t.me/c/1234567890/123（私密频道 / 群）、t.me/群名/话题号/123（论坛话题）、?single（相册里只下这一张）、?comment=…（频道帖子下的评论）、?thread=…、telegram.me / telegram.dog、tg://resolve?… / tg://privatepost?…
• 相册会把同一组的图片 / 视频全部下载；视频有多个清晰度时下最大的那个。视频存到 相册 / Movies/拾影，图片存到 Pictures/拾影。
• 私聊和普通小群的消息 Telegram 本身不提供链接。可以把消息转发到你自己建的私密频道，再复制那里的消息链接。
• 常见提示：「该频道/聊天禁止保存内容，拾影不下载这类内容」；「没有权限看这条消息」（账号不在这个频道 / 群里）；「这条消息不存在或已被删除」；「请求太频繁，Telegram 要求等待 N 秒」——等提示的时间后再试。
• 贴纸、语音、普通文件、付费内容不下载。

退出 / 隐私：「退出登录」会通知 Telegram 结束这个会话，并删掉手机上的登录状态（api_id / api_hash 和代理设置保留）。登录状态和 api_hash 用 Android 系统密钥库（Keystore）加密，只保存在拾影自己的私有目录里，不备份、不上传，也不保存手机号。「复制诊断日志」会隐藏会话、api_hash、手机号、验证码和密码。

使用须知：仅供个人学习与备份自己有权保存的内容。请遵守各平台的服务条款和当地法律，不要用于搬运、二次发布或侵犯他人版权。
""".trim()
    }
}
