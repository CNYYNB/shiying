#!/bin/bash
# Changelog: tools/notes-<versionName>.txt (falls back to the 2.0 text).
# Builds out/update-site/ (version.json + APKs + index.html) from the release APKs. Does NOT deploy anything.
#   APK_BASE=https://pub-xxxx.r2.dev/shiying/  → version.json points at absolute APK URLs (needed on Cloudflare Pages:
#   Pages rejects files > 25 MiB, so the ~55 MB APKs must live on R2 / GitHub Releases; version.json + index.html stay on Pages).
set -e
cd "$(dirname "$0")/.."
VN=$(grep -oP 'versionName = "\K[^"]+' app/build.gradle.kts); VC=$(grep -oP 'versionCode = \K\d+' app/build.gradle.kts)
OUT=out/update-site; rm -rf "$OUT"; mkdir -p "$OUT"
for abi in arm64-v8a armeabi-v7a; do cp "out/shiying-$VN-$abi.apk" "$OUT/"; done
python3 - "$OUT" "$VN" "$VC" "${APK_BASE:-}" "tools/notes-$VN.txt" <<'P'
import hashlib, json, os, sys, html
out, vn, vc, base, notes_file = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
abis = {}
for abi in ("arm64-v8a", "armeabi-v7a"):
    name = f"shiying-{vn}-{abi}.apk"; p = os.path.join(out, name)
    abis[abi] = {"apk": (base.rstrip('/') + '/' + name) if base else name, "sha256": sha(p), "size": os.path.getsize(p)}
notes = open(notes_file, encoding="utf-8").read().strip() if os.path.exists(notes_file) else ("拾影 2.0：\n"
 "· 新增支持快手、小红书、哔哩哔哩、微博、西瓜视频/今日头条，以及 YouTube（含 Shorts）、TikTok、Instagram、X/Twitter、Facebook、Vimeo，粘贴链接自动识别平台\n"
 "· 抖音 / 快手 / 小红书 / TikTok 无水印；B站等平台自动合并音视频，默认最高 1080p（可改为最高画质）\n"
 "· 新增「取消下载」（通知栏也可取消），取消后自动清理未完成的文件\n"
 "· 新增「更新解析引擎」，平台改版后一键修复\n"
 "· 可选登录各平台账号（B站高清、Instagram、小红书等）\n"
 "· 检查更新支持多个镜像，错误提示更清楚\n"
 "提示：海外平台在国内需要开启 VPN；微信视频号没有公开链接，暂不支持。")
v = {"versionCode": vc, "versionName": vn,
     # 1.0 clients read only apk/sha256 (and resolve a relative apk against https://shiying-louis.pages.dev/) → arm64 build.
     "apk": abis["arm64-v8a"]["apk"], "sha256": abis["arm64-v8a"]["sha256"],
     "abis": abis, "notes": notes, "minSdk": 24}
json.dump(v, open(os.path.join(out, "version.json"), "w"), ensure_ascii=False, indent=2)
rows = "".join(f'<li><a href="{html.escape(a["apk"])}">{html.escape(os.path.basename(a["apk"]))}</a>（{abi}，{a["size"]/1048576:.1f} MB）<br><code>SHA-256 {a["sha256"]}</code></li>' for abi, a in abis.items())
page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>拾影 {vn} 下载</title><style>body{{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111;background:#fff}}
h1{{color:#D9192B}}a{{color:#D9192B;font-weight:700}}li{{margin:14px 0}}code{{font-size:11px;color:#5A5A5A;word-break:break-all}}pre{{white-space:pre-wrap;background:#F4F4F6;padding:12px;border-radius:8px}}</style></head>
<body><h1>拾影 {vn}</h1><p>国内外主流平台视频 / 图集保存工具（个人使用）。大多数手机请下载 <b>arm64-v8a</b> 版本；已安装旧版可直接覆盖安装，或在 App 里点 ⋮ → 检查更新。</p>
<ul>{rows}</ul><h3>更新内容</h3><pre>{html.escape(notes)}</pre><p><small>版本号 {vc} · 解析引擎 yt-dlp（youtubedl-android，GPL-3.0）</small></p></body></html>"""
open(os.path.join(out, "index.html"), "w").write(page)
print(json.dumps({k: (v[k] if k != "notes" else "…") for k in v}, ensure_ascii=False, indent=1))
P
ls -la "$OUT"
