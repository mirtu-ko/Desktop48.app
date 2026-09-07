/**
 * 播放器浮窗（FloatPlayer）尺寸与摆位常量。
 *
 * 尺寸不是写死的档位：窗口按视频实际宽高比（含旋转后的交换）自动定形——
 * 迷你 / 放大各对应一个「视口外接框」（比例见下），从框中内接出该比例的
 * 最大矩形作为视频区，窗口高度再叠加标题条，画面零黑边。
 */

export interface WindowSize {
  w: number
  h: number
}

/**
 * 浮窗标题栏（fp-bar）高度。
 * 注意：与 AppTitleBar 的 36px 主标题栏保持一致（浮窗钳制 y≥36 避开原生拖拽带），改动需同步。
 */
export const FP_BAR_HEIGHT = 36

/** 视频元数据未就绪 / 电台（无视频轨）时的兜底宽高比，竖向（近似旧版 320×540 档） */
export const DEFAULT_ASPECT = 9 / 16

/**
 * 外接框占主窗口可用区域（视口宽 × 视口高减标题栏）的比例。
 * 以 1440×900 为例：迷你框约 648×482（16:9 视频得 648×364、9:16 得 271×482），
 * 放大框约 1152×706。调手感改这两个比例即可。
 */
export const MINI_BOX_RATIO = { w: 0.45, h: 0.6 }
export const EXPAND_BOX_RATIO = { w: 0.8, h: 0.88 }

/**
 * 回放放大态的弹幕侧栏预留宽度。
 * 唯一来源：PlaybackPlayer 经根节点 :style 注入 CSS 变量 --barrage-sidebar-width，
 * 其 .barrage-box 样式引用该变量（B-3 收口，不再手工同步两处数值）；
 * 仅当侧栏实际占位（有弹幕数据且未收起，经 sidebar 事件上报）时预留，
 * 无弹幕 / 收起列表时放大窗按纯视频比例收窄。
 */
export const BARRAGE_SIDEBAR_WIDTH = 360

/** 折叠胶囊条：高度即标题栏高度，只留一条 fp-bar */
export const PILL_SIZE: WindowSize = { w: 280, h: FP_BAR_HEIGHT }

/** 拖拽松手后，窗口边缘距屏幕边缘小于该值则自动吸附 */
export const SNAP_EDGE = 16
/** 顶部吸附判定：标题栏下方该范围内吸顶 */
export const SNAP_TOP = 24

/** 多窗口初始级联：按创建序号错位，最多错开 CASCADE_MAX 个位置 */
export const CASCADE_STEP = 36
export const CASCADE_MAX = 6
/** 首个窗口的起始纵向偏移（主标题栏以下） */
export const CASCADE_TOP_OFFSET = 30
/** 首个窗口的右侧留白 */
export const CASCADE_RIGHT_OFFSET = 24
/** 尺寸收缩时保留的视口边距（左右合计 / 顶部标题栏以外） */
export const VIEWPORT_PADDING_X = 16
export const VIEWPORT_PADDING_BOTTOM = 12

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
