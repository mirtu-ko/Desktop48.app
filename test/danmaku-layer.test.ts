import type { Ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useDanmakuLayer } from '../src/renderer/src/composables/use-danmaku-layer'

/**
 * 字号锚画面短边（min(width, height)）而非高度：竖屏直播高度≈窗口全高，
 * 按高度算会把字号顶到上限。以下数值即该契约的字面表达，改动算法时这些用例应当失败。
 */
function setup(rect: { left: number, top: number, width: number, height: number, bottom: number } | null, compact = false) {
  const videoRect = ref(rect) as Ref<any>
  const compactRef = ref(compact)
  return useDanmakuLayer({
    videoRect: () => videoRect.value,
    compact: () => compactRef.value,
  })
}

/** 造渲染区矩形：left/top/bottom 由 contain 居中推出，与 useVideoRotation 口径一致 */
function makeRect(width: number, height: number) {
  const left = (1000 - width) / 2
  const top = (800 - height) / 2
  return { left, top, width, height, bottom: top }
}

describe('useDanmakuLayer 字号', () => {
  it('竖屏直播（口袋48，约 9:16）：短边为宽，字号 14px 量级', () => {
    const { fontSize } = setup(makeRect(422, 750))
    expect(fontSize.value).toBe(14)
  })

  it('横屏画面（16:9）：短边为高，字号 17px 量级', () => {
    const { fontSize } = setup(makeRect(890, 500))
    expect(fontSize.value).toBe(17)
  })

  it('超大画面 clamp 到 18px 上限', () => {
    const { fontSize } = setup(makeRect(1920, 1080))
    expect(fontSize.value).toBe(18)
  })

  it('小画面 clamp 到 12px 下限', () => {
    const { fontSize } = setup(makeRect(200, 120))
    expect(fontSize.value).toBe(12)
  })

  it('紧凑浮窗：clamp 区间 10~14px', () => {
    expect(setup(makeRect(300, 500), true).fontSize.value).toBe(10)
    expect(setup(makeRect(890, 500), true).fontSize.value).toBe(14)
  })

  it('渲染区未就绪：字号取下限', () => {
    expect(setup(null).fontSize.value).toBe(12)
  })
})

describe('useDanmakuLayer 定位', () => {
  it('竖屏：left/bottom 锚渲染区，width 与画面同宽（不越黑边）', () => {
    const { position } = setup(makeRect(422, 700))
    // left = (1000-422)/2 + 12，bottom = (800-700)/2 + 12（高于 MIN_BOTTOM，不被抬升）
    expect(position.value).toEqual({
      left: '301.0px',
      bottom: '62.0px',
      width: '422.0px',
    })
  })

  it('bottom 不低于控制条避让下限', () => {
    // 画面贴容器底边时 bottom = 0 + 12，被 MIN_BOTTOM=46 抬升
    const { position } = setup(makeRect(1000, 800))
    expect(position.value.bottom).toBe('46.0px')
  })

  it('渲染区未就绪：left/bottom 走兜底，不注入 width（由 CSS 兜底宽度）', () => {
    const { position } = setup(null)
    expect(position.value).toEqual({ left: '12px', bottom: '46px' })
  })

  it('支持注入额外最大宽度', () => {
    const layer = useDanmakuLayer({
      videoRect: () => makeRect(1000, 800),
      compact: () => false,
      maxWidth: () => '33vw',
    })
    expect(layer.position.value.maxWidth).toBe('33vw')
  })
})
