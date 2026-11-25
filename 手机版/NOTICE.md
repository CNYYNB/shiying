# 第三方组件

| 组件 | 许可证 | 用途 |
|---|---|---|
| youtubedl-android 0.18.1（yausername） | GPL-3.0 | 在安卓上运行 yt-dlp + Python + ffmpeg |
| yt-dlp | Unlicense | 通用视频解析（内置 2026.11.23，可应用内更新） |
| FFmpeg（随 youtubedl-android） | GPL | 音视频合并 |
| QuickJS | MIT | 备用 JS 运行时 |
| Deno（YTDLnis Deno Package，运行时由用户另行安装） | MIT | YouTube JS 挑战求解，未打包进本应用 |
| OkHttp 4.12 | Apache-2.0 | 网络请求 |
| AndroidX / androidx.webkit | Apache-2.0 | 界面与 WebView |
| BgUtils 算法参考（LuanRT） | MIT | `assets/potoken.js` 依其算法独立编写 |
| YTDLnis（deniscerri） | GPL-3.0 | Deno 组件包的调用方式参考 |
| Telegram MTProto（拾影自带的 Kotlin 实现，`mtproto/`） | GPL-3.0（随本项目） | Telegram 账号登录下载（2.4） |
| Telegram API TL 架构（`assets/telegram/api.tl`、`schema.tl`，layer 198，取自 GramJS 2.26） | Telegram 公开架构 / GramJS MIT | 运行时解析 TL；GramJS 只用于生成测试数据（`tools/tg-fixtures.js`），未打包 |
