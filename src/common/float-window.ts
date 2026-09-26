/** 独立播放窗的共享常量与几何工具，主进程与渲染端跨进程共用的唯一来源。 */

export interface WindowSize {
  w: number
  h: number
}

/**
 * 独立播放窗的 hash 路由路径（不含前导 #，也不含 query）。
 * 主进程拼 loadFile hash、渲染端判断挂载根组件共用；主窗口路由表不得占用 /float 前缀。
 */
export const FLOAT_WINDOW_HASH_PATH = '/float'

/** 独立播放窗自定义标题栏（.fw-bar）高度；FloatWindowApp.vue 经 :style 同源引用 */
export const FLOAT_BAR_HEIGHT = 36

/** 视频元数据未就绪时的兜底宽高比（多数直播为竖屏） */
export const FLOAT_DEFAULT_ASPECT = 9 / 16

/**
 * 电台窗（`liveType === 2`）的**固定**尺寸（含标题栏），竖屏。
 * 电台无视频轨、永不上报 aspect，形状不需跟画面走；不随分辨率自适应，
 * 只受窗口最小尺寸约束，屏幕装不下时用户可自行缩放。
 */
export const FLOAT_RADIO_WINDOW_SIZE: WindowSize = { w: 360, h: 640 }

/** 窗口最小尺寸：再小控制条会挤爆，且比例内接需要有效输入 */
export const FLOAT_MIN_WIDTH = 240
export const FLOAT_MIN_HEIGHT = 160

/** 在 box 内为给定宽高比内接出最大矩形（宽优先，超高再回缩），即窗口视频区尺寸 */
export function fitAspectInBox(aspect: number, boxW: number, boxH: number): WindowSize {
  let w = boxW
  let h = w / aspect
  if (h > boxH) {
    h = boxH
    w = h * aspect
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/* 初始尺寸策略：按显示器工作区（DIP，已含系统缩放）比例推导，不写死像素，
   同一套比例在小屏 / 大屏上观感一致。 */

/** 初始视频区宽度 = 工作区宽度 × 此比例（横屏视频的实际约束） */
export const FLOAT_INITIAL_WIDTH_RATIO = 0.45

/** 初始视频区高度上限 = 工作区高度 × 此比例（竖屏视频的实际约束） */
export const FLOAT_INITIAL_HEIGHT_RATIO = 0.7

/** 显示器工作区（DIP，含原点），只取计算所需字段 */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 计算独立播放窗的尺寸（含标题栏）：视频区在比例框内内接，结果不小于最小尺寸。
 * 建窗与真实比例到达时共用此函数整体重算，不能只保住兜底宽度。
 */
export function computeInitialWindowSize(aspect: number, workArea: WorkArea): WindowSize {
  const maxW = Math.round(workArea.width * FLOAT_INITIAL_WIDTH_RATIO)
  const maxH = Math.round(workArea.height * FLOAT_INITIAL_HEIGHT_RATIO) - FLOAT_BAR_HEIGHT
  const video = fitAspectInBox(aspect, maxW, maxH)
  return {
    w: Math.max(FLOAT_MIN_WIDTH, video.w),
    h: Math.max(FLOAT_MIN_HEIGHT, video.h + FLOAT_BAR_HEIGHT),
  }
}

/* 自动定形前的状态判定（纯函数：主进程侧依赖 electron，无法单测） */

/** 判定所需的状态快照（主进程 record 的结构子集） */
export interface FloatFitState {
  /** 用户是否手动缩放过 / 最大化过：置位后不再自动改尺寸 */
  userResized: boolean
  /**
   * 自动定形是否已落定（首次定形完成 / 用户最大化时置位）。
   * 落定前不采信 userResized 并直接清零：建窗用 9:16 兜底，实际尺寸 ≠ 请求值
   * 是常态（Windows DPI electron#10862、Linux 取整、will-resize 可能随建窗误报）；
   * 误报若不清零，会永久禁掉后续所有自动定形。
   */
  autoFitSettled: boolean
  /** 最近一次程序设置的尺寸，用于反推用户缩放（Linux 上 will-resize 不触发） */
  lastProgrammaticSize: WindowSize | null
}

/**
 * 结算「本次是否应当自动定形」。
 *
 * - `userResized`：结算后的标志（含按尺寸比对反推出来的），调用方需写回 record
 * - `fit`：本次是否执行定形
 */
export function decideAutoFit(
  state: FloatFitState,
  currentSize: WindowSize,
  epsilon: number,
): { userResized: boolean, fit: boolean } {
  // 落定前无条件定形并清零 userResized（原因见 autoFitSettled）
  if (!state.autoFitSettled)
    return { userResized: false, fit: true }

  let userResized = state.userResized
  if (!userResized && state.lastProgrammaticSize) {
    const { w: expectedW, h: expectedH } = state.lastProgrammaticSize
    // Linux 兜底：will-resize 不触发，靠「当前尺寸偏离上次程序设置值」反推用户缩放
    if (Math.abs(currentSize.w - expectedW) > epsilon || Math.abs(currentSize.h - expectedH) > epsilon)
      userResized = true
  }
  return { userResized, fit: !userResized }
}

/* ---------------------------------------------------------------------------
 * 创建位置：锚定工作区右上角，多窗按对角级联错开，避免新窗完全叠在旧窗上。
 * ------------------------------------------------------------------------- */

/** 播放窗距工作区右上角的留白 */
export const FLOAT_EDGE_MARGIN = 24

/** 级联偏移步长（DIP）：约一行标题栏高，错开即可辨认 */
export const FLOAT_CASCADE_STEP = 28

/**
 * 计算新播放窗的位置。
 *
 * cascadeIndex 传当前已存在的播放窗数（含其它显示器的，仅影响错开档位）：
 * 第 0 个贴右上角，后续每窗向左下错开一步；可用空间算出的步数用尽后回绕。
 * 结果始终夹在工作区内 —— 工作区比窗口还小时钉在原点。
 */
export function resolveFloatWindowPosition(
  workArea: WorkArea,
  size: WindowSize,
  cascadeIndex: number,
): { x: number, y: number } {
  const baseX = workArea.x + workArea.width - size.w - FLOAT_EDGE_MARGIN
  const baseY = workArea.y + FLOAT_EDGE_MARGIN
  // 四周各留一份 margin 后的对角可用距离；窗口比工作区还大时取 0（步数只剩回绕的 1 档）
  const room = Math.max(
    0,
    Math.min(workArea.width - size.w - FLOAT_EDGE_MARGIN * 2, workArea.height - size.h - FLOAT_EDGE_MARGIN * 2),
  )
  const maxSteps = Math.floor(room / FLOAT_CASCADE_STEP) + 1
  const offset = (cascadeIndex % maxSteps) * FLOAT_CASCADE_STEP
  return {
    x: Math.round(Math.max(workArea.x, baseX - offset)),
    y: Math.round(Math.min(baseY + offset, Math.max(workArea.y, workArea.y + workArea.height - size.h))),
  }
}
