# 第三方组件

| 组件 | 许可证 | 用途 |
|---|---|---|
| Electron（含 Chromium、Node.js） | MIT（Chromium 为 BSD 等，见安装目录 LICENSES.chromium.html） | 程序外壳与界面 |
| undici | MIT | 网络请求（支持系统代理） |
| yauzl | MIT | 解压 Deno 压缩包 |
| GramJS（npm 包 `telegram`） | MIT | Telegram 账号登录与下载（MTProto） |
| big-integer | Unlicense | Telegram 的 64 位 ID |
| GramJS 的依赖：@cryptography/aes（GPL-3.0-or-later）、websocket（Apache-2.0）、pako（MIT AND Zlib）、socks、mime、htmlparser2 / domhandler / domutils / entities（BSD-2-Clause）、ieee754（BSD-3-Clause）、tslib（0BSD）、graceful-fs（BlueOak-1.0.0）及其他 MIT / ISC 组件 | 见各自许可证 | 随安装包分发（app.asar） |
| yt-dlp（首次运行时从 GitHub 下载，macOS 用 universal 的 `yt-dlp_macos`；不随安装包分发） | Unlicense | 通用视频解析 |
| FFmpeg（首次运行时下载 ffmpeg-static b6.1.1：Windows 为 gyan.dev GPL 版，macOS Apple 芯片为 osxexperts.net 版，macOS Intel 为 evermeet.cx 版；不随安装包分发） | GPL-3.0 | 音视频合并 |
| Deno（首次运行时从 dl.deno.land 下载，不随安装包分发） | MIT | YouTube JS 挑战求解 |
| 拾影安卓版 2.3 的解析逻辑（抖音 / 快手 / 小红书、yt-dlp 参数与错误归类） | GPL-3.0 | 移植为 Node.js |
| YTDLnis（deniscerri） | GPL-3.0 | YouTube 默认参数参考（经安卓版） |
