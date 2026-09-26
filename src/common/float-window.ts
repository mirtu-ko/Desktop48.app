/**
 * 独立播放窗口（直播 / 回放）的共享常量与几何工具，主进程与渲染端共用。
 *
 * 这里是「跨进程的唯一来源」：主进程据此算窗口尺寸与构造 hash 路由，
 * 渲染端据此对齐标题栏高度、分流入口。改动任一常量两侧同时生效。
 */

export interface WindowSize {
  w: number
  h: number
}

/**
 * 独立播放窗的 hash 路由路径（**不含前导 `#`**，也不含 query）。
 *
 * 两个消费方必须同源，否则播放窗会挂载成主界面：
 * - 主进程 `main/float-window.ts` 用它拼 `loadFile(html, { hash })`（hash 不能带 `#`）
 * - 渲染端 `renderer/src/main.ts` 用它判断 `window.location.hash` 该挂哪个根组件
 *
 * 与主窗口的 `createWebHashHistory()` 共用同一命名空间，因此主窗口路由表里
 * **不得**出现以 `/float` 开头的路径。
 */
export const FLOAT_WINDOW_HASH_PATH = '/float'

/**
 * 独立播放窗自定义标题栏（.fw-bar）高度。
 * 注意：与 FloatWindowApp.vue 的 .fw-bar 保持一致，改动需同步。
 */
export const FLOAT_BAR_HEIGHT = 36

/** 视频元数据未就绪时的兜底宽高比（多数直播为竖屏） */
export const FLOAT_DEFAULT_ASPECT = 9 / 16

/** 电台（liveType===2，无视频轨、永不上报 aspect）的兜底宽高比 */
export const FLOAT_RADIO_ASPECT = 16 / 9

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

/* ---------------------------------------------------------------------------
 * 初始尺寸策略：按所在显示器工作区比例推导，不写死像素。
 *
 * 目标是「同一套比例在 1366×768 的小屏和 4K 大屏上观感一致」：
 * 小屏不会一开就占掉半个屏幕，大屏也不至于小得像缩略图。
 * 注意 workArea 是 DIP（已含系统缩放），所以 4K@200% 会按 1920×1080 计算，
 * 观感与 1080p@100% 一致 —— 这正是我们要的。
 * ------------------------------------------------------------------------- */

/**
 * 初始视频区宽度 = 工作区宽度 × 此比例。
 *
 * 只对**横屏视频**生效：竖屏视频会被下面的高度上限先卡住，宽度再大也用不上。
 * 所以这个值实际决定「横屏直播 / 录播 / 电台开出来多大」—— 横屏只有宽度这一个约束，
 * 给太小会明显偏窄（0.45 × 1920 = 864 宽，16:9 下约 864×486 的视频区）。
 */
export const FLOAT_INITIAL_WIDTH_RATIO = 0.45

/**
 * 初始视频区高度上限 = 工作区高度 × 此比例。
 *
 * 只对**竖屏视频**生效（0.7 × 1080 = 756 高），横屏视频高度远达不到这个上限。
 */
export const FLOAT_INITIAL_HEIGHT_RATIO = 0.7

/** 显示器工作区（DIP），只取计算所需字段 */
export interface WorkArea {
  width: number
  height: number
}

/**
 * 计算独立播放窗的尺寸（含标题栏）。
 *
 * 先用两个比例圈出一个「可用框」，再让视频区按 aspect 内接进去（宽优先，超高则回缩宽度），
 * 最后叠加标题栏；结果不小于最小尺寸，保证极端小屏 / 极端比例下不退化。
 *
 * 两个比例各管一个方向：横屏视频吃宽度上限、竖屏视频吃高度上限，
 * 因此同一块屏幕上横屏和竖屏都不会有一方被另一方的兜底比例带偏。
 *
 * 建窗时和真实宽高比到达后**共用这一个函数**：兜底比例（9:16）算出的尺寸只是临时值，
 * 真实比例到达时必须整体重算，不能只保住兜底宽度 —— 否则横屏视频会一直停留在竖屏的窄宽度上。
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
