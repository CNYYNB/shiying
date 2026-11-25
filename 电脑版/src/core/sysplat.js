'use strict'
/**
 * 按操作系统区分的小工具（纯函数，不依赖 Electron，单元测试直接跑）：
 * 组件文件名、数据目录的显示名、结束进程树的方法、界面上的系统名 / 快捷键写法、登录窗口 UA、macOS 菜单模板。
 * platform 参数取 process.platform 的值（win32 / darwin / linux），默认当前系统。
 */
const path = require('path')

const cur = () => process.platform

/** bin 目录里组件的文件名：Windows 带 .exe */
function binFile(name, platform = cur()) { return platform === 'win32' ? name + '.exe' : name }

/** 数据目录给用户看的写法 */
function dataDirLabel(platform = cur()) {
  if (platform === 'win32') return '%APPDATA%\\拾影'
  if (platform === 'darwin') return '~/Library/Application Support/拾影'
  return '~/.config/拾影'
}

/** 某个子目录给用户看的写法（Windows 用反斜杠） */
function dataSubLabel(sub, platform = cur()) { return dataDirLabel(platform) + (platform === 'win32' ? '\\' : '/') + sub }

/** 默认保存位置：系统「下载」文件夹里的「拾影」（Windows：下载\拾影；macOS：~/Downloads/拾影） */
function defaultSaveDir(downloadsDir, platform = cur()) { return (platform === 'win32' ? path.win32 : path.posix).join(downloadsDir, '拾影') }

/**
 * 结束进程树的方法。yt-dlp 会再启动 ffmpeg，要一起结束。
 *  - Windows：taskkill /T /F
 *  - macOS / Linux：子进程以 detached 启动（自成进程组），向整个进程组（-pid）发 SIGKILL
 */
function killPlan(pid, platform = cur()) {
  if (platform === 'win32') return { type: 'exec', cmd: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
  return { type: 'signal', pid: -pid, signal: 'SIGKILL' }
}

/** spawn yt-dlp 时是否 detached（POSIX 上要自成进程组才能整组结束；Windows 上 detached 会弹出控制台） */
function spawnDetached(platform = cur()) { return platform !== 'win32' }

/** 界面上显示的系统名 */
function osLabel(platform = cur(), arch = process.arch) {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return arch === 'arm64' ? 'macOS（Apple 芯片）' : 'macOS（Intel）'
  return 'Linux'
}

/** 粘贴快捷键的写法 */
function pasteKey(platform = cur()) { return platform === 'darwin' ? '⌘V' : 'Ctrl+V' }

/** 网页登录窗口的 Chrome UA（不带 Electron 字样，系统部分和本机一致） */
function chromeUA(chromeVersion, platform = cur()) {
  const sys = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${sys}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

/** 加密保存用的系统机制（说明用） */
function secureStoreLabel(platform = cur()) {
  if (platform === 'win32') return 'Windows 的加密（DPAPI，只有当前 Windows 用户能解开）'
  if (platform === 'darwin') return 'macOS 钥匙串（Keychain）里的密钥加密'
  return '系统钥匙串（libsecret）加密'
}

/**
 * macOS 应用菜单（中文）。Windows / Linux 返回 null（不显示菜单栏）。
 * 没有「编辑」菜单时 macOS 上 ⌘C / ⌘V 在输入框里不起作用，所以必须有。
 * opts: { appName, isDev, onHomepage }。返回 Menu.buildFromTemplate 用的模板。
 */
function menuTemplate(platform = cur(), opts = {}) {
  if (platform !== 'darwin') return null
  const name = opts.appName || '拾影'
  const sep = { type: 'separator' }
  const view = [
    { role: 'resetZoom', label: '实际大小' },
    { role: 'zoomIn', label: '放大' },
    { role: 'zoomOut', label: '缩小' },
    sep,
    { role: 'togglefullscreen', label: '进入 / 退出全屏' },
  ]
  if (opts.isDev) view.push(sep, { role: 'reload', label: '重新载入' }, { role: 'toggleDevTools', label: '开发者工具' })
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: `关于${name}` },
        sep,
        { role: 'services', label: '服务' },
        sep,
        { role: 'hide', label: `隐藏${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        sep,
        { role: 'quit', label: `退出${name}` }, // ⌘Q
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        sep,
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' }, // ⌘V
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    { label: '显示', submenu: view },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        sep,
        { role: 'close', label: '关闭窗口' }, // ⌘W：只隐藏窗口，下载继续
        { role: 'front', label: '前置全部窗口' },
      ],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [{ label: `${name}主页`, click: () => opts.onHomepage && opts.onHomepage() }],
    },
  ]
}

module.exports = { binFile, dataDirLabel, dataSubLabel, defaultSaveDir, killPlan, spawnDetached, osLabel, pasteKey, chromeUA, secureStoreLabel, menuTemplate }
