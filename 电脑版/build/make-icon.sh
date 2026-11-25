#!/bin/bash
# 由安卓版的图标预览（docs/icon-512.png，橙红渐变“播放 + 下载箭头”）生成 Windows 图标、界面图标和 macOS 图标。
set -e
cd "$(dirname "$0")"
SRC=${1:-icon-512.png}
convert "$SRC" -background none -define icon:auto-resize=256,128,64,48,40,32,24,20,16 icon.ico
convert "$SRC" -resize 256x256 icon.png
node make-icns.js "$SRC"
echo "icon.ico / icon.png / icon.icns 已生成"
