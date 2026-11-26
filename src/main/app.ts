import type { WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, powerSaveBlocker, screen, shell } from 'electron'
import iconWin from '../../resources/icon-win.ico?asset'
import icon from '../../resources/icon.png?asset'
import trayIco from '../../resources/tray.ico?asset'
import trayTemplate from '../../resources/trayTemplate.png?asset'
import trayUnread from '../../resources/trayUnread.png?asset'
import { cleanupDanmakuSessions } from './bilibili/danmaku-session'
import { DISK_CACHE_LIMIT_BYTES, scheduleCacheAutoClean } from './cache-storage'
import { ConfigStore } from './config-store'
import { Database } from './database'
import { stopAllFfmpegTasks } from './ffmpeg/ffmpeg-process'
import { registerAllIPC } from './ipc'
import { sendIpc } from './ipc/send'
import { log } from './logger'
import { ensureAuthLoaded } from './pocket48/pocket-auth'
import { cleanupPocketDanmakuSessions } from './pocket48/pocket-danmaku'
import { cleanupRoomQChatSessions } from './pocket48/pocket-room-qchat'
import { startPocketUnread, stopPocketUnread } from './pocket48/pocket-unread'
import { cleanupStreamSessions } from './stream'
import { destroyTray, installTray, isTrayActive } from './tray'
import { initUpdater, scheduleStartupCheck, startPendingInstall } from './updater'
import { closeAllFloatWindows } from './window/float-window'
import { closeSplashWindow, fadeInWindow, fadeOutSplashWindow, isSplashWindow, showSplashWindow } from './window/splash-window'
import { centerWindow, computeWindowBounds, fitWindowToWorkArea } from './window/window-bounds'
import { wireWindowStateEvents } from './window/window-events'
import './http-server' // live中转服务器主进程注册（side effect：启动本地 HTTP-FLV 服务）

/** Chromium 磁盘缓存硬上限（淘汰口径见 cache-storage.ts）；必须在 app ready 前设置 */
app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_LIMIT_BYTES))

/**
 * 下载目录的系统默认值。Electron 的标准路径按当前平台解析：
 * Windows 常见为 `C:\Users\<user>\Downloads`，macOS/Linux 也使用各自的用户下载目录。
 * getPath 在个别早期环境可能不可用时返回空串，仍由启动前的环境校验兜底。
 */
function defaultDownloadDirectory(): string {
  try {
    return app.getPath('downloads')
  }
  catch (error) {
    log('[app.ts] 读取系统下载目录失败，暂不写入默认值:', error)
    return ''
  }
}

// 存储初始化与全部 IPC 通道注册（两个存储模块本身都无副作用，单例在此显式拉起）
// 配置（app-config.json）与成员库（database.json）分开存放：改设置不再重写整库。
const database = Database.instance()
database.init()
// 升级迁移：旧版本把配置存在 database.json 的 config 字段里，先写新文件，成功后再清旧字段。
// ConfigStore.init 在 app-config.json 已存在时忽略 legacy，重复启动不会用旧值覆盖新值。
ConfigStore.instance().init({ downloadDirectory: defaultDownloadDirectory() }, database.takeLegacyConfig())
database.dropLegacyConfig()
registerAllIPC()

log('[app.ts] 主进程路径:', process.execPath)
log('[app.ts] 预加载:', fileURLToPath(new URL('../preload/index.mjs', import.meta.url)))
log('[app.ts] 系统平台:', process.platform)
log('[app.ts] Electron 版本:', process.versions.electron)
log('[app.ts] Node.js 版本:', process.versions.node)
log('[app.ts] Chromium 版本:', process.versions.chrome)

/**
 * 开发环境渲染页自身的 origin（ELECTRON_RENDERER_URL）；生产环境为空串。
 * 进程内不变，模块加载时算一次。
 */
const devRendererOrigin = (() => {
  const url = process.env.ELECTRON_RENDERER_URL
  if (!is.dev || !url)
    return ''
  try {
    return new URL(url).origin
  }
  catch {
    return ''
  }
})()

/** 是否为开发环境渲染页自身的导航（含整页刷新）；生产环境恒为 false */
function isRendererOrigin(url: string): boolean {
  if (!devRendererOrigin)
    return false
  try {
    return new URL(url).origin === devRendererOrigin
  }
  catch {
    return false
  }
}

// 保持对主窗口的引用，供自定义标题栏窗口控制使用
let mainWindow: BrowserWindow | null = null
/** 是否正处于退出流程：置位后主窗口 close 放行，不再隐藏到托盘 */
let isQuitting = false

/**
 * 是否把主窗口「关闭」转为隐藏到托盘：Windows 由 trayOnClose 开关决定；
 * macOS 菜单栏常驻，关窗即隐藏（与系统里点关闭不退出应用的习惯一致）；其余平台不拦截。
 */
function shouldHideToTray(): boolean {
  if (isQuitting)
    return false
  if (process.platform === 'darwin')
    return true
  return process.platform === 'win32'
    && ConfigStore.instance().getConfig('trayOnClose') === 'on'
}

/** 显示 / 聚焦主窗口；主窗口不存在（已销毁）时重建。托盘点击、菜单与 activate/second-instance 共用 */
function showMainWindow(): BrowserWindow | null {
  const win = activeWindow() ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !isSplashWindow(w))
  if (!win) {
    createWindow()
    return activeWindow()
  }
  if (win.isMinimized())
    win.restore()
  win.show()
  win.focus()
  // macOS 从菜单栏 / Dock 唤回时进程可能仍未激活，show 不会把应用拉到前台，需显式激活
  if (process.platform === 'darwin')
    app.focus({ steal: true })
  return win
}

/** 托盘点未读房间：先唤回主窗口，再让渲染层切到房间页定位该成员 */
function openRoomFromTray(userId: number): void {
  const win = showMainWindow()
  if (!win)
    return
  const deliver = () => sendIpc(win.webContents, 'openRoomFromTray', userId)
  // 窗口刚重建时渲染层还没加载完，直接 send 会丢，等它就绪再发一次
  if (win.webContents.isLoading())
    win.webContents.once('did-finish-load', deliver)
  else
    deliver()
}

/**
 * 窗口图标按平台取不同图稿：Windows 用与安装包 exe 同一份多尺寸 ico（满幅、16~256 各档齐全），
 * macOS / Linux 用带留白的方形图稿（Dock 侧自带留白，满幅图稿会顶格）。
 * resources/icon.png 是 macOS 图稿，直接给 Windows 用会让任务栏图标整体缩小约 19%。
 */
const appIcon = process.platform === 'win32' ? iconWin : icon

function createWindow(): void {
  // 初始尺寸随工作区伸缩；下限跟着收敛，否则 Electron 会把窗口强行抻出屏幕
  const { workArea } = screen.getPrimaryDisplay()
  const bounds = computeWindowBounds(workArea)
  const { x, y } = centerWindow(workArea, bounds)
  // 创建浏览器窗口。
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    x,
    y,
    show: false,
    frame: false, // 纯自定义标题栏：去掉系统边框与默认按钮
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false,
    },
  })
  mainWindow = win

  // 托盘 / 菜单栏常驻：关闭主窗口时隐藏（不销毁），退出流程中照常关闭。
  // 只隐藏窗口，不切换程序坞显隐（TransformProcessType 会强制重排菜单栏）
  win.on('close', (event) => {
    if (shouldHideToTray()) {
      event.preventDefault()
      win.hide()
    }
  })
  // 首帧只处理一次：dev 下 HMR full-reload 等场景可能再次派发 ready-to-show，
  // 不能把已隐藏到托盘的窗口拉回，也不能把已不透明的窗口重播一遍透明淡入
  let shownOnce = false
  win.on('ready-to-show', () => {
    if (shownOnce)
      return
    shownOnce = true
    // 主窗口淡入 + 启动画面淡出同步进行，避免从动画直接切到静止页面的突兀感
    fadeInWindow(win)
    fadeOutSplashWindow()
  })
  // 加载失败兜底：ready-to-show 永不到来，启动画面不能悬停在屏幕上（splash-window 内部另有超时安全网）。
  // 只认主帧失败：子资源加载失败不应收起画面
  win.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame)
      return
    log('[app.ts] 主窗口加载失败:', errorDescription)
    closeSplashWindow()
  })
  // 窗口销毁后必须解除引用：可选链挡不住已销毁对象，调用其方法会抛 "Object has been destroyed"
  win.on('closed', () => {
    if (mainWindow === win)
      mainWindow = null
    // 主窗口关闭即关闭所有独立播放窗，否则它们会让 window-all-closed 不触发、应用无法退出
    closeAllFloatWindows()
    // 播放窗被 destroy() 关闭，渲染端的 stopLiveStream 不会执行（destroy 不触发 unload），
    // 转流进程靠 http-server 的连接关闭回收，但 streamSessions 里的条目会留下。
    // macOS 关主窗口不退出应用 → before-quit 不触发 → 必须在这里清，否则条目一直残留。
    // 幂等：Windows / Linux 上随后 before-quit 再清一次无害。
    cleanupStreamSessions()
  })
  wireWindowStateEvents(win)

  // 外链一律转系统浏览器：openExternal 会把 URL 交给操作系统的默认处理器，
  // 因此必须限定协议——否则渲染层构造 file:// / smb:// 之类即可触发本地动作。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url))
      void shell.openExternal(url)
    return { action: 'deny' }
  })

  // setWindowOpenHandler 只管 window.open / target=_blank；同一窗口内的导航走 will-navigate。
  // 应用内没有需要跟随的页面，任何外部导航都视为「离开应用」，拦下并转系统浏览器。
  win.webContents.on('will-navigate', (event, url) => {
    // 开发环境页面自身就是 http://localhost:5173：整页刷新（HMR full-reload、⌘R）
    // 同样触发本事件，拦下来会把应用自己的路由丢给系统浏览器——那里没有 preload，
    // 只会得到一个空白页。同源导航必须放行，它不是「离开应用」。
    if (isRendererOrigin(url))
      return
    event.preventDefault()
    if (/^https?:/.test(url))
      void shell.openExternal(url)
  })

  // 基于 electron-vite CLI 的渲染进程热重载 (HMR)。
  // 开发环境加载远程 URL，生产环境加载本地 HTML 文件。
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  }
  else {
    win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }
}

/** 显示器插拔 / 分辨率 / 缩放变化后，把已存在的主窗口收回新工作区 */
function refitMainWindowToDisplay(): void {
  const win = activeWindow()
  if (!win || win.isMinimized() || win.isMaximized() || win.isFullScreen())
    return
  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const next = fitWindowToWorkArea(bounds, area)
  if (next.x !== bounds.x || next.y !== bounds.y || next.width !== bounds.width || next.height !== bounds.height)
    win.setBounds(next)
}

// 取当前可用主窗口；窗口已销毁时返回 null。
// 导出供 ipc/register-float-window-ipc.ts 接线播放窗相关通道（窗口引用本身不跨模块共享）
export function activeWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed())
    return mainWindow
  return null
}

// 当运行第二个实例时，显示并聚焦已有主窗口（单实例锁在 index.ts 中已获取）
app.on('second-instance', () => {
  showMainWindow()
})

app.whenReady().then(async () => {
  // 启动动画先行：覆盖凭证载入等异步阶段，主窗口就绪后由 ready-to-show 收尾
  showSplashWindow()

  // 更新模块先就位：上次可能已经把包下好，本次启动就地静默装掉，用户看到的是「启动稍慢，直接是新版本」。
  // 装成功时安装器接管进程，不再建窗口/托盘/轮询——否则会先闪一帧旧界面
  initUpdater()
  if (await startPendingInstall()) {
    closeSplashWindow()
    return
  }

  // 异步加密器在 ready 之后才初始化：先载入凭证，再开窗口与轮询，避免首个请求被判未登录
  await ensureAuthLoaded()

  // 为 Windows 设置应用用户模型 ID。
  electronApp.setAppUserModelId('com.electron.desktop48')

  // dev 按 F12 开 DevTools、prod 屏蔽 Ctrl+R（electron-toolkit optimizer）
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  screen.on('display-metrics-changed', refitMainWindowToDisplay)

  // macOS dev 模式运行的是原生 Electron.app，需手动设置 Dock 图标；打包版由 build/icon.icns 提供
  if (process.platform === 'darwin' && app.dock && icon && is.dev)
    app.dock.setIcon(icon)

  // 系统托盘 / 菜单栏常驻：Windows 用 ico；macOS 两张纯黑模板图，颜色由系统按菜单栏明暗反色
  if (process.platform === 'win32') {
    installTray({ icon: trayIco }, { showWindow: showMainWindow, openRoom: openRoomFromTray })
  }
  else if (process.platform === 'darwin') {
    installTray(
      { icon: trayTemplate, unread: trayUnread },
      { showWindow: showMainWindow, openRoom: openRoomFromTray },
    )
  }

  // 房间未读检测：主进程 60s 低频轮询（页面没开 / 窗口最小化时未读照样积累）
  startPocketUnread()

  // 缓存兜底：20s 后查一次，只清上限管不到的部分
  scheduleCacheAutoClean()

  // 更新检查只做一次（3s + 抖动），没有周期轮询：应用更新频率低，不值得持续联网
  scheduleStartupCheck()

  app.on('activate', () => {
    // 点击 Dock / 任务栏图标恢复应用，统一走 showMainWindow
    showMainWindow()
  })
}).catch((error) => {
  // 启动链路任一环失败都要收掉启动画面，否则它会一直悬在屏幕上
  log('[app.ts] 启动失败:', error)
  closeSplashWindow()
  // 此刻无任何窗口可用，继续常驻只会留下一个不可见的僵尸进程，直接退出
  app.quit()
})

// 所有窗口关闭但应用常驻：macOS 菜单栏常驻一律不退出；Windows 仅在托盘在驻且开关开启时保持
app.on('window-all-closed', () => {
  if (process.platform === 'darwin')
    return
  const keepAlive = process.platform === 'win32'
    && ConfigStore.instance().getConfig('trayOnClose') === 'on'
    && isTrayActive()
  if (!keepAlive)
    app.quit()
})

app.on('before-quit', () => {
  // 进入退出流程：解除 close→hide 拦截并销毁托盘
  isQuitting = true
  closeSplashWindow()
  destroyTray()
  // 应用退出前统一清理独立播放窗 / 直播会话 / 转流进程 / 弹幕长连接
  closeAllFloatWindows()
  cleanupStreamSessions()
  cleanupDanmakuSessions()
  cleanupPocketDanmakuSessions()
  cleanupRoomQChatSessions()
  stopPocketUnread()
  // 对仍在运行的所有 ffmpeg 任务写 'q' 优雅收尾，避免退出后残留孤儿进程
  stopAllFfmpegTasks()
  releaseAllSleepBlockers()
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
