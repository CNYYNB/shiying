# 拾影 电脑版（Windows / macOS）

<img src="build/icon.png" width="96" align="right">

安卓版「拾影」2.3 的电脑版（Windows 和 Mac）：粘贴分享链接，自动识别平台，一键下载视频 / 图集到电脑。全中文界面。

当前版本：**1.1.1**（新增：Mac 版，Apple 芯片和 Intel 都有；1.1.0 新增 Telegram 账号登录下载）

## 下载哪个文件

| 文件 | 说明 |
|---|---|
| `拾影-Setup-1.1.1.exe` | **Windows 推荐**。安装包：可选安装位置，创建桌面和开始菜单快捷方式，可在「设置 → 应用」里卸载 |
| `拾影-PC-1.1.1-win-x64.zip` | Windows 便携版：解压到任意文件夹，双击 `拾影.exe` 运行，不写注册表 |
| `拾影-1.1.1-mac-arm64.zip` | **Mac（Apple 芯片：M1 / M2 / M3 / M4…）** |
| `拾影-1.1.1-mac-x64.zip` | **Mac（Intel 芯片）** |

系统要求：Windows 10 / 11，64 位；macOS 12（Monterey）或更新。
不知道自己的 Mac 是哪种芯片：点屏幕左上角的苹果图标 →「关于本机」，「芯片」写着 Apple M… 就选 arm64，「处理器」写着 Intel 就选 x64。

## Mac 安装步骤

1. 下载对应芯片的 zip，双击解压，得到「拾影」（拾影.app）。
2. 把「拾影」拖到「应用程序」文件夹里（访达左边栏的「应用程序」）。
3. **第一次打开**：拾影没有 Apple 开发者签名（只有“临时签名”，也没有经过苹果公证），直接双击会提示「无法打开“拾影”，因为 Apple 无法检查其是否包含恶意软件」或「无法验证开发者」。按下面任意一种方法放行（只需要做一次）：
   - **方法一**（macOS 14 及更早）：在「应用程序」里**右键（或按住 Control 点按）「拾影」→「打开」**，弹窗里再点「打开」。
   - **方法二**（macOS 15 Sequoia 及更新必须用这个，旧系统也可以）：先双击一次「拾影」，看到提示后点「完成」/「好」；然后打开 **「系统设置」→「隐私与安全性」**，往下拉到「安全性」，会看到「已阻止使用“拾影”，因为来自身份不明的开发者」，点 **「仍要打开」**，输入开机密码，再点「打开」。
   - **方法三**（提示「“拾影”已损坏，无法打开，你应该将它移到废纸篓」时用）：打开「终端」（启动台 → 其他 → 终端），粘贴下面这行后回车：
     ```
     xattr -cr /Applications/拾影.app
     ```
     然后再双击「拾影」。（这条命令只是去掉“从网上下载”的标记，不会改动程序。）
4. 首次打开后，拾影会自动下载 Mac 版解析引擎（yt-dlp、ffmpeg、Deno，约 110 MB，只下载一次）到 `~/Library/Application Support/拾影/bin`。
5. 登录 Telegram 后，macOS 可能弹窗「拾影想要使用你的钥匙串中的机密信息“拾影 Safe Storage”」：输入开机密码并点 **「始终允许」**（拾影用它加密保存 Telegram 登录状态）。更新拾影到新版本后可能会再问一次。
6. 第一次下载完成时 macOS 可能询问是否允许拾影发送通知，按需选择。

Mac 上的不同之处：
- 关闭窗口（红色按钮或 ⌘W）只是隐藏窗口，正在进行的下载会继续；点 Dock 里的拾影图标重新显示。彻底退出用 **⌘Q** 或菜单「拾影 → 退出拾影」。
- 粘贴链接用 **⌘V**；屏幕顶部有中文菜单（拾影 / 编辑 / 显示 / 窗口 / 帮助）。
- 默认保存到「下载」文件夹里的「拾影」（`~/Downloads/拾影`）。「在文件夹中显示」会在访达里选中文件。
- 数据文件夹：`~/Library/Application Support/拾影`（在访达里按 ⇧⌘G 粘贴这个路径可以打开）。卸载：把「应用程序」里的拾影拖到废纸篓；需要时再删掉这个数据文件夹。
- 系统代理：拾影读取「系统设置 → 网络 → 详细信息 → 代理」里的设置（ClashX / Clash Verge / Surge 等开启「设置为系统代理」即可）。

## 用法

1. **安装**：Windows 双击 `拾影-Setup-1.1.1.exe`。安装包没有数字签名，Windows 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
2. **首次打开**：拾影会自动下载解析引擎（yt-dlp、ffmpeg、Deno，约 100 MB，只下载一次），窗口上方能看到进度。
   抖音、快手、小红书用拾影自带的解析，不等引擎下载完也能用。
3. **下载作品**：在手机或网页上点「分享 → 复制链接」，切回拾影——拾影会自动识别剪贴板里的链接并解析
   （也可以粘贴到输入框后点「解析」，或按回车）。看到预览后点「下载」。
4. **画质**：底部「画质」是默认画质（最高 / 1080p / 720p / 480p / 360p / 省流量）；预览卡片上的「本次画质」只对这一次下载生效，会显示每档的大约大小。
5. **保存位置**：默认是「下载\拾影」（Mac：`~/Downloads/拾影`），底部「更改」可以换。视频存为 `作者-标题-ID.mp4`；图集存到同名文件夹里（`01.jpg`、`02.jpg`…，实况图另存 `01-实况.mp4`）。
6. **下载记录**：右侧列表，可以打开文件、在文件夹中显示、复制链接、重新解析；下载中可以取消（取消会删掉没下完的文件）。
7. **登录（可选）**：遇到「需要登录」「年龄限制」或想要 B 站 1080p 时，点右上角「登录」，在弹出的窗口里登录对应平台，或导入浏览器导出的 `cookies.txt`。登录状态只保存在这台电脑上。
8. **菜单**：
   - 更新解析引擎：平台改版导致解析失败时用（会检查 yt-dlp、ffmpeg、Deno）。拾影也会每 3 天自动检查一次。
   - 复制诊断日志：解析失败时复制最近一次解析引擎的完整日志（已隐藏 cookies 和令牌），方便反馈。
   - 打开数据文件夹：Windows `%APPDATA%\拾影`，Mac `~/Library/Application Support/拾影`（解析引擎、下载记录、登录信息都在这里）。

### 支持平台

| 平台 | 方式 | 说明 |
|---|---|---|
| 抖音（无水印）、快手、小红书 | 原生解析 | 视频 + 图集（小红书实况图另存视频） |
| **Telegram** | **账号登录（MTProto）** | 登录自己的账号后：公开频道、私密频道（`t.me/c/…`）、群组 / 超级群、论坛话题、频道评论里的视频、图片、相册。没登录时公开频道交给 yt-dlp。禁止保存内容的频道 / 聊天不下载 |
| 哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo | yt-dlp | 及 yt-dlp 支持的其他网站 |
| 不支持 | — | 视频号、直播、私密 / 仅好友 / 已删除内容、会员专享 / 付费内容 |

### Telegram 使用说明

拾影用**你自己的** Telegram 账号登录（和手机上的 Telegram 一样是一个“设备”），只能下载**这个账号本来就能看到**的消息。拾影不内置任何别人的 api_id，需要你自己申请一次（免费，2 分钟）。

**第一步：申请 api_id 和 api_hash（只需要做一次）**
1. 用浏览器打开 <https://my.telegram.org>（国内需要先开代理 / VPN）。
2. 输入你的 Telegram 手机号（带国家区号，例如 `+8613800138000`），点 **Next**。
3. 验证码会发到你手机上的 **Telegram App** 里（「Telegram」官方账号发来的消息，不是短信），填到网页上，点 **Sign In**。
4. 点 **API development tools**。
5. 第一次会让你创建应用：**App title** 填 `shiying`，**Short name** 填 `shiyingpc`（5–32 位英文字母或数字），**Platform** 选 **Desktop**，其他留空，点 **Create application**。
   如果提示「ERROR」：换个代理节点、关掉浏览器的广告拦截插件，或过一会儿再试。
6. 页面上会显示 **App api_id**（一串数字）和 **App api_hash**（32 位字母数字）。这两个只属于你的账号，不要发给别人。

**第二步：在拾影里登录**
1. 点右上角「登录」→ 最上面一行 Telegram 的「**Telegram 账号登录**」。
2. 填 api_id、api_hash、手机号（国内号码可以不写 +86）。
3. 代理（国内需要）：如果 Clash / v2rayN 开了「系统代理」，可以留空，拾影会自动用系统代理的端口按 SOCKS5 连接（Clash 的 7890、Clash Verge 的 7897 是“混合端口”，可以直接用）。连不上就手动填 SOCKS5，例如 `socks5://127.0.0.1:7890`（v2rayN 一般是 `socks5://127.0.0.1:10808`），或者粘贴 MTProxy 链接（`tg://proxy?server=…&port=…&secret=…`）。可以先点「测试连接」。
   注意：Telegram 不支持 HTTP 代理；FakeTLS（secret 以 `ee` 开头）的 MTProxy 也不支持。
4. 点「发送验证码」，在手机 Telegram App 里看验证码，填进去点「登录」。
5. 如果账号开了两步验证，再输入两步验证密码。
6. 看到「✓ 已登录」就可以了。手机 Telegram 的「设置 → 设备」里会多一个「拾影 PC」。

**第三步：下载**
- 在 Telegram 里右键消息（手机上长按）→「**复制消息链接**」，粘贴到拾影，解析后点「下载」。
- 支持的链接：`t.me/频道名/123`、`t.me/c/1234567890/123`（私密频道 / 群）、`t.me/群名/话题号/123`（论坛话题）、`?single`（相册里只下这一张）、`?comment=…`（频道帖子下的评论）、`?thread=…`、`telegram.me` / `telegram.dog`、`tg://resolve?…` / `tg://privatepost?…`。
- 相册会把同一组的所有图片 / 视频下到一个文件夹里（`01.jpg`、`02.mp4`…）；单个视频直接存成 `频道名-文字-频道_消息号.mp4`。视频有多个清晰度时下最大的那个。
- 私聊和普通小群的消息 Telegram 本身不提供链接，没法直接粘贴。可以把消息转发到你自己建的私密频道，再复制那里的消息链接（禁止保存内容的聊天转发不了，拾影也不会下载）。
- 常见提示：「该频道/聊天禁止保存内容，拾影不下载这类内容」；「没有权限看这条消息」（账号不在这个频道 / 群里）；「这条消息不存在或已被删除」；「请求太频繁，Telegram 要求等待 N 秒」——等提示的时间后再试。

**退出 / 隐私**
- 「登录 → Telegram 设置 → 退出 Telegram 登录」：会通知 Telegram 结束这个会话，并删掉电脑上的登录状态（api_id / api_hash 和代理设置保留，下次登录不用重填）。
- 登录状态（会话）、api_id / api_hash、代理设置加密保存在本机，不保存手机号：Windows 用系统加密（DPAPI，只有当前 Windows 用户能解开），保存在 `%APPDATA%\拾影\telegram`；Mac 用钥匙串里的密钥加密，保存在 `~/Library/Application Support/拾影/telegram`。「复制诊断日志」里会隐藏会话、api_hash、手机号、验证码和密码。

### 网络与代理
拾影使用系统代理设置（Windows 的代理设置 / Mac 的「网络 → 代理」；Clash 等的「系统代理」模式、PAC 都可以）。Telegram 另有自己的代理设置（SOCKS5 / MTProxy，见上）。在国内访问 YouTube / TikTok / Instagram / X 需要开启 VPN；小红书在海外 IP 下会被拒绝。

## 构建

需要 Node.js 22。Linux / macOS 上 `npm install` 如果卡在 `utf-8-validate` / `bufferutil` 编译（GramJS → websocket 的可选原生模块），用 `npm install --ignore-scripts`（它们有预编译文件和纯 JS 兜底，拾影也不用 websocket）。在 Windows、Linux（x64 或 arm64）、macOS 上都能构建 Windows 安装包，**不需要 wine**；Mac 版在 Linux 或 macOS 上构建（不能在 Windows 上构建）。

```
npm install
npm test                      # 单元测试（node:test，93 个）
npm start                     # 开发运行（当前系统上）
npm run dist                  # → dist/拾影-Setup-1.1.1.exe 和 dist/拾影-PC-1.1.1-win-x64.zip
npm run dist:setup            # 只出安装包
npm run dist:zip              # 只出便携版
npm run dist:mac              # → dist/拾影-1.1.1-mac-arm64.zip 和 dist/拾影-1.1.1-mac-x64.zip（ad-hoc 签名）
npm run dist:mac-arm64        # 只出 Apple 芯片版（dist:mac-x64 只出 Intel 版）
npm run verify:mac            # 检查 Mac 包：Info.plist、app.asar、架构、签名、符号链接 → out/mac-smoke-report.txt
```

Mac 版：`build/build-mac.js` 先用 electron-builder 生成 `拾影.app`，再做 ad-hoc 签名（Linux 上用 [rcodesign](https://github.com/indygreg/apple-platform-rs)（apple-codesign 0.29.0，找不到会自动下载到 `.cache/rcodesign/`），macOS 上用 `codesign -s -`），最后 `zip -y` 打包（保留符号链接）。没有 Apple Developer ID，所以没有公证。不出 .dmg（Linux 上没有可靠的 dmg 工具）。

在 Linux / macOS 上构建安装包需要系统的 makensis：`sudo apt install nsis`（Debian / Ubuntu）或 `brew install makensis`。
`build/build-win.js` 会让 electron-builder 使用系统 makensis，并直接从生成器里读出卸载程序（不用 wine 运行它）。
国内下载 Electron 慢时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`。

联网冒烟测试（真实网站 + 真实 yt-dlp，可选下载）：`SHIYING_SMOKE_DL=1 npm run smoke`，结果写到 `out/smoke-report.txt`。

图标：`build/icon.ico`、`build/icon.png`、Mac 的 `build/icon.icns` 都由安卓版的 `docs/icon-512.png`（即 `build/icon-512.png`）生成（`npm run icon`，需要 ImageMagick；icns 由 `build/make-icns.js` 写出）。

## 已知限制

- **没有代码签名**：Windows 首次运行会有 SmartScreen 提示，部分杀毒软件可能对 yt-dlp.exe 误报；Mac 版只有 ad-hoc 签名、没有公证，第一次打开要按上面「Mac 安装步骤」放行。
- **Mac 版没有在真 Mac 上测试过**（构建环境里没有 Mac），第一次使用如有问题请用「复制诊断日志」反馈。Mac 上 yt-dlp 每次启动要先自解压，第一次解析可能慢几秒。
- **YouTube**：数据中心 / 被标记的 VPN 节点会遇到「验证不是机器人」或 403，拾影会自动更新引擎、换备用客户端重试，仍失败时请换节点或登录 / 导入 cookies.txt。
  安卓版的最后一步「WebView 生成 PO Token」电脑版没有做。
- **Google 登录**：Google 可能拒绝在内嵌窗口里登录，这时请用浏览器扩展「Get cookies.txt LOCALLY」导出 cookies.txt 再导入。
- **哔哩哔哩**：不登录通常只有 480p / 720p；大会员内容不支持。
- **小红书**：海外 IP 会被重定向到 404；Instagram 匿名访问容易被限流；Vimeo 常要登录。
- Instagram / X / Facebook 的纯图片帖不下载；直播、合集、用户主页不支持；快手图集没有在线实测。
- 首次运行需要联网下载约 100 MB 的解析引擎（GitHub 有国内加速镜像兜底，但不保证一直可用）。
- **Telegram**：私聊和普通小群没有消息链接（见上面的转发办法）；不支持 HTTP 代理和 FakeTLS（ee）MTProxy；贴纸、语音、普通文件、付费内容不下载；一次只下一个任务，大文件速度受 Telegram 服务器限制。
- 卸载时不会删除 `%APPDATA%\拾影` / `~/Library/Application Support/拾影`（解析引擎和下载记录），需要时手动删除。
- 没有应用内自动更新（拾影本身的新版本需要重新下载安装包）。

## 使用须知
仅供个人学习与备份自己有权保存的内容。请遵守各平台的服务条款和当地法律，不要用于搬运、二次发布或侵犯他人版权。

## 许可证
GPL-3.0（见 `LICENSE`）。第三方组件见 `NOTICE.md`。
