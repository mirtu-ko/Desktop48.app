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
// 弹幕层距画面左 / 右 / 顶边的内缩量：走 .fw-root 的浮层尺寸 token（app.scss），
// 与互动榜锚点、右上角动作钮共用同一个边距，随窗口收放时三处一起动
export const DANMAKU_INSET = 'var(--fp-inset)'
// 距容器底边的避让量：让开底部控制条。胶囊高（钮径 + 上下内距）与悬空量都是
// .fw-root 的浮层尺寸 token（app.scss），随窗口收放时这里自动跟上；纵向一律按窗口算，
// 不跟画面渲染区抬升
export const DANMAKU_CONTROL_CLEARANCE
  = 'calc(var(--fp-capsule-btn) + 2 * var(--fp-capsule-pad) + var(--fp-control-gap))'
// 左侧黑边最小宽度：低于 60px 时难以形成独立栏，不如留在画面内
const MIN_LEFT_BAR = 60

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
 * 横向锚视频渲染区：起点内缩在画面左侧，宽度收到画面内，左右黑边再宽也不进；
 * 纵向贴窗口：盒子从窗口顶铺到控制条上方，画面上下有黑边时照旧铺上去
 * （故 rect 的 top / bottom 不参与计算）；左侧栏模式整列移去屏幕最左、宽度铺满屏幕。
 */
export function computeDanmakuLayout(
  rect: DanmakuLayerRect | null,
  options: { compact: boolean, fullscreen: boolean, placement: DanmakuPlacement, controlsVisible?: boolean },
): DanmakuLayerLayout {
  const { compact, fullscreen, placement, controlsVisible = true } = options
  // 非全屏播放窗面积小，若仍沿用 18px 上限，在 1080p / 2K 显示器上会和全屏几乎一样大，
  // 相对小窗显得拥挤；窗口态封顶 14px，全屏再放开到 18px。
  const [min, max] = compact ? [10, 14] : fullscreen ? [12, 18] : [12, 14]
  const shortSide = rect ? Math.min(rect.width, rect.height) : 0
  const fontSize = Math.min(max, Math.max(min, Math.round(shortSide * FONT_RATIO)))

  const canFloatLeft = rect !== null && rect.left >= MIN_LEFT_BAR
  const floating = placement === 'left' && canFloatLeft
  // 底部控制条隐去时弹幕顺滑落回边缘内缩，避免竖屏小窗底部留白显空
  const bottom = controlsVisible ? DANMAKU_CONTROL_CLEARANCE : DANMAKU_INSET

  if (!rect) {
    return {
      fontSize,
      left: DANMAKU_INSET,
      bottom,
      floating,
      canFloatLeft,
    }
  }

  if (floating) {
    return {
      fontSize,
      left: DANMAKU_INSET,
      bottom,
      // 只在起点贴屏幕最左，宽度铺满屏幕：长度不受黑边约束，长句不必在窄栏里折成多行。
      // 气泡左对齐，短句本来就落在黑边内，越出画面的只有长句
      width: `calc(100% - 2 * ${DANMAKU_INSET})`,
      floating,
      canFloatLeft,
    }
  }

  return {
    fontSize,
    left: `calc(${rect.left.toFixed(1)}px + ${DANMAKU_INSET})`,
    bottom,
    // 宽度锚渲染区并让出左右两侧的内缩量：竖屏下容器远宽于画面，气泡两端都不越黑边；
    // 渲染区窄于两倍内缩量时兜底 0，负宽度会被 CSS 整条忽略、反而退回兜底宽度
    width: `max(0px, calc(${rect.width.toFixed(1)}px - 2 * ${DANMAKU_INSET}))`,
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
  /** 底部控制条当前是否可见；false 时弹幕下沉到边缘内缩 */
  controlsVisible?: () => boolean
  /** 额外宽度上限（CSS 长度）；不传则沿用布局自身的 width */
  maxWidth?: () => string | undefined
  /**
   * 额外底部避让量（CSS 长度）：弹幕输入条展开时压在胶囊上方，
   * 气泡层要同步抬起，否则最底部几条会被输入条盖住。
   */
  extraBottom?: () => string | undefined
}) {
  const { videoRect, compact } = options

  const layout = computed(() => computeDanmakuLayout(videoRect(), {
    compact: compact(),
    fullscreen: options.fullscreen(),
    placement: options.placement?.() ?? 'video',
    controlsVisible: options.controlsVisible?.() ?? true,
  }))

  const fontSize = computed(() => layout.value.fontSize)
  const position = computed(() => {
    const maxWidth = options.maxWidth?.()
    const extraBottom = options.extraBottom?.()
    return {
      left: layout.value.left,
      // 与布局同源的避让量叠加：调用方只负责给出「多了多高」，控制条那段不重复算
      bottom: extraBottom ? `calc(${layout.value.bottom} + ${extraBottom})` : layout.value.bottom,
      width: layout.value.width,
      ...(maxWidth ? { maxWidth } : {}),
    }
  })
  const canFloatLeft = computed(() => layout.value.canFloatLeft)
  const floating = computed(() => layout.value.floating)

  /**
   * 弹幕层左上角锚点（与 position 同一内缩量）：互动榜单面板悬于气泡层正上方并左对齐用。
   *  左侧栏模式下跟着气泡层一起去屏幕左上角，两者不能一个在画面上、一个在黑边里；
   *  画面内模式横向锚渲染区、纵向贴窗口顶，与气泡层的纵向口径一致
   */
  const topLeft = computed(() => {
    if (layout.value.floating)
      return { left: DANMAKU_INSET, top: DANMAKU_INSET }
    const rect = videoRect()
    if (!rect)
      return { left: DANMAKU_INSET, top: DANMAKU_INSET }

    return {
      left: `calc(${rect.left.toFixed(1)}px + ${DANMAKU_INSET})`,
      top: DANMAKU_INSET,
    }
  })

  return { fontSize, position, topLeft, canFloatLeft, floating }
}
