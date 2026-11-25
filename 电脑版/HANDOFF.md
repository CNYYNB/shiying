# 拾影电脑版交接说明（给接手的开发者 / AI）

版本 **1.2.0**（2026-11-25，新增内置更新；1.1.1 新增 macOS 版 arm64 / x64；1.1.0 新增 Telegram 账号登录下载；1.0.0 同日）。移植自安卓版 2.3（`com.louis.shiying`，源码不在本仓库）。
用户说明见 `README.md`。本文件讲结构、做法和没验证的地方。

## 1. 技术栈
- Electron 45（Chromium + Node 22），纯 JS，无前端框架，无打包器。界面 `src/renderer/`，`contextIsolation` + `sandbox`，只能通过 `preload.js` 暴露的 `window.shiying` 调主进程。
- 依赖：`undici`（网络请求，可走代理，`redirect: 'manual'` 手动跟随跳转并存 cookie）、`yauzl`（解压 Deno）、`telegram`（GramJS 2.26.22，MTProto 客户端）、`big-integer`（GramJS 的 64 位 ID）。
  GramJS → websocket 带可选原生模块 bufferutil / utf-8-validate：`electron-builder.yml` 里 `npmRebuild: false`（Linux 不能交叉编译；它们有 win32 预编译 + 纯 JS 兜底，拾影用 TCP 不走 websocket）；Linux arm64 上 `npm install` 编译失败时用 `--ignore-scripts`。
- 解析引擎不随安装包分发：首次运行下载到 `数据目录/bin`（Windows `%APPDATA%\拾影\bin` 里的 `yt-dlp.exe`、`ffmpeg.exe`、`deno.exe`；macOS `~/Library/Application Support/拾影/bin` 里的 `yt-dlp`、`ffmpeg`、`deno`）。安装包约 114 MB，便携 zip 约 144 MB（基本都是 Electron 本身）。
- 构建：electron-builder 26。Windows：`nsis`（安装包）和 `zip`（便携版），x64，无签名。macOS：`dir` → rcodesign ad-hoc 签名 → `zip -y`，arm64 和 x64 各一个，不公证（见 §4）。

## 2. 代码地图
| 文件 | 作用 | 对应安卓 |
|---|---|---|
| `src/core/platform.js` | 平台表（域名、引擎、登录地址、会话 cookie 名） | Platform.kt |
| `src/core/links.js` | 从分享文字找链接、抖音 ID、文件名（多了 Windows 保留名处理） | Links.kt |
| `src/core/post.js` | 作品对象 `makePost` + `UserError` / `PostUnavailable` / `NeedFallback` / `Cancelled` | Parser.kt 的 Post |
| `src/core/quality.js` | 画质档位、挑选、`-S` 参数、yt-dlp 各档大小 | Quality.kt |
| `src/core/net.js` | undici 请求、cookie jar、按网址解析代理、短链接展开 `follow` | Net.kt + Resolve |
| `src/core/douyin.js` | 抖音：分享页 `_ROUTER_DATA`、无水印地址、网页 API JSON | Parser.kt + Extractor.resolve/fromSharePage |
| `src/core/kuaishou.js` / `xhs.js` | 快手 / 小红书原生解析 | Kuaishou.kt / Xhs.kt |
| `src/core/extractor.js` | 路由：原生 or yt-dlp | Extractor.route |
| `src/core/ytdlp-support.js` | yt-dlp 参数、info JSON → 作品、错误 → 中文、YouTube 判断、日志脱敏、cookies.txt 工具 | YtdlpSupport.kt + CookieText |
| `src/core/sysplat.js` | （1.1.1）按系统区分的纯函数：`binFile`（.exe）、`dataDirLabel` / `dataSubLabel`、`defaultSaveDir`、`killPlan`（taskkill / 进程组 SIGKILL）、`spawnDetached`、`osLabel`、`pasteKey`、`chromeUA`、`menuTemplate`（macOS 中文菜单；Windows / Linux 返回 null） | — |
| `src/core/engine.js` | 运行 yt-dlp（spawn、进度、取消杀进程树）、YouTube 兜底流程、诊断日志 | Engine.kt + Diag.kt |
| `src/core/tools.js` | 下载 / 更新 yt-dlp、ffmpeg、Deno（多镜像、sha256、进度、取消） | Engine.update + Deno.kt |
| `src/core/telegram-support.js` | Telegram 纯函数：`parseLink`（t.me / telegram.me / telegram.dog / tg://，c/、话题、?single / ?comment / ?thread）、`parseProxy`（SOCKS5 / MTProxy）、`classifyError`（RPC 错误 → 中文）、`mediaItems`（视频挑 altDocuments 里最大的）、相册、`redact` | — |
| `src/core/telegram.js` | `TelegramService`：链接 → 消息 → 作品（相册按 grouped_id 取前后 9 条）、禁止保存检查、下载（`.part`、进度、取消立即返回并删文件）。客户端注入，按 className 判断类型 | — |
| `src/core/telegram-account.js` | `TelegramAccount`：api_id/api_hash → sendCode → auth.SignIn → 两步验证（`signInWithPassword`）；会话 / 配置加密保存（加密函数注入）；连接时按顺序试代理；退出（auth.LogOut + 删本地会话）；脱敏诊断日志 | — |
| `src/core/updater.js` | （1.2.0）内置更新的纯逻辑：`cmpSemver`、`parseManifest`（https / sha256 / size 校验）、`pickAsset`（系统 / 架构）、`manifestUrls`、`fetchManifest`（多地址回退、6 秒超时）、`checkForUpdate`、`downloadAsset`（url → mirrors、`.part`、大小 + sha256、取消清理、30 秒卡住超时）、`classify`（错误 → 中文）、Windows `winIsInstalled` / `winInstallCommand`、Mac `macBundleFromExec` / `macCanReplace` / `macFindAndCheckApp` / `macSwapScript` / `macFallbackMessage` | 安卓 Updater.kt 的思路 |
| `src/core/downloader.js` | 原生下载（候选地址轮换、MP4 头校验、`.part`、取消回滚）、保存路径与文件名 | Downloader.kt + Saver.kt + JobCleanup |
| `src/core/store.js` | settings.json / history.json | History.kt + Kv |
| `src/core/thumbs.js` | 封面 CDN 的 Referer | Thumbs.refererFor |
| `src/main/main.js` | 窗口、IPC、解析、下载队列（一次一个）、首次运行装引擎、系统代理、封面 / 缩略图 | MainActivity + DownloadService |
| `src/main/updater-main.js` | （1.2.0）`AppUpdater`：自动 / 手动检查、下载进度事件、取消、Windows 运行安装包并退出、Mac 解压 → 替换脚本 → 退出（或放到「下载」并在访达中显示）、`update-done.json` 标记（新版启动提示「已更新到 x」）。平台 / execPath / pid / spawn 可注入（测试在 Linux 上模拟两边的安装） | — |
| `src/main/cookies.js` | 网页登录窗口（独立持久 session）、导出 Netscape cookies.txt、导入、退出 | BrowserActivity login + Engine.Cookies |
| `src/main/webcapture.js` | 抖音“网页模式”兜底（隐藏窗口读 `_ROUTER_DATA`，再不行打开网页版用 CDP 截 aweme/detail） | WebCapture.kt |
| `src/main/preload.js` | 界面 API | — |
| `src/renderer/*` | 界面（红白高对比，全中文） | activity_main.xml 等 |

`src/core/` 不依赖 Electron，单元测试和 `tools/smoke.js` 直接用 Node 跑。

## 3. 关键做法
- **YouTube**：第一次尝试同 YTDLnis（不加 extractor-args、`--no-check-certificates`、cookies 只在真登录时带、`-v`）→ 连不上且有系统代理时加 `--proxy` 重试 → 6 小时内没更新过就更新 yt-dlp（nightly）后重试 → 备用客户端 `YT_ALT_CLIENTS` → 汇总中文说明。Deno：`--js-runtimes deno:<bin\deno.exe>`（yt-dlp 按第一个冒号分割，`C:\` 盘符没问题，已查 yt-dlp `__init__.py`）。
  **没做**安卓版第 4 步 PO Token（WebView 跑 BotGuard + 自带 yt-dlp 插件）。要加的话：把 `assets/potoken.js` 放进一个隐藏 BrowserWindow（`loadURL('https://www.youtube.com/')`），再把 `assets/ytdlp-plugins` 复制到数据目录，参数见 `YtdlpSupport.ytPotArgs`（安卓源码）。
- **代理**：Windows 上 yt-dlp（Python urllib）自己会读系统代理注册表；Node 一侧（原生解析、引擎下载、封面）通过 `session.resolveProxy(url)` 取 Chromium 解析的系统代理（支持 PAC），`HTTPS_PROXY` 环境变量优先（可带用户名密码，`app.on('login')` 会替 Chromium 回答代理认证）。SOCKS 只传给 yt-dlp。
- **cookies**：登录窗口 partition `persist:shiying-login`，UA 为不带 Electron 字样的 Chrome UA。解析前 `cookies.export(platform)` 生成 `cookies\export-<平台>.txt`；导入的文件给 yt-dlp 一份工作副本（yt-dlp 会写回轮换后的 cookies）。原生平台解析前 `syncToJar` 把登录 cookies 放进 Node 的 cookie jar。
- **引擎来源**（`tools.js` 顶部注释）：yt-dlp nightly / stable × GitHub / ghfast.top / gh-proxy.com，校验 `SHA2-256SUMS`；ffmpeg 用 `eugeneware/ffmpeg-static` b6.1.1 的 `ffmpeg-win32-x64.gz`（gyan.dev GPL 版，约 30 MB；yt-dlp/FFmpeg-Builds 的 win64 包 200 MB 太大）+ npmmirror 镜像；Deno 用 dl.deno.land / npmmirror / GitHub，校验 `.sha256sum`。“更新解析引擎”= 对比线上 sha256，不同才下载（不用 `yt-dlp -U`，因为要走镜像）。
- **macOS 适配**（1.1.1）：
  - 组件：`assetNames(platform, arch)` → `yt-dlp_macos`（universal，ad-hoc 签名，最低 10.15 / arm64 11.0）、`ffmpeg-darwin-arm64.gz`（osxexperts.net 版，链接器 ad-hoc 签名，最低 12.0，只依赖系统库）/ `ffmpeg-darwin-x64.gz`（evermeet.cx 版，最低 10.13）、`deno-aarch64-apple-darwin.zip` / `deno-x86_64-apple-darwin.zip`（Deno 官方 Developer ID 签名，最低 12.0）。镜像和 Windows 一样。ffmpeg 的 gz sha256 写死在 `tools.js` 的 `FFMPEG_SHA256`（Windows / mac / Linux 五个文件，2026-11-25 从 GitHub 下载并与 npmmirror 比对一致；以前 Windows 的 ffmpeg 没有校验，现在也有了）。下载后 `makeRunnable`：chmod 755，macOS 上 `xattr -d com.apple.quarantine`（Node 下载的文件一般没有这个属性，失败忽略）。`Tools` 构造时可以传 `{ platform, arch }`（测试用）。
  - 结束进程树：POSIX 上 yt-dlp 以 `detached` 启动（自成进程组），取消时 `process.kill(-pid, 'SIGKILL')`，ffmpeg 一起结束（测试里实测了孙进程也被杀）。
  - 主进程：macOS 显示中文应用菜单（`SP.menuTemplate`：关于 / 服务 / 隐藏 / 退出 ⌘Q；编辑：撤销、重做、剪切、拷贝、粘贴 ⌘V、全选——没有编辑菜单的话 macOS 上输入框里 ⌘V 不起作用；显示；窗口；帮助）。Windows 仍然 `Menu.setApplicationMenu(null)`。关窗口只 `hide()`（下载继续），`activate`（点 Dock）重新显示，`before-quit` 置 `quitting` 后才真正关闭；`window-all-closed` 在 mac 上不退出。`setAboutPanelOptions` 中文关于面板。`setAppUserModelId` 只在 Windows。
  - 默认保存位置 `app.getPath('downloads')/拾影`（mac = `~/Downloads/拾影`）；数据目录 `app.getPath('userData')` = `~/Library/Application Support/拾影`（productName）。文件定位用 `shell.showItemInFolder`（各平台通用）。
  - 系统代理：仍用 `session.resolveProxy`（Chromium 在 mac 上读 SystemConfiguration，含 PAC）；yt-dlp（Python urllib）在 mac 上自己读系统代理（`_scproxy`）。没有另外调用 `scutil --proxy`。
  - safeStorage：mac 上是钥匙串里的「拾影 Safe Storage」密钥。ad-hoc 签名每次构建都不同，所以更新版本后钥匙串可能再问一次「始终允许」。Telegram `systemVersion` 按系统报 `macOS` / `Windows`。
  - 界面：`init` 返回 `os`（label、⌘V / Ctrl+V、数据目录写法），输入框提示、关于页、Telegram 说明里的路径随系统变化。登录窗口 UA 的系统部分随本机（`chromeUA`）。
- **下载**：一次一个任务，其余排队。yt-dlp 下到 `%APPDATA%\拾影\tmp\<任务>`，完成后改名移动到保存目录（跨盘则复制）。进度用 `--progress-template`（`[shiying-progress] …`）解析。取消 = AbortController + Windows `taskkill /T /F`（连 ffmpeg 一起杀），并删除已写文件。
- **Telegram**（1.1.0）：GramJS 用户登录（MTProto），**不内置任何 api_id**，用户自己在 my.telegram.org 申请。
  - 平台表 `TELEGRAM`（engine `telegram`，hosts t.me / telegram.me / telegram.dog，不进网页登录列表）。`Extractor.route(text, log, { telegram })`：已登录 → `TelegramService.resolve`；没登录且是公开频道普通帖子 → yt-dlp（`https://t.me/频道/消息号[?single]`，已实测 yt-dlp 能下）；c/ 链接、评论 → 提示登录。
  - 存储：`%APPDATA%\拾影\telegram\config.bin`（{apiId, apiHash, proxy, name, username}）和 `session.bin`（StringSession），都用 `safeStorage.encryptString`（Windows = DPAPI）。加密不可用时只在内存里保持登录。不存手机号。退出保留 api_id / api_hash / 代理。
  - 代理：用户填的（SOCKS5 / MTProxy）优先；否则 `session.resolveProxy('https://web.telegram.org/')`：SOCKS → 用它；`PROXY h:p` → 先按 SOCKS5 试同一端口（Clash / v2rayN 混合端口），超时 6 秒，再直连；`ALL_PROXY=socks5://…` 也认。GramJS 不支持 HTTP 代理和 FakeTLS MTProxy。
  - **GramJS 的坑**：`client.connect()` 重试用完后**不抛错**，只返回 false → 以 `client.connected` 为准；GramJS 的 Logger 会 `console.error` 整个错误对象 → 自定义 Logger `canSend()` 返回 false，warn/error 进脱敏日志；`floodSleepThreshold: 15`（15 秒以内的 FLOOD_WAIT 自动等，更长的提示用户秒数）；`deviceModel: '拾影 PC'`。
  - 私密频道：新会话的实体缓存里没有 access_hash，`getEntity(PeerChannel)` 失败时读一遍 `getDialogs({limit: 3000})` 再试。评论：`messages.GetDiscussionMessage` → 讨论组 → 取 comment id。
  - 禁止保存：`chat.noforwards || msg.noforwards`（解析和下载前都查，评论区的讨论组也查）→「该频道/聊天禁止保存内容，拾影不下载这类内容」。
  - 下载：`client.downloadMedia(msg 或 altDocument, { outputFile: 自己的 writer, progressCallback })`，writer 同步写 `.part`；取消时 race 立即返回、删文件。下载前重新取消息（file_reference 会过期）。封面在解析时用 `thumb: 'm'` 之类取成 data: URL（`fetchImage` / `coverData` 认 data:）。
  - 文件名：`频道名-文字-频道_消息号.ext`（私密频道 `c<id>_<msg>`）；相册 → 同名文件夹 `01.jpg`、`02.mp4`。
  - 界面：「登录」弹窗最上面一行 Telegram → 独立的 Telegram 弹窗（说明、api_id、api_hash、手机号、代理、测试连接 → 验证码 → 两步验证；已登录时：代理、测试连接、退出）。IPC：`tg-status / tg-send-code / tg-resend / tg-sign-in / tg-password / tg-cancel-login / tg-logout / tg-set-proxy / tg-test`。「复制诊断日志」末尾附 Telegram 日志（脱敏）。`SHIYING_DEBUG=1` 时 Telegram 日志也打到控制台（同样脱敏）。
- **内置更新**（1.2.0）：
  - 清单 `pc-version.json`，地址按顺序：Cloudflare Pages（`shiying-louis.pages.dev`）→ raw.githubusercontent（`CNYYNB/shiying/main/电脑版/update/`，中文路径 URL 编码）→ jsDelivr（fastly）。列表在 `package.json` 的 `shiyingUpdate.manifests`；构建时 `SHIYING_UPDATE_MANIFESTS=a,b` 通过 electron-builder `extraMetadata` 覆盖（`build/config.js`，用 `{ extends: 'electron-builder.yml', extraMetadata }`）；运行时同名环境变量也能覆盖（开发 / 测试用），`SHIYING_UPDATE_ALLOW_HTTP=1` 允许 http（只用于本地测试）。每个地址 6 秒超时，第一个读到且校验通过的为准。jsDelivr 对 `@main` 有缓存（最多约 12 小时），所以放最后。
  - 清单格式：`{ schema, version, date, notes, page, minVersion?, win: { x64: Asset }, mac: { arm64: Asset, x64: Asset } }`，`Asset = { name, url, mirrors[], sha256, size }`，地址必须 https。`minVersion`：当前版本低于它时「立即更新」变成「打开下载页」（给以后需要完整重装的版本用）。Mac 没有 arm64 文件时用 x64（Rosetta），Windows arm64 用 x64。
  - 网络走 `Net.getDispatcher`（系统代理 / PAC / HTTPS_PROXY，和解析一样）。错误归类成中文：超时 / 连不上 / 返回网页 → 建议开 VPN；404 → 可能还在上传；sha256 不对 →「校验失败」并删除；大小不对（content-length 或实际字节超出）→ 立刻停止并删除；磁盘满 / 没权限。
  - 自动检查：`init` 后 8 秒（`SHIYING_UPDATE_DELAY`），`settings.updateAuto !== false` 且距 `updateCheckAt` 超过 6 小时；检查前就写 `updateCheckAt`（没网时不会每次启动都试）。只在有新版本时推送 `update: available`，界面在没有别的弹窗时弹出。手动检查（菜单「检查更新」、关于页按钮、mac 应用菜单「检查更新…」）显示「已是最新」或中文错误 + 重试 / 打开主页。
  - 下载到系统临时文件夹 `shiying-update/`（Windows `%TEMP%\shiying-update`）。已下载且校验正确的文件直接复用。下载中弹窗不能用 Esc / 点外面关闭，只能「取消」。
  - **Windows**：exe 旁边有 `Uninstall 拾影.exe` = 安装版 → `Setup.exe /S --updated --force-run`（detached），0.8 秒后 `app.quit()`。electron-builder 的 NSIS 模板：`.onInit` 从注册表读原来的 InstallLocation 和“仅为我 / 所有用户”（`HKCU/HKLM Software\<APP_GUID>`，APP_GUID 由 appId 算出，所以 **appId 和 `perMachine: false` 不能改**）；所有用户安装且静默时会 UAC 提权；`--updated` 跳过页面、`_CHECK_APP_RUNNING` 等旧进程退出（不行就结束它）、静默运行旧卸载程序时保留数据（`deleteAppDataOnUninstall` 本来就是 false）；`--force-run` 装完用快捷方式重新打开。用户数据 `%APPDATA%\拾影`（productName 决定）完全不碰，Telegram 会话（DPAPI 加密，绑定 Windows 用户，不绑定程序路径）保留。spawn 失败（例如 740 需要提权）时改用 `shell.openPath` 打开安装包（会显示安装界面）。便携版 → 不加参数打开安装包（普通安装界面）。
  - **macOS**：zip 里顶层是 `拾影.app`。`ditto -x -k` 解压到临时文件夹 → `macFindAndCheckApp`（bundle id `com.louis.shiying.pc`、版本 = 清单版本、主程序存在）→ `xattr -cr` → `macCanReplace`（App Translocation 路径、只读磁盘、对 .app 所在文件夹或 .app 本身没有写权限 → 不能替换）。能替换：写 `swap.sh`（等拾影 pid 退出，最多 60 秒 → 旧版改名 `.old-update` → `mv` 新版进去（失败用 `ditto`）→ `xattr -cr` → 删旧版 → `open` 新版；任何一步失败放回旧版、打开旧版、`open -R` 新版），`/bin/sh` detached 运行，0.5 秒后退出。日志在临时文件夹的 `swap.log`。不能替换：新版 `ditto` 到 `~/Downloads/拾影新版本-<版本>/拾影.app`，`showItemInFolder`，弹窗给出中文拖动步骤和「退出拾影」按钮。没有用 Squirrel.Mac / electron-updater（要求 Developer ID 签名）。bundle id 不变，钥匙串里的「拾影 Safe Storage」和数据文件夹都保留；ad-hoc 签名每次构建不同，钥匙串可能再问一次「始终允许」。
  - Linux / 开发模式（`!app.isPackaged`）：只能检查，「立即更新」= 打开下载页（`SHIYING_UPDATE_DEV_INSTALL=1` 可在开发模式下走安装流程，只在 Windows / Mac 有意义）。
  - 新版第一次启动：读 `数据目录/update-done.json`（版本对得上）→ 提示「拾影已更新到 x」，删掉临时更新文件夹。
  - 「复制诊断日志」末尾附「拾影更新」日志（检查 / 下载 / 失败原因，不含任何令牌）。
  - 发布文件名改成英文（`Shiying-Windows-Setup-<v>.exe`、`Shiying-Windows-<v>-x64-portable.zip`、`Shiying-macOS-<v>-<arch>.zip`）：GitHub Releases 会把中文文件名改成 `default.exe` 之类。
  - 清单工具 `tools/make-pc-manifest.js`：读 dist/ 三个文件 → sha256 / size，主地址 `https://github.com/<repo>/releases/download/<tag>/<文件>`，`--mirror 前缀/`（可多个）→ mirrors，说明读 `tools/notes-pc-<版本>.txt`，写前用 `parseManifest` 校验。发布步骤见 README「发布新版本」。
- **网页模式**：页面会尝试打开 `snssdk1128://` 唤起抖音 App，`blockExternal` 只允许 http(s)，避免弹出“打开应用”。

## 4. 构建（任何系统都不需要 wine）
```
npm install && npm test && npm run dist && npm run dist:mac && npm run verify:win && npm run verify:mac
node tools/make-pc-manifest.js --version <版本> --tag pc-<版本>   # 发布前生成 update/pc-version.json
node tools/update-sim.js                                         # 用本地服务器 + dist 里的真实文件模拟一次更新 → out/update-sim-report.txt
```
- **macOS**（`build/build-mac.js`，Linux / macOS 上都能跑；electron-builder 只禁止在 Windows 上构建 mac）：
  1. electron-builder `mac.target: dir`（`electron-builder.yml` 的 `mac:`：`identity: null` 不让它签名、`hardenedRuntime: false`、`minimumSystemVersion: "12.0"`（Electron 45 要求 macOS 12）、`icon: build/icon.icns`、`extendInfo` 写 `CFBundleDisplayName 拾影` 等、`electronLanguages: [zh_CN, en]`）。bundle id `com.louis.shiying.pc`，Helper 是 `com.louis.shiying.pc.helper.*`。
  2. ad-hoc 签名：Linux 上 `rcodesign sign 拾影.app`（apple-codesign 0.29.0，不给证书 = ad-hoc，从里到外签 17 个 Mach-O、4 个 Helper、各 framework，写 `_CodeSignature/CodeResources`）；macOS 上 `codesign --force --deep -s -`。不加 hardened runtime（加了就要 allow-jit 等 entitlements）。rcodesign 查找顺序：`RCODESIGN` 环境变量 → PATH → `.cache/rcodesign/` → 自动从 GitHub 下载。
  3. `zip -q -r -y -X` → `dist/Shiying-macOS-<版本>-<arch>.zip`（`-y` 保留 Electron Framework 的 `Versions/Current` 等符号链接；不保留的话签名失效、体积翻倍）。
  - 没有出 .dmg：Linux 上没有可靠的 UDIF 生成工具（hdiutil 只在 mac 上有）。在 Mac 上要 dmg 可以 `hdiutil create -volname 拾影 -srcfolder dist/mac-arm64/拾影.app -ov -format UDZO 拾影.dmg`。
  - `tools/mac-verify.js`（`npm run verify:mac`）：解压 zip，检查 Info.plist（bundle id、版本、显示名、LSMinimumSystemVersion 12.0、icns）、ElectronAsarIntegrity 与 asar 头一致、app.asar 内容、各可执行文件的 CPU 架构、所有 Mach-O 都是 ad-hoc 且没有 runtime 标志、符号链接 → `out/mac-smoke-report.txt`。
  - 图标：`build/make-icns.js` 用 ImageMagick 把 `build/icon-512.png` 缩成 16–512 的 PNG 写进 icns（icp4/5/6、ic07/08/09、ic11–14；源图只有 512，没有 ic10）。
- `build/build-win.js`：非 Windows 时把 electron-builder 的 makensis 换成系统 makensis（`ELECTRON_BUILDER_NSIS_DIR` 指向 `.cache/nsis-sys/`，里面一个转发脚本 + 从 electron-builder 的 NSIS 包里复制的 `elevate.exe`），并把卸载程序的生成方式换成直接从生成器 exe 里读出（`build/nsis-uninstaller-reader.js`，同 electron-builder 在 macOS 上的做法，但支持新版 NSIS stub 的 `.idata` 等节）。
  `elevate.exe` 不在缓存时脚本会先让 electron-builder 下载它的 NSIS 包再复制（已在清空缓存后实测）。在 Windows 上脚本不做这些替换，直接用 electron-builder 自带的工具。
- 本次在 Debian 13 aarch64 沙箱用系统 NSIS 3.11 构建。安装包：中文界面（2052）、可选安装位置、可选“仅为我 / 所有用户”、桌面 + 开始菜单快捷方式、卸载程序、许可页 `build/license-zh.txt`（UTF-8 带 BOM）。
- exe 图标和版本信息由 electron-builder 写入（已用 `tools/peinfo.js` 检查：9 个尺寸的图标、ProductName 拾影）。
- `tools/win-verify.js`（`npm run verify:win`，1.2.0）：安装包 PE / 图标 / 版本信息，7z 列出并解出 `app-64.7z` → `拾影.exe`（x64、版本）和 app.asar（含更新器、package.json 版本、清单地址、菜单项），确认有 `Uninstall 拾影.exe`；便携版 zip 内容 → `out/win-smoke-report.txt`。
- 开发调试环境变量：`SHIYING_USER_DATA`（换数据目录）、`SHIYING_SCREENSHOT=out.png` + `SHIYING_SCREENSHOT_JS=脚本`（截图后退出）、`SHIYING_FORCE_WEBCAPTURE=1`（抖音直接走网页模式）、`SHIYING_DEBUG=1`、`SHIYING_DEVTOOLS=1`。
  Linux 下截图：`xvfb-run -a node_modules/electron/dist/electron --no-sandbox .`

## 5. 测试
- `npm test`：120 个（node:test）。1.2.0 新增 `updater.test.js` 27 个：semver（数字段、预发布、v 前缀、非法）、清单解析（BOM、notes 数组、拒绝 http / 坏 sha256 / 坏 size / 非 JSON / 没有文件）、按系统 / 架构挑文件（含 Rosetta / Windows arm64 回退）、清单地址（环境变量 / package.json / 默认 / 构建时 extraMetadata）、本地服务器上清单回退（500 → 不回应 → 拦截网页 → 正确，短超时）和全部失败的中文提示、检查结果（有新版本 / 最新 / 低于 minVersion / 没有文件）、下载（进度、复用、sha256 不对换下一个地址并删除、content-length 不对、比声明大、返回网页、取消删除 .part 且不试备用地址、卡住超时）、错误归类、Windows 安装参数和 electron-builder / NSIS 模板检查、Mac 路径判断、`.app` 检查、Mac 替换脚本在 Linux 上用假 open / xattr / ditto 真实运行（成功和回滚）、引号路径、清单工具、仓库里的 `update/pc-version.json`（与 dist 文件 sha256 一致）、端到端 `AppUpdater`（Windows 静默安装参数 + 退出 + 新版启动提示；取消 / 校验失败不安装；Mac 下载 → 解压 → 替换 → 重新打开；Mac 没权限 → 放到「下载」）、mac 菜单「检查更新…」。以下是原来的 93 个：1.1.1 新增 `platform-mac.test.js` 13 个：各系统 / 架构的组件文件名、yt-dlp / ffmpeg / Deno 来源和镜像、ffmpeg 固定 sha256、Tools 路径（有无 .exe）、chmod、gz 按原始字节校验、killPlan、真实结束进程组、默认保存位置 / 数据目录写法、macOS 菜单（中文、⌘Q、⌘V）、UA、electron-builder mac 配置和 icns。以下是原来的 80 个：1.1.0 新增 `telegram.test.js` 21 个：链接各形式、平台识别、代理解析、系统代理候选、错误归类、媒体挑选、相册、脱敏、用假客户端测 resolve（公开 / 相册 / single / 禁止保存 / 删除 / 无媒体 / 限流 / 无权限 / c/ 读对话列表 / 评论）、download（单个 / 相册文件夹 / 进度 / 取消回滚 / 下载前禁止保存）、route 回退、登录流程（验证码 → 两步验证 → 加密保存 → 重启读回 → 退出）、连不上 / 会话失效 / 不能加密。测试里不联网。
- Telegram 实测（沙箱，美国 AWS）：GramJS 直连 Telegram DC ✓、经本地 SOCKS5 ✓、错误代理 → 中文提示 ✓、用假 api_id `sendCode` → `API_ID_INVALID` → 中文提示 ✓（Node 和打包后的 app.asar 在 Linux Electron 里都跑过）；没登录时公开频道 `t.me/europa_press/613` 走 yt-dlp 解析 ✓。`links-platform` / `native-parsers` / `ytdlp-quality` 是安卓 LinksTest、PlatformTest、ParserTest、KuaishouXhsTest、YtdlpSupportTest、V21Test、V22Test 的移植（同样的 fixtures 和断言，fixtures 在 `test/fixtures/`）；`pc-runtime` 是电脑版新增（本地 HTTP 服务器测下载、取消回滚、sha256、进度解析、cookie jar、记录、Referer）。安卓的 DenoTest（YTDLnis 组件包）、CancelAndUpdateTest 的更新镜像部分、GoogleLogin 检测不适用，没移植。
- `tools/smoke.js`（2026-11-25，沙箱 = 美国 AWS 机房，Linux arm64）：抖音 ID / 分享文字 ✓（原生下载 11 MB，h264+aac）、快手 ✓、TikTok ✓（yt-dlp 下载）、X ✓（yt-dlp 下载 + ffmpeg 合并 ✓）；小红书 ✗（海外 IP → rednote）、B 站 ✗（412 风控）、YouTube ✗（机器人验证，兜底流程跑完）、Vimeo ✗（要登录）——都是 IP / 地区原因，和安卓版沙箱结果一致。见 `out/smoke-report.txt`。
- 完整界面在 Linux 的 Electron 里跑通：首次运行自动下载三个组件（约 20 秒）、剪贴板识别、解析、封面、下载、记录缩略图；抖音网页模式第一步实测拿到数据。截图 `out/screenshot.png`；Telegram 登录弹窗 `out/telegram-login.png`（Linux 沙箱没有系统钥匙串，所以截图里有「不能加密保存」提示，Windows 上不会出现）。

## 6b. 内置更新没有验证的（1.2.0）
- **没有在真 Windows / 真 Mac 上实际更新过**。验证到的：单元测试和端到端模拟（`AppUpdater` 注入平台，Linux 上用本地 HTTP 服务器、假的 open / xattr / ditto 真实运行替换脚本）、`tools/update-sim.js` 用 dist 里的真实安装包 / zip 下载校验（`out/update-sim-report.txt`）、`verify:mac` 用更新器的检查函数认出真实 zip 里的 `拾影.app`、`verify:win` 确认安装包有 `Uninstall 拾影.exe`、Linux Electron 里自动检查弹窗（`out/update-dialog.png`、`out/update-progress.png`、`out/update-menu.png`）。
- Windows：`/S --updated --force-run` 静默升级 1.2.0 → 下一版（安装位置保持、所有用户安装时 UAC、旧进程被结束、自动重新打开）是按 electron-builder 26.18 的 NSIS 模板读出来的，没有真机跑过；杀毒软件对 `%TEMP%` 里运行的未签名安装包的反应；`spawn` 失败回退 `shell.openPath`。
- Mac：`ditto -x -k` 解压我们的 zip（`zip -y`，符号链接）、`/Applications` 里原地替换正在运行的 app、`open` 重新打开时 Gatekeeper 是否再拦（新 bundle 已 `xattr -cr`，由已放行的 app 下载、不带隔离属性，按理不会）、钥匙串是否再问、App Translocation 路径判断。
- 真实网络：三个清单地址在国内的可达性（Pages / raw / jsDelivr）、GitHub Releases 下载速度（建议发布时加 R2 等镜像，`--mirror`）。
- 1.1.1 → 1.2.0 只能手动安装（旧版没有更新器）；Windows 上手动运行 1.2.0 安装包会按同一 appId 原地升级（与 1.0.0 → 1.1.x 相同方式）。

## 6a. 没有在真 Mac 上验证的（沙箱里没有 Mac，1.1.1）
- **整个 Mac 版都没有在真 Mac 上运行过**。已验证的只有静态检查（`out/mac-smoke-report.txt`：Info.plist、asar、架构、每个 Mach-O 都有 ad-hoc 签名、符号链接）和 Linux 上 Electron 能构建出 mac 菜单（`Menu.buildFromTemplate` 无报错，快捷键 ⌘Q / ⌘V 等正确）。
- rcodesign 生成的 ad-hoc 签名能否通过 `codesign --verify --deep --strict` 和 Apple 芯片的内核签名检查（rcodesign 被广泛用于这种场景，但没在真机确认）。
- Gatekeeper 提示的具体文字和放行路径（macOS 15 起「右键 → 打开」不再能绕过，要去「隐私与安全性 → 仍要打开」；README 写了三种办法）。
- 首次运行下载 Mac 组件：链接全部实测可达（GitHub / ghfast / gh-proxy / npmmirror / dl.deno.land，2026-11-25），sha256 已核对，二进制的架构 / 最低系统版本 / 签名已检查；但没有在 Mac 上执行过 `yt-dlp_macos --version` 等。
- 关窗口隐藏 / Dock 重新显示 / ⌘Q 退出、通知授权、钥匙串弹窗、系统代理读取（`resolveProxy`）、`showItemInFolder`、中文路径、取消时杀进程组、Intel 版在 Apple 芯片上用 Rosetta 运行。
- Telegram 在 mac 上（同 Windows，真实登录从没测过）。

## 6. 没有在真 Windows 上验证的（沙箱里没有 Windows）
- **Telegram 真实登录和下载完全没测过**（沙箱里没有 Telegram 账号）：验证码 / 两步验证 / 会话保存读回、私密频道 / 群 / 评论 / 话题 / 相册的真实解析和下载、大文件 file_reference 过期、FLOOD_WAIT、真实 MTProxy。逻辑都按 GramJS 2.26.22 源码写并用假客户端测了；第一次真机使用时请看「复制诊断日志」。
- Windows 上 `safeStorage`（DPAPI）加密会话；Electron 45 提示 `isEncryptionAvailable` 将来会弃用（目前可用）。
- 安装包的实际安装 / 卸载、快捷方式、安装模式页面；7-Zip 能正常列出安装包和卸载程序内容（7-Zip 的 NSIS 解析器对 NSIS 3.11 显示 `BadCmd=13`，是它不认识新指令编号，不影响），中文界面字符串已在头部数据里确认。
- Windows 上的 `yt-dlp.exe` / `ffmpeg.exe` / `deno.exe`（下载链接和 sha256 已核对；Linux 上同一流程实测通过）、`taskkill` 取消、中文路径、系统代理读取、通知。
- 网页登录窗口（各平台是否接受 Electron 登录；Google 很可能拒绝 → 用 cookies.txt 导入）。
- 抖音网页模式第二步（网页版 + CDP 截获）。
- 第一次运行时 SmartScreen / 杀毒软件对未签名 exe 和 yt-dlp.exe 的反应。

## 7. 可以做的
- Telegram：QR 码登录（`signInUserWithQrCode`）、私聊 / 普通群的消息选择器（没有链接）、文件（非视频 / 图片）下载、断点续传。
- PO Token 兜底（见上）、代码签名（Windows 签名后内置更新可以再校验签名）、增量更新（现在每次下载完整安装包）、拖放链接、批量下载、浏览器扩展“发送到拾影”。
- `electron-builder.yml` 里 `compression: maximum` 可以把 zip 再压小一些。
- Mac：Developer ID 签名 + 公证（需要 Apple 开发者账号，$99/年；之后可以去掉 Gatekeeper 放行步骤）、dmg（在 Mac 上用 hdiutil）、universal 包（`@electron/universal` 合并 arm64 + x64，体积约翻倍）。
