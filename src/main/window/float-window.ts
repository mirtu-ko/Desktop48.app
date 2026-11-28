import type { FloatTopmost } from '@common/app-config'
import type { WindowSize } from '@common/float-window'
import type { FloatPlayerKind, FloatPlayerPayload } from '@preload/ipc-contract'
/**
 * 独立播放窗口（直播 / 回放）的生命周期管理：
 * 按 `kind:liveId` 去重，窗口引用与载荷在此集中持有，渲染端经 floatPlayerGetPayload 回取。
 * 窗口控制通道由 register-window-ipc.ts 按 event.sender 定位，本模块不重复注册。
 */
import type { WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { isFloatTopmost } from '@common/app-config'
import { computeInitialWindowSize, decideAutoFit, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, FLOAT_WINDOW_HASH_PATH, initialFloatTopmost, resolveFloatTopmost, resolveFloatWindowPosition, resolveInitialFloatAspect } from '@common/float-window'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, screen, shell } from 'electron'
import iconWin from '../../../resources/icon-win.ico?asset'
import icon from '../../../resources/icon.png?asset'
import { ConfigStore } from '../config-store'
import { sendIpc } from '../ipc/send'
import { log } from '../logger'
import { isTopmostSupported } from './topmost-support'
import { wireWindowStateEvents } from './window-events'

/** 窗口图标：与主窗口同口径，Windows 取多尺寸 ico，macOS / Linux 取带留白的方形图稿（见 app.ts） */
const appIcon = process.platform === 'win32' ? iconWin : icon

/** 判定「用户手动缩放过」的尺寸容差（DIP），避免 Linux 窗口管理器取整被误判 */
const RESIZE_DETECT_EPSILON = 2

interface FloatWindowRecord {
  win: BrowserWindow
  payload: FloatPlayerPayload
  /** 用户是否手动缩放过 / 最大化过：置位后不再自动改尺寸，尊重用户的选择 */
  userResized: boolean
  /**
   * 自动定形是否已落定（首次定形完成 / 用户最大化）。
   * 落定前不采信 userResized，判据与原因见 common/float-window.ts 的 FloatFitState。
   */
  autoFitSettled: boolean
  /** 最近一次程序设置的尺寸；Linux 上 will-resize 不触发，靠尺寸比对反推用户缩放 */
  lastProgrammaticSize: WindowSize | null
  /** 渲染端上报的播放状态；与本窗的置顶策略一起决定目标层级（见 applyTopmost） */
  playing: boolean
  /** 本窗置顶策略：建窗时取全局偏好，图钉改动只作用于本窗、不落盘 */
  topmost: FloatTopmost
  /** 实际下发的 alwaysOnTop 状态：只用于幂等比对，不是独立状态源 */
  applied: boolean
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

/** 当前全局置顶偏好（新窗的初值）；旧库 / 手改配置里的未知取值按「仅播放时」处理 */
function topmostPreference(): FloatTopmost {
  const value = ConfigStore.instance().getConfig('floatTopmost')
  return isFloatTopmost(value) ? value : 'playing'
}

/**
 * 置顶的唯一写入口：本窗策略 × 播放状态算出目标态，变了才下发。
 * setAlwaysOnTop 每次都排一次 z-order，断流重试的 pause→play 不该让它空转。
 */
function applyTopmost(record: FloatWindowRecord): void {
  if (!isTopmostSupported())
    return
  const desired = resolveFloatTopmost(record.topmost, record.playing)
  if (record.applied === desired)
    return
  record.applied = desired
  if (!record.win.isDestroyed())
    record.win.setAlwaysOnTop(desired)
}

/** 改本窗策略：先回推给渲染端（图钉跟手），再落层级；未变化时不动 z-order */
function setRecordTopmost(record: FloatWindowRecord, topmost: FloatTopmost): void {
  if (record.topmost === topmost)
    return
  record.topmost = topmost
  sendIpc(record.win.webContents, 'windowOnTopmostChange', topmost)
  applyTopmost(record)
}

/** 主窗口所在显示器；主窗口不可用时退回主显示器（screen 只能在 whenReady 后使用） */
function resolveAnchorDisplay(mainWindow: BrowserWindow | null) {
  return mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
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

  // 公演（source==='open'）恒为横屏，直接以 16:9 建窗避免首帧到达后跳变；
  // 个人直播/回放与电台（liveType===2，永不上报 aspect）默认 9:16 兜底
  const workArea = resolveAnchorDisplay(mainWindow).workArea
  const { w: width, h: height } = computeInitialWindowSize(resolveInitialFloatAspect(payload.source), workArea)
  const { x, y } = resolveFloatWindowPosition(workArea, { w: width, h: height }, records.size)
  // 建窗即按全局偏好定态：不支持置顶的平台（Linux）始终为 false；其余按偏好置顶，避免打开瞬间被主窗口盖住
  const preference = topmostPreference()
  const initialTopmost = isTopmostSupported() && initialFloatTopmost(preference)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: FLOAT_MIN_WIDTH,
    minHeight: FLOAT_MIN_HEIGHT,
    frame: false, // 纯自定义标题栏，整条 fw-bar 即拖动区
    resizable: true,
    maximizable: true, // 标题栏自带最大化 / 还原按钮，见 FloatWindowApp.vue
    fullscreenable: true, // 播放器容器全屏依赖它，关掉会被系统拒绝
    // 初值随偏好（见 initialFloatTopmost）；之后的层级变化全部经 applyTopmost
    alwaysOnTop: initialTopmost,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: appIcon,
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
    autoFitSettled: false,
    lastProgrammaticSize: { w: width, h: height },
    playing: false,
    topmost: preference,
    applied: initialTopmost,
  }
  records.set(key, record)

  win.once('ready-to-show', () => {
    if (win.isDestroyed())
      return
    win.show()
    win.focus()
  })

  // 最大化 / 还原状态推给本窗渲染进程：标题栏按钮的图标要跟着换
  wireWindowStateEvents(win)
  // 最大化 / 全屏都视同用户接管尺寸（否则后续 aspect 定形会把最大化抹掉），
  // 同时置位 autoFitSettled：它们本身就是一次尺寸落定
  const takeOverSize = () => {
    record.userResized = true
    record.autoFitSettled = true
  }
  win.on('maximize', takeOverSize)
  win.on('enter-full-screen', takeOverSize)

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
 * 按视频宽高比定形窗口（元数据到达 / 旋屏时调用）。
 * 首次定形无条件执行（判据见 common/float-window.ts 的 decideAutoFit），
 * 落定后才尊重用户手动缩放；必须按工作区整体重算而不能保住当前宽度，
 * 否则横屏会停在 9:16 兜底算出的窄宽度上。
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
  // 最大化 / 全屏期间几何归窗口管理器：此时 setBounds 会被忽略，部分窗口管理器上
  // 反而会直接退出全屏。定形推迟到还原 / 退出全屏后的下一次元数据到达
  if (win.isMaximized() || win.isFullScreen()) {
    log('[float-window] 最大化或全屏中，跳过自动定形:', record.payload.liveId, aspect)
    return
  }

  const [currentW, currentH] = win.getSize()
  const { userResized, fit } = decideAutoFit(record, { w: currentW, h: currentH }, RESIZE_DETECT_EPSILON)
  record.userResized = userResized
  if (!fit) {
    log('[float-window] 用户已接管尺寸，跳过自动定形:', record.payload.liveId, aspect)
    return
  }

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
  // 定形落定：之后才采信「用户缩放过」的信号（含 Linux 的尺寸比对兜底）
  record.autoFitSettled = true
}

/**
 * 播放状态驱动置顶：只记录状态，目标层级由 applyTopmost 统一判定。
 * 渲染端只在播放状态变化时上报，加载期间保持建窗时的置顶态。
 */
export function setFloatWindowPlaying(sender: WebContents, playing: boolean): void {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed())
    return
  const record = findByWindow(win)
  if (!record)
    return
  record.playing = playing
  applyTopmost(record)
}

/**
 * 置顶偏好变更后作用到所有已开窗：全局策略覆盖图钉的临时选择，各窗图钉随之复位。
 * 参数用写入后的值，避免再读一次配置造成两个真值。
 */
export function applyFloatTopmostPreference(preference: FloatTopmost): void {
  for (const record of records.values())
    setRecordTopmost(record, preference)
}

/** 图钉初值：本窗当前策略（渲染端挂载时取一次，之后靠 windowOnTopmostChange 推） */
export function getFloatWindowTopmost(sender: WebContents): FloatTopmost | null {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed())
    return null
  return findByWindow(win)?.topmost ?? null
}

/** 图钉切换：只改本窗、不落盘（关窗即失效）；非法值忽略 */
export function setFloatWindowTopmost(sender: WebContents, topmost: FloatTopmost): void {
  if (!isFloatTopmost(topmost))
    return
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed())
    return
  const record = findByWindow(win)
  if (!record || record.topmost === topmost)
    return
  setRecordTopmost(record, topmost)
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
