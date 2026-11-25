# 拾影

<img src="docs/icon-512.png" width="96" align="right">

一个简单的安卓视频 / 图集下载器：粘贴或分享链接，自动识别平台，一键保存到相册。

## 支持平台
- **原生解析**：抖音、快手、小红书（视频 + 图集）
- **Telegram 账号登录（MTProto，2.4）**：登录自己的账号后，可下载公开频道、私密频道（`t.me/c/…`）、群组、论坛话题、频道评论里的视频、图片、GIF 和相册；没登录时公开频道的视频交给 yt-dlp。禁止保存内容的频道 / 聊天不下载
- **yt-dlp 解析**：哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo 及 yt-dlp 支持的其他网站
- 不支持：视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容

## 功能
- 剪贴板自动识别、系统分享直接接收
- 画质选择（最高 / 1080p / 720p / 480p / 360p / 省流量）
- 下载记录、取消下载、通知栏进度
- 可选网页登录（cookie 交给 yt-dlp，用于需要登录的平台）
- Telegram 账号登录（自己的 api_id / api_hash、验证码、两步验证；SOCKS5 / MTProxy 代理）
- 解析引擎（yt-dlp）应用内更新
- YouTube 使用 Deno 作为 JS 运行时（复用 YTDLnis 的 Deno 组件包）
- 应用内检查更新、诊断日志

## Telegram 使用说明（2.4）

拾影用**你自己的** Telegram 账号登录（和手机上的 Telegram 一样是一个“设备”），只能下载**这个账号本来就能看到**的消息。拾影不内置任何别人的 api_id，需要你自己申请一次（免费，2 分钟；电脑版拾影申请过的可以直接用同一组）。

**第一步：申请 api_id 和 api_hash（只需要做一次）**
1. 用浏览器打开 <https://my.telegram.org>（国内需要先开代理 / VPN）。
2. 输入你的 Telegram 手机号（带国家区号，例如 `+8613800138000`），点 **Next**。
3. 验证码会发到你手机上的 **Telegram App** 里（「Telegram」官方账号发来的消息，不是短信），填到网页上，点 **Sign In**。
4. 点 **API development tools**。
5. 第一次会让你创建应用：**App title** 填 `shiying`，**Short name** 填 `shiyingpc`（5–32 位英文字母或数字），**Platform** 选 **Desktop**，其他留空，点 **Create application**。
   如果提示「ERROR」：换个代理节点、关掉浏览器的广告拦截插件，或过一会儿再试。
6. 页面上会显示 **App api_id**（一串数字）和 **App api_hash**（32 位字母数字）。这两个只属于你的账号，不要发给别人。

**第二步：在拾影里登录**
1. 点右上角「登录」→ 最上面一行「**Telegram 账号登录**」。
2. 填 api_id、api_hash、手机号（国内号码可以不写 +86）。
3. 代理（国内需要）：开着 VPN（Clash / v2rayNG 的 VPN 模式）时一般留空即可；连不上就手动填 SOCKS5，例如 `socks5://127.0.0.1:7890`（v2rayNG 一般是 `socks5://127.0.0.1:10808`），或者粘贴 MTProxy 链接（`tg://proxy?server=…&port=…&secret=…`）。可以先点「测试连接」。
   注意：Telegram 不支持 HTTP 代理；FakeTLS（secret 以 `ee` 开头）的 MTProxy 也不支持。
4. 点「发送验证码」，在手机 Telegram App 里看验证码，填进去点「登录」。
5. 如果账号开了两步验证，再输入两步验证密码。
6. 看到「✓ 已登录」就可以了。手机 Telegram 的「设置 → 设备」里会多一个「拾影 Android」。

**第三步：下载**
- 在 Telegram 里长按消息 →「**复制消息链接**」，粘贴到拾影，解析后点「下载」（也可以在 Telegram 里把消息分享给拾影）。
- 支持的链接：`t.me/频道名/123`、`t.me/c/1234567890/123`（私密频道 / 群）、`t.me/群名/话题号/123`（论坛话题）、`?single`（相册里只下这一张）、`?comment=…`（频道帖子下的评论）、`?thread=…`、`telegram.me` / `telegram.dog`、`tg://resolve?…` / `tg://privatepost?…`。
- 相册会把同一组的所有图片 / 视频都下载（`作者-文字-频道_消息号-1.jpg`、`-2.mp4`…）；视频有多个清晰度时下最大的那个。视频存到 相册 / Movies/拾影，图片存到 Pictures/拾影。
- 私聊和普通小群的消息 Telegram 本身不提供链接，没法直接粘贴。可以把消息转发到你自己建的私密频道，再复制那里的消息链接（禁止保存内容的聊天转发不了，拾影也不会下载）。
- 常见提示：「该频道/聊天禁止保存内容，拾影不下载这类内容」；「没有权限看这条消息」（账号不在这个频道 / 群里）；「这条消息不存在或已被删除」；「请求太频繁，Telegram 要求等待 N 秒」——等提示的时间后再试。

**退出 / 隐私**
- 「登录 → Telegram 账号登录 → 退出登录」：会通知 Telegram 结束这个会话，并删掉手机上的登录状态（api_id / api_hash 和代理设置保留，下次登录不用重填）。
- 登录状态（会话）、api_id / api_hash、代理设置用 Android 系统密钥库（Keystore，AES-256-GCM）加密，保存在拾影的私有目录里（不备份），不保存手机号。「复制 Telegram 诊断日志」会隐藏会话、api_hash、手机号、验证码和密码。

## 下载
见 Releases。新手机装 `arm64-v8a`，老 32 位手机装 `armeabi-v7a`。

## 构建
需要 JDK 17+、Android SDK 34、Gradle 8.9。

```
gradle :app:assembleRelease
```

签名：在项目根目录放 `keystore.properties`（storeFile / storePassword / keyAlias / keyPassword），否则用 debug 签名。

## 使用须知
仅供个人学习与备份自己有权保存的内容。请遵守各平台的服务条款和当地法律，不要用于搬运、二次发布或侵犯他人版权。

## 许可证
GPL-3.0（因依赖 youtubedl-android / yt-dlp 打包的 ffmpeg 等 GPL 组件）。Telegram 用拾影自带的 Kotlin MTProto 实现（没有原生库）。第三方组件见 NOTICE.md。
