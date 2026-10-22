import type { DanmakuPlacement } from '@common/app-config'
import { computed } from 'vue'

/** 视频实际渲染区（去 letterbox 黑边）在容器内的矩形；元数据未就绪时为 null */
export interface DanmakuLayerRect {
  left: number
  top: number
  width: number
  height: number
  bottom: number
}

// 弹幕字号随画面渲染区短边等比缩放的系数：竖屏直播高度≈窗口全高，按高度算会顶到上限，
// 短边与画面宽度同阶，气泡占画面的比例在横竖屏下才均匀
const FONT_RATIO = 0.033
// 弹幕条距画面左 / 下边的内缩量
const MARGIN = 12
// bottom 下限：避开底部控制条
const MIN_BOTTOM = 46
// 左侧黑边最小宽度：更窄时一列排不下几个字，不如留在画面内
const MIN_LEFT_BAR = 220

export interface DanmakuLayerLayout {
  fontSize: number
  left: string
  bottom: string
  /** 渲染区未知时不产出：交给 .danmaku-list 的 width 兜底 */
  width?: string
  /** 生效中的摆放：请求 left 但黑边不够宽时回落画面内 */
  floating: boolean
  /** 当前画面能否提供左侧栏（黑边够宽），决定「移到左侧」入口是否可用 */
  canFloatLeft: boolean
}

/**
 * 弹幕层的字号与几何（纯函数，便于直接测）。
 * 画面内锚视频渲染区左下角；左侧栏贴屏幕最左、宽度铺满屏幕。
 */
export function computeDanmakuLayout(
  rect: DanmakuLayerRect | null,
  options: { compact: boolean, fullscreen: boolean, placement: DanmakuPlacement },
): DanmakuLayerLayout {
  const { compact, fullscreen, placement } = options
  // 非全屏播放窗面积小，若仍沿用 18px 上限，在 1080p / 2K 显示器上会和全屏几乎一样大，
  // 相对小窗显得拥挤；窗口态封顶 14px，全屏再放开到 18px。
  const [min, max] = compact ? [10, 14] : fullscreen ? [12, 18] : [12, 14]
  const shortSide = rect ? Math.min(rect.width, rect.height) : 0
  const fontSize = Math.min(max, Math.max(min, Math.round(shortSide * FONT_RATIO)))

  const canFloatLeft = rect !== null && rect.left >= MIN_LEFT_BAR
  const floating = placement === 'left' && canFloatLeft

  if (!rect) {
    return {
      fontSize,
      left: `${MARGIN}px`,
      bottom: `${MIN_BOTTOM}px`,
      floating,
      canFloatLeft,
    }
  }

  const bottom = `${Math.max(MIN_BOTTOM, rect.bottom + MARGIN).toFixed(1)}px`

  if (floating) {
    return {
      fontSize,
      left: `${MARGIN}px`,
      bottom,
      // 只在起点贴屏幕最左，宽度铺满屏幕：长度不受黑边约束，长句不必在窄栏里折成多行。
      // 气泡左对齐，短句本来就落在黑边内，越出画面的只有长句
      width: `calc(100% - ${MARGIN * 2}px)`,
      floating,
      canFloatLeft,
    }
  }

  return {
    fontSize,
    left: `${(rect.left + MARGIN).toFixed(1)}px`,
    bottom,
    // 宽度锚渲染区：竖屏下容器远宽于画面，气泡不得越过黑边
    width: `${rect.width.toFixed(1)}px`,
    floating,
    canFloatLeft,
  }
}

/**
 * 弹幕层的字号与定位，直播与回放共用。
 * placement 缺省为画面内：迷你浮窗等不支持左侧栏的场景不传。
 */
export function useDanmakuLayer(options: {
  videoRect: () => DanmakuLayerRect | null
  compact: () => boolean
  fullscreen: () => boolean
  placement?: () => DanmakuPlacement
  /** 额外宽度上限（CSS 长度）；不传则沿用布局自身的 width */
  maxWidth?: () => string | undefined
}) {
  const { videoRect, compact } = options

  const layout = computed(() => computeDanmakuLayout(videoRect(), {
    compact: compact(),
    fullscreen: options.fullscreen(),
    placement: options.placement?.() ?? 'video',
  }))

  const fontSize = computed(() => layout.value.fontSize)
  const position = computed(() => {
    const maxWidth = options.maxWidth?.()
    return {
      left: layout.value.left,
      bottom: layout.value.bottom,
      width: layout.value.width,
      ...(maxWidth ? { maxWidth } : {}),
    }
  })
  const canFloatLeft = computed(() => layout.value.canFloatLeft)
  const floating = computed(() => layout.value.floating)

  /**
   * 画面渲染区左上角锚点（与 position 同一内缩量）：互动榜单面板悬于气泡层正上方并左对齐用。
   *  左侧栏模式下跟着气泡层一起去屏幕左上角，两者不能一个在画面上、一个在黑边里
   */
  const topLeft = computed(() => {
    if (layout.value.floating)
      return { left: `${MARGIN}px`, top: `${MARGIN}px` }
    const rect = videoRect()
    if (!rect)
      return { left: `${MARGIN}px`, top: `${MARGIN}px` }

    return {
      left: `${(rect.left + MARGIN).toFixed(1)}px`,
      top: `${(rect.top + MARGIN).toFixed(1)}px`,
    }
  })

  return { fontSize, position, topLeft, canFloatLeft, floating }
}
