/**
 * 独立播放窗口（直播 / 回放）的生命周期管理：
 * 按 `kind:liveId` 去重，窗口引用与载荷在此集中持有，渲染端经 floatPlayerGetPayload 回取。
 * 窗口控制通道由 register-window-ipc.ts 按 event.sender 定位，本模块不重复注册。
 */
import type { WebContents } from 'electron'
import type { WindowSize } from '../common/float-window'
import type { FloatPlayerKind, FloatPlayerPayload } from '../preload/ipc-contract'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, screen, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { computeInitialWindowSize, FLOAT_DEFAULT_ASPECT, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, FLOAT_RADIO_ASPECT, FLOAT_WINDOW_HASH_PATH } from '../common/float-window'
import { log } from './logger'

/** 窗口距工作区右上角的留白 */
const EDGE_MARGIN = 24

/** 判定「用户手动缩放过」的尺寸容差（DIP），避免 Linux 窗口管理器取整被误判 */
const RESIZE_DETECT_EPSILON = 2

interface FloatWindowRecord {
  win: BrowserWindow
  payload: FloatPlayerPayload
  /** 用户是否手动缩放过：置位后不再自动改尺寸，尊重用户的选择 */
  userResized: boolean
  /** 最近一次程序设置的尺寸；Linux 上 will-resize 不触发，靠尺寸比对反推用户缩放 */
  lastProgrammaticSize: WindowSize | null
}

// 按 `${kind}:${liveId}` 持有，兼作去重表与载荷表
const records = new Map<string, FloatWindowRecord>()

function keyOf(kind: FloatPlayerKind, liveId: string): string {
  return `${kind}:${liveId}`
}

/** 夹取到 [min, max]；min > max 时返回 min（工作区比窗口还窄的极端情况） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function findByWindow(win: BrowserWindow): FloatWindowRecord | undefined {
  for (const record of records.values()) {
    if (record.win === win)
      return record
  }
  return undefined
}

/** 主窗口所在显示器；主窗口不可用时退回主显示器（screen 只能在 whenReady 后使用） */
function resolveAnchorDisplay(mainWindow: BrowserWindow | null) {
  return mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
}

/** 摆在主窗口所在显示器的右上角 */
function resolvePlacement(mainWindow: BrowserWindow | null, width: number): { x: number, y: number } {
  const { workArea } = resolveAnchorDisplay(mainWindow)
  return {
    x: Math.round(workArea.x + workArea.width - width - EDGE_MARGIN),
    y: Math.round(workArea.y + EDGE_MARGIN),
  }
}

/**
 * 加载独立播放窗页面：与主窗口复用同一份 index.html，靠 hash 分流到播放器根组件。
 * hash 只带短 key，全量载荷由渲染端经 floatPlayerGetPayload 回取。
 */
function loadFloatWindow(win: BrowserWindow, kind: FloatPlayerKind, liveId: string): void {
  // encodeURIComponent 保证 liveId 里的 & # ? 与中文不会破坏 hash 结构
  const hash = `${FLOAT_WINDOW_HASH_PATH}?kind=${kind}&liveId=${encodeURIComponent(liveId)}`
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}#${hash}`)
  }
  else {
    // LoadFileOptions.hash 会被透传给 url.format()，不能带前导 '#'，也不能拼进 filePath
    void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), { hash })
  }
}

/** 打开独立播放窗；同一 kind:liveId 已存在时直接聚焦复用 */
export function openFloatWindow(kind: FloatPlayerKind, payload: FloatPlayerPayload, mainWindow: BrowserWindow | null): void {
  const key = keyOf(kind, payload.liveId)
  const existing = records.get(key)
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized())
      existing.win.restore()
    existing.win.show()
    existing.win.focus()
    return
  }

  // 电台无视频轨、不会上报 aspect，用横向兜底比例，避免一开就是一条竖带
  const initialAspect = kind === 'live' && payload.liveType === 2 ? FLOAT_RADIO_ASPECT : FLOAT_DEFAULT_ASPECT
  // 初始尺寸按主窗口所在显示器的工作区比例推导（见 common/float-window.ts 的尺寸策略）
  const workArea = resolveAnchorDisplay(mainWindow).workArea
  const { w: width, h: height } = computeInitialWindowSize(initialAspect, workArea)
  const { x, y } = resolvePlacement(mainWindow, width)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: FLOAT_MIN_WIDTH,
    minHeight: FLOAT_MIN_HEIGHT,
    frame: false, // 纯自定义标题栏，整条 fw-bar 即拖动区
    resizable: true,
    maximizable: false,
    fullscreenable: true, // 播放器容器全屏依赖它，关掉会被系统拒绝
    // 创建即置顶：打开瞬间不会被主窗口盖住；之后由播放状态接管（见 setFloatWindowPlaying）
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false,
      // 失焦 / 被遮挡时 Chromium 会节流 rAF 与定时器，弹幕与直播轮询会明显卡顿，播放窗必须关掉
      backgroundThrottling: false,
    },
  })

  const record: FloatWindowRecord = {
    win,
    payload,
    userResized: false,
    lastProgrammaticSize: { w: width, h: height },
  }
  records.set(key, record)

  win.once('ready-to-show', () => win.show())

  // 置顶不跟 focus / blur 联动：播放状态由渲染端上报（见 setFloatWindowPlaying）。
  // will-resize 只在用户手动缩放时触发（程序化设置不触发，Linux 不发射，
  // 漏掉的由 fitFloatWindowAspect 按尺寸比对兜底）。
  win.on('will-resize', () => {
    record.userResized = true
  })
  // 窗口销毁后必须解除引用，否则 records 会一直持有已销毁窗口
  win.on('closed', () => {
    if (records.get(key)?.win === win)
      records.delete(key)
  })

  // 与主窗口一致：外链转系统浏览器，不在播放窗内开新 BrowserWindow
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url))
      void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadFloatWindow(win, kind, payload.liveId)
  log('[float-window] 已创建独立播放窗:', key)
}

/** 渲染端回取载荷（IPC 握手）；窗口 reload 后仍可用（按 key 查表） */
export function getFloatWindowPayload(kind: FloatPlayerKind, liveId: string): FloatPlayerPayload | null {
  return records.get(keyOf(kind, liveId))?.payload ?? null
}

/**
 * 按视频宽高比定形窗口（首次元数据到达时调用）。
 * 用户手动缩放过则不再自动改尺寸（含首次）；必须按工作区整体重算而不能保住当前宽度，
 * 否则横屏视频会停留在 9:16 兜底算出的窄宽度上。
 */
export function fitFloatWindowAspect(sender: WebContents, aspect: number): void {
  if (!(aspect > 0))
    return
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed())
    return
  const record = findByWindow(win)
  if (!record)
    return

  // Linux 上 will-resize 不触发，改用「当前尺寸是否偏离上次程序设置值」反推用户缩放。
  // 放在这里而不是靠 resized 事件：resized 同样是 macOS / Windows 限定。
  if (!record.userResized && record.lastProgrammaticSize) {
    const [w, h] = win.getSize()
    const { w: expectedW, h: expectedH } = record.lastProgrammaticSize
    if (Math.abs(w - expectedW) > RESIZE_DETECT_EPSILON || Math.abs(h - expectedH) > RESIZE_DETECT_EPSILON)
      record.userResized = true
  }
  if (record.userResized)
    return

  const bounds = win.getBounds()
  const { workArea } = screen.getDisplayMatching(bounds)
  const { w, h } = computeInitialWindowSize(aspect, workArea)
  // 保持右上角不动（初始摆放就在工作区右上角）：变宽时向左扩，不会顶出屏幕；再夹回工作区
  const x = clamp(bounds.x + bounds.width - w, workArea.x, workArea.x + workArea.width - w)
  const y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - h)
  // Wayland 下 setBounds 的 x/y 不保证被合成器采纳（位置由合成器决定），尺寸通常仍生效；
  // 这里不额外分支：采纳与否都不影响「尺寸按比例定形」这一主目标
  win.setBounds({ x, y, width: w, height: h })
  record.lastProgrammaticSize = { w, h }
}

/**
 * 播放状态驱动置顶：播放中置顶，暂停 / 结束取消置顶。
 * 渲染端只在状态变化时上报，加载期间保持创建时的置顶态；层级用默认 floating。
 */
export function setFloatWindowPlaying(sender: WebContents, playing: boolean): void {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed())
    return
  win.setAlwaysOnTop(playing)
}

/**
 * 关闭全部独立播放窗（主窗口关闭 / 应用退出时调用，确保 window-all-closed 能触发退出）。
 * 用 destroy() 而非 close()：退出路径不能等待渲染端确认；destroy 不触发 unload，
 * 转流进程靠 http-server 的连接关闭回收，streamSessions 条目由 app.ts 兜底清理。
 */
export function closeAllFloatWindows(): void {
  for (const { win } of [...records.values()]) {
    if (!win.isDestroyed())
      win.destroy()
  }
  records.clear()
}
