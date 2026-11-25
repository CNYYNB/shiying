# 拾影 (com.louis.shiying) 2.3 — video / 图集 downloader for mainstream Chinese + international platforms (personal use)

Native Kotlin, Views (no Compose / no Material lib), OkHttp 4.12, androidx.webkit, **youtubedl-android 0.18.1** (yt-dlp + Python 3.12 +
QuickJS, GPL-3.0) with its **ffmpeg** module. minSdk 24, targetSdk 34. versionCode 5 / versionName 2.3.

APKs (ABI splits, v2-signed with `keystore/myplayer-debug.jks`, alias myplayer — same key as 1.0 and 我的播放器,
cert SHA-256 48bca8fe…0901586. KEEP IT: updates must use the same key):
- `out/shiying-2.3-arm64-v8a.apk` (~55 MB) — modern phones, the one to install
- `out/shiying-2.3-armeabi-v7a.apk` (~48 MB) — old 32-bit phones (no Deno build exists → QuickJS only)
- `out/shiying-2.2-*.apk`, `out/shiying-2.1-*.apk`, `out/shiying-2.0-*.apk` = previous releases, `out/shiying-icon-512.png` = rendered launcher icon.
- No universal APK: Python + ffmpeg for 4 ABIs would be ~200 MB.
- `out/shiying-1.0.apk` = previous release.

## Build
    # JDK 17+, Android SDK 34 (platform + build-tools), Gradle 8.9
    echo "sdk.dir=/path/to/android-sdk" > local.properties
    gradle :app:assembleRelease          # → app/build/outputs/apk/release/app-{arm64-v8a,armeabi-v7a}-release.apk
    gradle :app:testReleaseUnitTest      # unit tests (LiveExtractTest needs network, skipped by default)
Release signing: put keystore.properties in the project root (not in the repo); otherwise the debug key is used.
`jniLibs.useLegacyPackaging = true` is required (the library executes libpython.so / libffmpeg.so from nativeLibraryDir → extractNativeLibs=true).

## Platforms and engines
| Platform | Engine | Notes |
|---|---|---|
| 抖音 | native (1.0 code, unchanged) | share page `_ROUTER_DATA`, `playwm→play` no watermark, WebView fallback |
| 快手 | native `Kuaishou.kt` | v.kuaishou.com → `v.m.chenzhongtech.com/fw/photo/{3x…}` (iPhone UA) → `window.INIT_STATE` (obfuscated keys, plain values). `photo.mainMvUrls` = clean mp4; manifest mp4 reps preferred if present (HLS skipped). 图集 = `ext_params.atlas{cdn,list}`. `{"result":N,"error_msg":…}` → error text shown as-is (e.g. 作品在审核中). |
| 小红书 | native `Xhs.kt`, fallback yt-dlp | xhslink → `/explore|discovery/item/{id}?xsec_token=…` (token required) → `__INITIAL_STATE__` (PC `note.noteDetailMap[id].note`, mobile `noteData.data.noteData`). Video: `sns-video-bd.xhscdn.com/{originVideoKey}` then h264/h265 masterUrls. Images: token from urlDefault → `sns-img-bd.xhscdn.com/{token}` / `ci.xiaohongshu.com/{token}` (no watermark). Live photos from `imageList[].stream`. Redirect to `/404/sec_…` or rednote.com → clear error (overseas IP / need login / expired). |
| 哔哩哔哩, 微博, 西瓜/头条, YouTube (+Shorts), TikTok, Instagram, X, Facebook, Vimeo, any other site | yt-dlp | `Engine.kt` (process, cookies, update) + `YtdlpSupport.kt` (pure: options, JSON→Post, errors) |
| 视频号 | — | no public share links → not supported (said in 使用说明) |

Routing: `Extractor.route(text)` → `Links.detect` (first known-platform URL in the text, scheme-less `xhslink.cn/o/…`/`b23.tv/…` too; bare
19-digit id = Douyin). yt-dlp links: b23.tv / bili2233 / t.cn / v.ixigua / vt.tiktok are expanded first (`Resolve.follow`, http→https);
`ixigua.com/{id}` → `toutiao.com/video/{id}/` (Ixigua extractor needs cookies, Toutiao works); Shorts → watch URL.

yt-dlp options (same in app and live test): `--no-playlist --playlist-items 1:30 -f "bv*+ba/b" -S res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a`
(⋮ → 下载画质 → 最高画质 = `-S res,…`), TikTok `-f "bv*[format_note!*=atermark]+ba/b[…]"` (never the watermarked format).
Parse = `--dump-single-json`, saved to cacheDir/info; download = `--load-info-json` (no second extraction) `--merge-output-format mp4
--concurrent-fragments 4` into cacheDir/dl/<job>, then each file is copied into MediaStore. Playlists (Instagram carousels, multi-video
tweets) download every video entry; image-only entries are skipped. The library adds `--js-runtimes quickjs:…` and `--ffmpeg-location`.
System HTTP proxy → `--proxy`; VPNs are transparent.

Engine update: bundled yt-dlp is **2026.11.23** (`app/src/main/res/raw/ytdlp`, the official zipapp, overrides the library's 2025.11.12
copy; check the release with `unzip -p … yt_dlp/version.py`). The library only copies res/raw/ytdlp when no yt-dlp is installed, so
`Engine.applyBundledEngine` deletes `noBackupFilesDir/youtubedl-android/yt-dlp` once per new bundle if the installed version (SharedPreferences
"youtubedl-android" → dlpVersion) is older. To bump: replace res/raw/ytdlp + `Engine.BUNDLED_YTDLP`. `Engine.initAsync` (App.onCreate) unpacks Python/ffmpeg once, then silently runs
`updateYoutubeDL(STABLE)` at most every 3 days; ⋮ → 更新解析引擎 does it on demand (downloads from GitHub → needs VPN in mainland China).

## YouTube (2.3) — Deno JS runtime the way YTDLnis does it (`Deno.kt`)
YTDLnis (v1.9.1.1 + main, `core/packages/Deno.kt`, `PackageBase.kt`, `RuntimeManager.kt`) does NOT drop a deno binary into its data dir
(W^X). Settings → Packages → Deno downloads a separate companion APK **com.deniscerri.ytdl.deno** ("YTDLnis Deno Package", signer
CN=Denis Cerri, cert SHA-256 263645cb…64c95, extractNativeLibs=true) from GitHub releases of `deniscerri/ytdlnis-packages`
(tag `deno-2.7.7`, assets `app-arm64-v8a-release.apk` 91,165,390 B / `app-x86_64-release.apk`; no armeabi-v7a) and hands it to the system
installer. It then executes `<companion nativeLibraryDir>/libdeno.so` (Termux deno 2.7.7, linker64, NEEDED libsqlite3/libz.so.1/libandroid),
unzips `libdeno.zip.so` (usr/lib) and appends it to LD_LIBRARY_PATH after Python's, and passes `--js-runtimes deno:<libdeno.so>` + quickjs.
拾影 2.3 does the same: `<queries>` for the package; reuses it if YTDLnis already installed it; otherwise first YouTube link (once a day)
or ⋮ → 安装 Deno 引擎 downloads the APK (GitHub API → newest deno-* asset for the ABI, fallback fixed 2.7.7 URL + sha256; resumable,
cancellable, Chinese errors), checks package name + signer, opens ACTION_INSTALL_PACKAGE (FileProvider cache-path deno/). Before every
YouTube run `Deno.prepare` checks the installed signer, extracts usr/lib *.so (+symlinks) to noBackupFilesDir/deno-runtime once per version,
appends it to youtubedl-android's private `YoutubeDL.ENV_LD_LIBRARY_PATH` (reflection) and adds `--js-runtimes deno:…` (yt-dlp prefers deno
1000 > quickjs 850 and falls back on error). Python's own sqlite 3.50.4 / zlib 1.3.1 export every symbol deno imports (checked), so the order is safe.
yt-dlp updates now use the NIGHTLY channel (YTDLnis default); on a YouTube failure the engine is updated before the retry unless an update was
tried in the last 6 h. Diag log has a "JS 引擎：Deno …" line. Sandbox: official deno 2.7.7 linux-aarch64 + bundled yt-dlp 2026.11.23 solves n + sig
for the current tv player (b485e332) in 1.1 s; the full extraction is still 429/403 from the AWS IP. Not verified on a device.

## YouTube (2.2) — YTDLnis parity, real login detection, diagnostics
Root causes fixed (Louis: YTDLnis works on the same phone/VPN, 拾影 2.1 got "not a bot" on every step while NOT logged in, yet said
「已带上 YouTube 登录状态」):
- `Cookies.export(YOUTUBE)` exported *any* WebView youtube.com cookies (VISITOR_INFO1_LIVE / YSC / PREF from the login page or the PO-token
  WebView) + .google.com cookies, so yt-dlp ran with an anonymous, possibly flagged visitor id on every attempt, and `withCookies =
  cookies != null` made the summary claim a login. It also suppressed `visitor_data` in the PO-token step → token binding mismatch.
  Now: YouTube cookies are exported only when `CookieText.youtubeAuth` (LOGIN_INFO + SAPISID/__Secure-1P/3PAPISID, yt-dlp's own
  `_has_auth_cookies` rule), only the youtube.com domain; login state shown = what yt-dlp logged (`Found YouTube account cookies` /
  `…no longer valid`). Imported cookies.txt must contain the login cookies; yt-dlp gets a persistent work copy
  (`filesDir/cookies-work-youtube.txt`) so rotated cookies it writes back survive (re-seeded from the import if the login is gone).
- First attempt = YTDLnis defaults (read from deniscerri/ytdlnis main, Nov 25 2026, `YTDLPUtil.applyDefaultOptionsForFetchingData` /
  `setYoutubeExtractorArgs`, izzy flavour = youtubedl-android 0.18.1): no `--extractor-args` (yt-dlp defaults tv_samsung+visionos, or
  tv_samsung/web_embedded/web when logged in), QuickJS 2025-04-26 from the library (`--js-runtimes quickjs:` added by the library; the
  official zipapp bundles yt_dlp_ejs 0.8.0), no cookies unless enabled, `--no-check-certificates`, **no `--proxy`**. YTDLnis defaults to the
  nightly channel, but nightly 2026.11.24 has no YouTube changes vs stable 2026.11.23. 2.1 always added `--proxy` from the Android system
  proxy; 2.2 uses it only when the direct attempt fails to connect, and the download reuses whatever the successful parse used
  (`Post.ytdlpArgs`, googlevideo URLs are IP-bound). Then: engine update (also when JS solving failed) → alt clients → PO token
  (`visitor_data` when logged out, `data_sync_id` when logged in).
- Every YouTube attempt runs with `-v`; classification (`ytBlocked`/`ytReason`/`jsProblem`/`netProblem`) reads only ERROR/WARNING lines
  so [debug] text can't be mistaken for a bot check; JS challenge failures ("n challenge solving failed", "Signature solving failed", no JS
  runtime) are reported as such. `Diag` writes `filesDir/diag/youtube-last.txt`; ⋮ → 复制诊断日志 copies it through `YtdlpSupport.redact`.
- Not done: NewPipeExtractor backend, cobalt 「在线解析」 (cobalt.tools has YouTube disabled — api.cobalt.tools services list, Nov 25 2026;
  only Turnstile-protected community instances serve YouTube).

## YouTube (2.1)
`Engine.youtubeInfo`, each step only when YouTube *blocked* the previous one (`YtdlpSupport.ytBlocked`: bot check, 403/429, "Failed to extract
any player response"…; private / deleted / age errors are shown at once). Cookies (login or imported) are passed in every step.
1. bundled/newest yt-dlp; if the engine release is > 3 days old (and no update attempt in 6 h) → `updateYoutubeDL` once → retry.
2. `--extractor-args youtube:player_client=tv,tv_downgraded,ios_producer,visionos,web_embedded,android_vr` (clients that need no PO token in 2026.11).
3. PO token: `PoToken.mint` runs `assets/potoken.js` in a hidden WebView (`loadDataWithBaseURL("https://www.youtube.com/")`, desktop Chrome UA
   because the desktop homepage carries the BotGuard challenge): homepage ytcfg + `window.ytAtN` challenge (fallback /youtubei/v1/att/get) →
   BotGuard VM → snapshot → GenerateIT (jnn-pa.googleapis.com) → minter → tokens for video id, visitor data, datasync id → `cacheDir/potokens.json`.
   yt-dlp gets `--plugin-dirs filesDir/ytdlp-plugins` (copied from `assets/ytdlp-plugins/shiying/yt_dlp_plugins/extractor/shiying_pot.py`, a
   PO-token provider that just looks the binding up in that file) + `youtubepot-shiying:file=…` + `youtube:player_client=web_safari,mweb,web;visitor_data=…`
   (visitor_data only without cookies). JS written after bgutils-js (MIT); bgutil-ytdlp-pot-provider (GPL-3.0) / NewPipe only read for reference.
4. Login: ⋮/登录 → YouTube → 网页登录 (accounts.google.com → m.youtube.com, UA = WebView UA without "; wv"/"Version/4.0", X-Requested-With
   suppressed) or 导入 cookies.txt (file picker → `filesDir/cookies-import-youtube.txt`, preferred over WebView cookies, copied per run because
   yt-dlp rewrites its cookie file). Google's "browser may not be secure" page is detected (`GoogleLogin.isRejection`) → dialog → cookie import.
5. All failed → `YtdlpSupport.youtubeSummary`: every step + its reason + "换 VPN 节点 / 登录 or 导入 cookies.txt".
Sandbox test: `tools/yt-fallback-test.sh <urls>` (needs a local no-auth proxy for headless Chromium, POT_PROXY=http://127.0.0.1:8899;
`tools/pot-cdp-test.mjs` runs potoken.js in Chromium on a youtube.com page).

## Quality (2.1) — `Quality.kt`
最高画质 / 1080p (default) / 720p / 480p / 360p / 最低画质 = best at or below that height, else nearest above. yt-dlp: `-S res:N,…` (`+res,+size` for
最低). Native: `Post.heights` (url → short-side height: 抖音 bit_rate + ratio=1080p/720p/540p play urls, 快手 manifest reps / mainMvUrls,
小红书 stream heights; origin upload = best stream height) and `Quality.order` puts the picked rendition first, the others stay as fallbacks.
Preview card 「本次画质 ▾」 (only when ≥ 2 heights): per-download override (`Post.qualityOverride`), sizes from the yt-dlp info JSON.

## Thumbnails (2.1)
`Thumbs.save` stores a 360 px JPEG of the cover in `filesDir/thumbs/<key>.jpg` when a download is queued (CDN Referer per host: sinaimg →
weibo.com, hdslb → bilibili.com, douyinpic → douyin.com …). History rows: local thumb → MediaStore thumbnail → remote cover with Referer.

## Icon (2.1)
`icon-src/make_icon.py` generates the adaptive icon (drawable/ic_bg gradient #FF7A1A→#F0143C, ic_fg white play/arrow/speed lines, ic_mono),
mipmap-anydpi-v26/ic_launcher(+_round) and legacy PNGs for mdpi…xxxhdpi (rendered with headless Chromium) from the user's pick icon-src/icon-r2c3.png.

Login (optional, ⋮ → 登录平台账号 / top-right 登录): WebView login for 抖音, 小红书, B站, 微博, Instagram, X, Facebook, Vimeo. Cookies live in
the WebView CookieManager (shared with OkHttp) and are exported per platform to a Netscape cookies.txt for yt-dlp (`Cookies.export`).
Per-platform logout expires that platform's cookies; 退出全部登录 clears all. YouTube: see above (WebView login may be refused by Google → cookies.txt import).

Errors (`YtdlpSupport.errorMessage`): 私密 / 年龄限制 / 付费·会员 不支持 / IP 被封 / 地区限制 / 限流·风控 (429, 412) / 机器人验证 / 需要登录 /
不支持的链接 / 已删除 / 无视频(纯图片) / 直播 / 网络 / TLS 指纹 / 改版→更新解析引擎.

## Downloads, cancel, history
- `DownloadService` (foreground, dataSync): one job at a time, notification progress with a **取消** action. The preview button turns into
  **取消下载** while a job runs. Cancel = `Downloader.cancelNow()` (flag + `Call.cancel()`) + `YoutubeDL.destroyProcessById` (kills yt-dlp
  and its ffmpeg children). `JobCleanup.rollback` deletes the temp dir and every MediaStore entry the job wrote (half-written ones are
  discarded on the spot), status `cancelled` → UI back to the download button. Queued jobs are just dropped.
- Saving unchanged: Movies/拾影 and Pictures/拾影, name `作者-标题-ID`. History entries now carry `platform` + `link` (1.0 entries still work).

## Updater (Updater.kt + UpdateSources.kt)
`BuildConfig.UPDATE_URLS` = manifest mirrors tried in order with short timeouts (5 s connect / 7 s read), through the system proxy:
1. `https://shiying-louis.pages.dev/version.json` (not published yet)
2. `https://fastly.jsdelivr.net/gh/louis-shiying/shiying-update@main/version.json` — **placeholder**: create that GitHub repo (or change the
   URL with `-PupdateUrls=a,b`) to activate it. jsDelivr caps files at 20 MB, so this mirror can only serve version.json, with absolute APK URLs.
`version.json`: `versionCode, versionName, apk, sha256, notes` (+ `abis{abi:{apk,sha256}}`, `apkMirrors[]`). `apk` may be relative to the
manifest URL or absolute. 1.0 clients only read `apk`/`sha256` relative to pages.dev → arm64 build.
Errors: 无网络 (ConnectivityManager), 更新服务器未上线（404）, 网络被拦截 (SSL reset / timeout / DNS on every mirror), 格式错误, 服务器出错.
**Cloudflare Pages rejects files > 25 MiB**, so for Pages put the APKs on R2 / GitHub Releases and run
`APK_BASE=https://…/ tools/make-update-site.sh` so version.json points at absolute APK URLs.

## Tests
- `gradle :app:testReleaseUnitTest`: LinksTest, ParserTest (Douyin fixtures), PlatformTest (detection of real share texts per platform,
  normalisation), KuaishouXhsTest (real 快手 share pages saved Nov 2026: video + 审核中; synthetic atlas; 小红书 synthetic fixtures in the
  documented shape — xiaohongshu.com bounces the sandbox to rednote 404), YtdlpSupportTest (real yt-dlp JSON for TikTok/微博/X, playlist
  shape, options, real error lines → Chinese), CancelAndUpdateTest (Transfer stops on cancel, JobCleanup rollback, mirror/APK URL/error summary).
- V21Test: quality picking/ordering, Douyin heights, yt-dlp heights+sizes, YouTube ids/blocked/summary/PO-token args, Google rejection
  detection, Chrome UA, thumbnail Referers.
- `tools/run-live-test.sh` (`SHIYING_LIVE_DL=1` to also download+merge and ffprobe each yt-dlp video): real router + native parsers against
  the live sites, and the sandbox's python3 + yt-dlp with the app's exact options. Inputs: `tools/live-inputs.txt` (Douyin full list in
  `tools/live-inputs-douyin.txt`).

## Known limits
- Sandbox = US datacenter (AWS): YouTube refuses every player request from this IP (403 / bot check) with every client and with a valid
  on-device-style PO token (Nov 25 2026, 3 links) → only the plumbing (token minting in Chromium, plugin picked up, tokens attached) is verified.
  B站 (HTTP 412), 小红书 (rednote 404), Vimeo (TLS/IP block), Instagram (anonymous rate
  limit) could not be verified live here. On a phone in China: B站/小红书 should work; overseas platforms need a VPN, and datacenter VPN
  nodes may hit the same YouTube/Instagram/Vimeo blocks (log in, or switch node).
- No device/emulator here: the yt-dlp process wrapper, ffmpeg merge on Android, WebView logins and cancel on a device are untested.
- Instagram / X / Facebook photo-only posts are not downloaded (yt-dlp only extracts videos); Kuaishou atlas parsing is untested live.
- B站 without login: usually ≤ 480p/720p; 1080p needs login; 大会员/付费 not supported. YouTube may need 更新解析引擎 (bundled engine is 2025.11).
- 视频号, live streams, 合集 / user pages: not supported.
