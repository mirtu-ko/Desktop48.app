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

/* 初始尺寸策略：按显示器工作区（DIP，已含系统缩放）比例推导，不写死像素，
   同一套比例在小屏 / 大屏上观感一致。 */

/** 初始视频区宽度 = 工作区宽度 × 此比例（横屏视频的实际约束） */
export const FLOAT_INITIAL_WIDTH_RATIO = 0.45

/** 初始视频区高度上限 = 工作区高度 × 此比例（竖屏视频的实际约束） */
export const FLOAT_INITIAL_HEIGHT_RATIO = 0.7

/** 显示器工作区（DIP），只取计算所需字段 */
export interface WorkArea {
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
