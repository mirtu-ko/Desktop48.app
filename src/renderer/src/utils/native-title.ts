// 原生 title 替身的延迟、抖动容差与浮层定位（纯逻辑，供 composables/use-native-title.ts 使用）。

/** 与浏览器原生 tooltip 一致的静止时长 */
export const TITLE_TIP_DELAY = 1000

/** 手抖位移上限：超过才算「鼠标动了」，否则计时会被微抖反复重置 */
export const TITLE_TIP_MOVE_TOLERANCE = 4

const OFFSET_X = 12
const OFFSET_Y = 18
const EDGE_GAP = 8

export interface TipPoint {
  x: number
  y: number
}

export interface TipSize {
  width: number
  height: number
}

export interface TipOffset {
  left: number
  top: number
}

/** 默认落在鼠标右下；贴到右/下边缘时翻到左/上，最终钳进视口 */
export function titleTipPosition(pointer: TipPoint, tip: TipSize, viewport: TipSize): TipOffset {
  let left = pointer.x + OFFSET_X
  let top = pointer.y + OFFSET_Y

  if (left + tip.width > viewport.width - EDGE_GAP)
    left = pointer.x - OFFSET_X - tip.width
  if (top + tip.height > viewport.height - EDGE_GAP)
    top = pointer.y - OFFSET_Y - tip.height

  return {
    left: Math.max(EDGE_GAP, Math.min(left, viewport.width - tip.width - EDGE_GAP)),
    top: Math.max(EDGE_GAP, Math.min(top, viewport.height - tip.height - EDGE_GAP)),
  }
}

/** 位移在容差内仍算静止，避免手抖导致提示永远不出现 */
export function isPointerStill(from: TipPoint, to: TipPoint, tolerance = TITLE_TIP_MOVE_TOLERANCE): boolean {
  return Math.abs(to.x - from.x) <= tolerance && Math.abs(to.y - from.y) <= tolerance
}
