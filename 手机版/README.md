# 拾影

<img src="docs/icon-512.png" width="96" align="right">

一个简单的安卓视频 / 图集下载器：粘贴或分享链接，自动识别平台，一键保存到相册。

## 支持平台
- **原生解析**：抖音（无水印）、快手、小红书（视频 + 图集）
- **yt-dlp 解析**：哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo 及 yt-dlp 支持的其他网站
- 不支持：视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容

## 功能
- 剪贴板自动识别、系统分享直接接收
- 画质选择（最高 / 1080p / 720p / 480p / 360p / 省流量）
- 下载记录、取消下载、通知栏进度
- 可选网页登录（cookie 交给 yt-dlp，用于需要登录的平台）
- 解析引擎（yt-dlp）应用内更新
- YouTube 使用 Deno 作为 JS 运行时（复用 YTDLnis 的 Deno 组件包）
- 应用内检查更新、诊断日志

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
GPL-3.0（因依赖 youtubedl-android / yt-dlp 打包的 ffmpeg 等 GPL 组件）。第三方组件见 NOTICE.md。
