import type { WebContents } from 'electron'
import fs from 'node:fs'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, powerSaveBlocker, shell } from 'electron'
import icon from '../../resources/icon.png?asset'

import { Database } from './database'
import { stopAllFfmpegTasks } from './ffmpeg/ffmpeg-process'
import { registerAllIPC } from './ipc'
import { closeLog, getLogPathForDisplay, log } from './logger'
import { cleanupStreamSessions } from './stream'
import './http-server' // live中转服务器主进程注册（side effect：启动本地 HTTP-FLV 服务）

// 数据库初始化与全部 IPC 通道注册（database.ts 模块本身无副作用，单例在此显式拉起）
Database.instance().init()
registerAllIPC()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

log('[app.ts] Electron app.ts __filename:', __filename)
log('[app.ts] Electron app.ts __dirname:', __dirname)
log('[app.ts] 日志目录:', getLogPathForDisplay())
log('[app.ts] 主进程路径:', process.execPath)
log('[app.ts] 主进程工作目录:', process.cwd())
log('[app.ts] 预加载:', join(__dirname, '../preload/index.js'), fs.existsSync(join(__dirname, '../preload/index.js')))
log('[app.ts] 系统平台:', process.platform)
log('[app.ts] Electron 版本:', process.versions.electron)
log('[app.ts] Node.js 版本:', process.versions.node)
log('[app.ts] Chromium 版本:', process.versions.chrome)

// 系统服务类 IPC 通道（openPath/selectDirectory/pathJoin/netRequest/getDesktopPath/checkFfmpegBinaries）
// 已移至 ipc/register-system-ipc.ts，由上方 registerAllIPC() 统一注册

// 保持对主窗口的引用，供自定义标题栏窗口控制使用
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // 创建浏览器窗口。
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    frame: false, // 纯自定义标题栏：去掉系统边框与默认按钮
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
    },
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })
  // 窗口销毁后必须解除引用：可选链挡不住已销毁对象，调用其方法会抛 "Object has been destroyed"
  win.on('closed', () => {
    if (mainWindow === win)
      mainWindow = null
  })
  wireWindowEvents(win)

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 基于 electron-vite CLI 的渲染进程热重载 (HMR)。
  // 开发环境加载远程 URL，生产环境加载本地 HTML 文件。
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  }
  else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 监听窗口最大化 / 还原状态变化并通知渲染进程
function wireWindowEvents(win: BrowserWindow): void {
  const send = () => {
    if (!win.isDestroyed())
      win.webContents.send('windowOnMaximizeChange', win.isMaximized())
  }
  win.on('maximize', send)
  win.on('unmaximize', send)
}

// 取当前可用主窗口；窗口已销毁时返回 null。
// 导出供 ipc/register-window-ipc.ts 接线窗口控制通道（窗口引用本身不跨模块共享）
export function activeWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed())
    return mainWindow
  return null
}

// 窗口控制通道（windowMinimize/windowToggleMaximize/windowClose/windowIsMaximized）
// 已移至 ipc/register-window-ipc.ts，由 registerAllIPC() 统一注册

// 当运行第二个实例时，聚焦到已有窗口（单实例锁在 index.ts 中已获取）
app.on('second-instance', () => {
  const win = activeWindow() ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
  if (!win)
    return
  if (win.isMinimized())
    win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  // 为 Windows 设置应用用户模型 ID。
  electronApp.setAppUserModelId('com.electron.desktop48')

  // macOS 下 BrowserWindow 的 icon 选项无效，dev 模式运行的是原生 Electron.app，
  // 需要手动设置 Dock 图标；打包版由 build/icon.icns 提供，不受影响
  if (process.platform === 'darwin' && app.dock)
    app.dock.setIcon(icon)

  // dev 按 F12 开 DevTools、prod 屏蔽 Ctrl+R（electron-toolkit optimizer）
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow()
  })
})

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 直播流会话与转流进程清理（原 stream.ts 模块级 before-quit，现改为显式调用，
  // 使全部退出清理集中在此处可见）
  cleanupStreamSessions()
  // 对仍在运行的所有 ffmpeg 任务写 'q' 优雅收尾，避免退出后残留孤儿进程
  stopAllFfmpegTasks()
  releaseAllSleepBlockers()
})

// 日志流最后关闭：必须晚于所有 before-quit 清理，否则清理阶段的日志会 write-after-end 被丢弃
app.on('will-quit', () => {
  closeLog()
})

// 阻止休眠：id 由主进程按 webContents 维护。
// 渲染进程刷新或崩溃时它无法把 id 传回来，只能由主进程在 webContents 销毁时兜底释放，
// 否则 blocker 会一直生效到应用退出。
// 状态与释放逻辑归 app.ts 所有；ipc/register-window-ipc.ts 只负责把通道接到下面两个导出函数。
const sleepBlockers = new Map<number, number>()

function releaseSleepBlocker(webContentsId: number): void {
  const blockerId = sleepBlockers.get(webContentsId)
  if (blockerId === undefined)
    return
  sleepBlockers.delete(webContentsId)
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId)
    log('[app.ts] 已允许系统休眠，ID:', blockerId)
  }
}

function releaseAllSleepBlockers(): void {
  for (const webContentsId of [...sleepBlockers.keys()])
    releaseSleepBlocker(webContentsId)
}

export function preventSleepForSender(sender: WebContents): number {
  const webContentsId = sender.id
  // 幂等：同一 webContents 重复请求（如两次 playing 事件竞态）时复用已有 blocker，避免泄漏
  const existing = sleepBlockers.get(webContentsId)
  if (existing !== undefined && powerSaveBlocker.isStarted(existing))
    return existing

  const id = powerSaveBlocker.start('prevent-display-sleep')
  sleepBlockers.set(webContentsId, id)
  sender.once('destroyed', () => releaseSleepBlocker(webContentsId))
  log('[app.ts] 已阻止系统休眠，ID:', id)
  return id
}

export function allowSleepForSender(sender: WebContents): void {
  // 以 webContents 为准，忽略渲染进程传来的 id：刷新后它持有的 id 已经失效
  releaseSleepBlocker(sender.id)
}
