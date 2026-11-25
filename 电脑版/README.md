# 拾影 电脑版（Windows）

<img src="build/icon.png" width="96" align="right">

安卓版「拾影」2.3 的 Windows 版：粘贴分享链接，自动识别平台，一键下载视频 / 图集到电脑。全中文界面。

当前版本：**1.0.0**

## 下载哪个文件

| 文件 | 说明 |
|---|---|
| `拾影-Setup-1.0.0.exe` | **推荐**。安装包：可选安装位置，创建桌面和开始菜单快捷方式，可在「设置 → 应用」里卸载 |
| `拾影-PC-1.0.0-win-x64.zip` | 便携版：解压到任意文件夹，双击 `拾影.exe` 运行，不写注册表 |

系统要求：Windows 10 / 11，64 位。

## 用法

1. **安装**：双击 `拾影-Setup-1.0.0.exe`。安装包没有数字签名，Windows 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
2. **首次打开**：拾影会自动下载解析引擎（yt-dlp、ffmpeg、Deno，约 100 MB，只下载一次），窗口上方能看到进度。
   抖音、快手、小红书用拾影自带的解析，不等引擎下载完也能用。
3. **下载作品**：在手机或网页上点「分享 → 复制链接」，切回拾影——拾影会自动识别剪贴板里的链接并解析
   （也可以粘贴到输入框后点「解析」，或按回车）。看到预览后点「下载」。
4. **画质**：底部「画质」是默认画质（最高 / 1080p / 720p / 480p / 360p / 省流量）；预览卡片上的「本次画质」只对这一次下载生效，会显示每档的大约大小。
5. **保存位置**：默认是「下载\拾影」，底部「更改」可以换。视频存为 `作者-标题-ID.mp4`；图集存到同名文件夹里（`01.jpg`、`02.jpg`…，实况图另存 `01-实况.mp4`）。
6. **下载记录**：右侧列表，可以打开文件、在文件夹中显示、复制链接、重新解析；下载中可以取消（取消会删掉没下完的文件）。
7. **登录（可选）**：遇到「需要登录」「年龄限制」或想要 B 站 1080p 时，点右上角「登录」，在弹出的窗口里登录对应平台，或导入浏览器导出的 `cookies.txt`。登录状态只保存在这台电脑上。
8. **菜单**：
   - 更新解析引擎：平台改版导致解析失败时用（会检查 yt-dlp、ffmpeg、Deno）。拾影也会每 3 天自动检查一次。
   - 复制诊断日志：解析失败时复制最近一次解析引擎的完整日志（已隐藏 cookies 和令牌），方便反馈。
   - 打开数据文件夹：`%APPDATA%\拾影`（解析引擎、下载记录、登录信息都在这里）。

### 支持平台
- **原生解析**：抖音（无水印）、快手、小红书（视频 + 图集）
- **yt-dlp 解析**：哔哩哔哩、微博、西瓜视频 / 今日头条、YouTube（含 Shorts）、TikTok、Instagram、X / Twitter、Facebook、Vimeo 及 yt-dlp 支持的其他网站
- 不支持：视频号、直播、私密 / 仅好友 / 已删除内容、会员专享内容

### 网络与代理
拾影使用 Windows 的系统代理设置（Clash 等的「系统代理」模式、PAC 都可以）。在国内访问 YouTube / TikTok / Instagram / X 需要开启 VPN；小红书在海外 IP 下会被拒绝。

## 构建

需要 Node.js 22。在 Windows、Linux（x64 或 arm64）、macOS 上都能构建 Windows 安装包，**不需要 wine**。

```
npm install
npm test                      # 单元测试（node:test，59 个）
npm start                     # 开发运行（当前系统上）
npm run dist                  # → dist/拾影-Setup-1.0.0.exe 和 dist/拾影-PC-1.0.0-win-x64.zip
npm run dist:setup            # 只出安装包
npm run dist:zip              # 只出便携版
```

在 Linux / macOS 上构建安装包需要系统的 makensis：`sudo apt install nsis`（Debian / Ubuntu）或 `brew install makensis`。
`build/build-win.js` 会让 electron-builder 使用系统 makensis，并直接从生成器里读出卸载程序（不用 wine 运行它）。
国内下载 Electron 慢时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`。

联网冒烟测试（真实网站 + 真实 yt-dlp，可选下载）：`SHIYING_SMOKE_DL=1 npm run smoke`，结果写到 `out/smoke-report.txt`。

图标：`build/icon.ico` 由安卓版的 `docs/icon-512.png` 生成（`npm run icon`，需要 ImageMagick）。

## 已知限制

- **没有代码签名**：首次运行会有 SmartScreen 提示；部分杀毒软件可能对 yt-dlp.exe 误报。
- **YouTube**：数据中心 / 被标记的 VPN 节点会遇到「验证不是机器人」或 403，拾影会自动更新引擎、换备用客户端重试，仍失败时请换节点或登录 / 导入 cookies.txt。
  安卓版的最后一步「WebView 生成 PO Token」电脑版没有做。
- **Google 登录**：Google 可能拒绝在内嵌窗口里登录，这时请用浏览器扩展「Get cookies.txt LOCALLY」导出 cookies.txt 再导入。
- **哔哩哔哩**：不登录通常只有 480p / 720p；大会员内容不支持。
- **小红书**：海外 IP 会被重定向到 404；Instagram 匿名访问容易被限流；Vimeo 常要登录。
- Instagram / X / Facebook 的纯图片帖不下载；直播、合集、用户主页不支持；快手图集没有在线实测。
- 首次运行需要联网下载约 100 MB 的解析引擎（GitHub 有国内加速镜像兜底，但不保证一直可用）。
- 卸载时不会删除 `%APPDATA%\拾影`（解析引擎和下载记录），需要时手动删除。
- 没有应用内自动更新（拾影本身的新版本需要重新下载安装包）。

## 使用须知
仅供个人学习与备份自己有权保存的内容。请遵守各平台的服务条款和当地法律，不要用于搬运、二次发布或侵犯他人版权。

## 许可证
GPL-3.0（见 `LICENSE`）。第三方组件见 `NOTICE.md`。
