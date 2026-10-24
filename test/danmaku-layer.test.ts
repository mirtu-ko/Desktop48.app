import type { Ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useDanmakuLayer } from '../src/renderer/src/composables/use-danmaku-layer'

/**
 * 字号锚画面短边（min(width, height)）而非高度：竖屏直播高度≈窗口全高，
 * 按高度算会把字号顶到上限。以下数值即该契约的字面表达，改动算法时这些用例应当失败。
 */
function setup(
  rect: { left: number, top: number, width: number, height: number, bottom: number } | null,
  compact = false,
  fullscreen = true,
) {
  const videoRect = ref(rect) as Ref<any>
  const compactRef = ref(compact)
  const fullscreenRef = ref(fullscreen)
  return useDanmakuLayer({
    videoRect: () => videoRect.value,
    compact: () => compactRef.value,
    fullscreen: () => fullscreenRef.value,
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

  it('同一横屏画面非全屏时封顶 15px，全屏恢复 17px', () => {
    expect(setup(makeRect(890, 500), false, false).fontSize.value).toBe(14)
    expect(setup(makeRect(890, 500), false, true).fontSize.value).toBe(17)
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
  it('竖屏：横向锚渲染区（左右各内缩），纵向贴窗口底', () => {
    const { position } = setup(makeRect(422, 700))
    // left = (1000-422)/2 + 10；width 让出左右各 10px；bottom 恒为控制条避让量
    expect(position.value).toEqual({
      left: '299.0px',
      bottom: '46px',
      width: '402.0px',
    })
  })

  it('画面上下有黑边（顶底各 50px）也不抬高底边', () => {
    // 同一画面贴满容器时底边不变：渲染区的 top / bottom 不参与纵向定位
    expect(setup(makeRect(422, 700)).position.value.bottom).toBe('46px')
    expect(setup(makeRect(1000, 800)).position.value.bottom).toBe('46px')
  })

  it('渲染区未就绪：left/bottom 走兜底，不注入 width（由 CSS 兜底宽度）', () => {
    const { position } = setup(null)
    expect(position.value).toEqual({ left: '10px', bottom: '46px' })
  })

  it('支持注入额外最大宽度', () => {
    const layer = useDanmakuLayer({
      videoRect: () => makeRect(1000, 800),
      compact: () => false,
      fullscreen: () => true,
      maxWidth: () => '33vw',
    })
    expect(layer.position.value.maxWidth).toBe('33vw')
  })
})
