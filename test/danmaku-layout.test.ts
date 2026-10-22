import type { DanmakuLayerRect } from '../src/renderer/src/composables/use-danmaku-layer'
import { describe, expect, it } from 'vitest'
import { computeDanmakuLayout, useDanmakuLayer } from '../src/renderer/src/composables/use-danmaku-layer'

/** 1920×1080 全屏里的 9:16 竖屏画面：高度撑满，左右各 656px 黑边 */
const PORTRAIT: DanmakuLayerRect = { left: 656, top: 0, width: 607, height: 1080, bottom: 0 }
/** 主窗 1280×760 里的同比例竖屏画面 */
const PORTRAIT_WINDOW: DanmakuLayerRect = { left: 426, top: 0, width: 427, height: 760, bottom: 0 }
/** 横屏画面：铺满容器，没有黑边 */
const LANDSCAPE: DanmakuLayerRect = { left: 0, top: 0, width: 1920, height: 1080, bottom: 0 }

function layout(
  rect: DanmakuLayerRect | null,
  placement: 'video' | 'left' = 'video',
  compact = false,
  fullscreen = true,
) {
  return computeDanmakuLayout(rect, { compact, fullscreen, placement })
}

describe('computeDanmakuLayout', () => {
  it('横屏按短边取字号，宽度铺满画面渲染区', () => {
    const result = layout(LANDSCAPE)
    expect(result.fontSize).toBe(18)
    expect(result.width).toBe('1920.0px')
    expect(result.left).toBe('12.0px')
    expect(result.bottom).toBe('46.0px')
  })

  it('横屏非全屏时缩短边缩放，但字号封顶 14px', () => {
    // 1080p 显示器上的初始播放窗约 864×486；同一系数会得到 16px，相对画幅偏大
    const windowed: DanmakuLayerRect = { left: 0, top: 0, width: 864, height: 486, bottom: 0 }
    expect(layout(windowed, 'video', false, false).fontSize).toBe(14)
    expect(layout(windowed, 'video', false, true).fontSize).toBe(16)
  })

  it('竖屏字号按宽度缩放，不因高度撑满而顶到上限', () => {
    // 短边 427 × 0.033 ≈ 14px：按高度算会是 25 → 被 18 上限截住，相对画面大一圈
    expect(layout(PORTRAIT_WINDOW).fontSize).toBe(14)
    expect(layout(PORTRAIT).fontSize).toBe(18)
  })

  it('左侧栏贴屏幕最左，宽度铺满屏幕（不按黑边收窄）', () => {
    const result = layout(PORTRAIT, 'left')
    expect(result.floating).toBe(true)
    expect(result.left).toBe('12px')
    // 宽度只让出左右各 12px 的留白：长句不折行，短句仍落在黑边内
    expect(result.width).toBe('calc(100% - 24px)')
    expect(result.bottom).toBe('46.0px')
  })

  it('黑边过窄时回落画面内，但仍记录「能否浮到左侧」', () => {
    const narrow: DanmakuLayerRect = { left: 100, top: 0, width: 607, height: 1080, bottom: 0 }
    const result = layout(narrow, 'left')
    expect(result.canFloatLeft).toBe(false)
    expect(result.floating).toBe(false)
    expect(result.left).toBe('112.0px')
  })

  it('渲染区未知时不给宽度，交给 .danmaku-list 的 CSS 兜底', () => {
    const result = layout(null)
    expect(result.width).toBeUndefined()
    expect(result.left).toBe('12px')
    expect(result.bottom).toBe('46px')
  })

  it('紧凑档字号上下限更小', () => {
    const mini: DanmakuLayerRect = { left: 0, top: 0, width: 300, height: 200, bottom: 0 }
    expect(layout(mini, 'video', true).fontSize).toBe(10)
  })
})

describe('useDanmakuLayer', () => {
  it('左侧栏模式下互动榜锚点跟气泡层一起去屏幕左上角', () => {
    const layer = useDanmakuLayer({
      videoRect: () => PORTRAIT,
      compact: () => false,
      fullscreen: () => true,
      placement: () => 'left',
    })
    expect(layer.topLeft.value).toEqual({ left: '12px', top: '12px' })
  })

  it('画面内模式下互动榜锚在渲染区左上角', () => {
    const layer = useDanmakuLayer({
      videoRect: () => PORTRAIT,
      compact: () => false,
      fullscreen: () => true,
      placement: () => 'video',
    })
    expect(layer.topLeft.value).toEqual({ left: '668.0px', top: '12.0px' })
  })
})
