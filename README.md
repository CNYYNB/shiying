<div align="center">

<img src="docs/icon-512.png" width="96" alt="拾影图标">

# 拾影

**粘贴链接就能下载视频 · Android + Windows**

抖音、快手、小红书、TikTok、X、B 站、YouTube、微博、Instagram……把分享链接贴进来，自动识别平台，一键保存。<br>
免费 · 开源 · 无广告 · 不用注册

[![Release](https://img.shields.io/github/v/release/CNYYNB/shiying?label=%E4%B8%8B%E8%BD%BD)](https://github.com/CNYYNB/shiying/releases/latest)
[![License](https://img.shields.io/github/license/CNYYNB/shiying)](LICENSE)
[![Stars](https://img.shields.io/github/stars/CNYYNB/shiying?style=social)](https://github.com/CNYYNB/shiying/stargazers)

**手机版**

<img src="docs/screenshots/preview.jpg" alt="拾影手机版：解析抖音、哔哩哔哩、小红书、YouTube、X 链接" width="100%">

**电脑版**

<img src="docs/screenshots/pc-preview.jpg" alt="拾影电脑版：解析抖音、小红书、YouTube、TikTok 链接" width="100%">

</div>

## 下载

到右边的 **Releases** 下载最新版：

- 手机：`Shiying-Android-2.3-arm64-v8a.apk`（绝大多数手机装这个，Android 7 及以上）
- 老的 32 位手机：`Shiying-Android-2.3-armeabi-v7a.apk`
- 电脑：`Shiying-Windows-Setup-1.0.0.exe`（Windows 10/11 64 位）

## 支持哪些平台

| 平台 | 解析方式 | 实测 | 备注 |
|---|---|---|---|
| 抖音 | 原生 | ✅ 能下 | 无水印 |
| 快手 | 原生 | ✅ 能下 | 视频 + 图集 |
| 小红书 | 原生 | ✅ 能下 | |
| TikTok | yt-dlp | ✅ 能下 | |
| X / Twitter | yt-dlp | ✅ 能下 | 纯图帖不下 |
| 哔哩哔哩 | yt-dlp | ✅ 能下 | |
| YouTube | yt-dlp + Deno | ✅ 能下 | 含 Shorts |
| 微博 | yt-dlp | ✅ 能下 | |
| 西瓜 / 头条 | yt-dlp | 未测 | |
| Instagram | yt-dlp | ✅ 能下 | 易限流 |
| Facebook | yt-dlp | 未测 | |
| Vimeo | yt-dlp | 未测 | 常需登录 |
| 其他网站 | yt-dlp | — | yt-dlp 支持的都行 |

「未测」是作者的测试环境（海外 IP）被平台拦截、没能实测，不代表不能用。欢迎在 Issues 里反馈你的结果。

**不支持**：视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容。

## 能做什么

- 复制链接后打开就自动识别，手机上也可以从 App 里直接「分享 → 拾影」
- 画质可选（最高 / 1080p / 720p / 480p / 360p / 省流量）
- 下载记录、取消下载、进度显示；手机版直接存进相册
- 需要登录的平台可以在 App 内网页登录（cookie 只保存在本机，交给 yt-dlp 使用）
- 解析引擎 yt-dlp 可在应用内更新
- 诊断日志一键复制（会去掉 cookie 和 token）

## 怎么用

1. 在抖音 / 快手 / B 站等 App 里点「分享 → 复制链接」。
2. 打开拾影，链接会自动填进去（也可以手动粘贴）。
3. 看一眼预览，选画质，点下载。

电脑版第一次运行会自动下载 yt-dlp、FFmpeg（以及 YouTube 需要的 Deno），国内会自动走镜像。更新 yt-dlp 和下载 YouTube 在国内一般需要开 VPN。

## 使用须知

仅供个人学习，以及备份你自己有权保存的内容。请遵守各平台的服务条款和当地法律，**不要用于搬运、二次发布、商用或侵犯他人版权**。下载内容的版权归原作者所有。

## 目录

```
手机版/   Android（Kotlin，youtubedl-android = yt-dlp + Python + FFmpeg）
电脑版/   Windows（Electron + Node.js，调用 yt-dlp / FFmpeg / Deno）
```

### 编译手机版
需要 JDK 17+、Android SDK 34、Gradle 8.9：

```
cd 手机版
gradle :app:assembleRelease
```

正式签名：在 `手机版/` 放 `keystore.properties`（storeFile / storePassword / keyAlias / keyPassword），没有就用 debug 签名。技术细节见 `手机版/DEV-NOTES.md`。

### 编译电脑版
需要 Node.js 20+：

```
cd 电脑版
npm install
npm start        # 运行
npm run dist     # 打包 Windows 安装程序
```

## 许可证

GPL-3.0。手机版打包了 youtubedl-android（GPL-3.0）及其 FFmpeg；第三方组件见 `手机版/NOTICE.md` 和 `电脑版/NOTICE.md`。
