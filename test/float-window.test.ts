import { describe, expect, it } from 'vitest'
import { computeInitialWindowSize, fitAspectInBox, FLOAT_BAR_HEIGHT } from '../src/common/float-window'

describe('fitAspectInBox', () => {
  it('宽屏比例受宽度约束时贴满宽度', () => {
    // 16:9 视频放进 800x450：800/1.7778 = 450，恰好铺满
    expect(fitAspectInBox(16 / 9, 800, 450)).toEqual({ w: 800, h: 450 })
  })

  it('竖屏比例受高度约束时贴满高度', () => {
    // 0.5（竖向）放进 800x450：w=800 → h=1600 超出 → h=450, w=225
    expect(fitAspectInBox(0.5, 800, 450)).toEqual({ w: 225, h: 450 })
  })

  it('结果四舍五入到整数像素', () => {
    // 100/1.7778 = 56.25 → 56
    expect(fitAspectInBox(16 / 9, 100, 100)).toEqual({ w: 100, h: 56 })
  })
})

describe('computeInitialWindowSize', () => {
  const HD = { width: 1920, height: 1080 }

  it('横屏视频：受宽度比例约束，占屏宽 45%', () => {
    // maxW = 1920*0.45 = 864；16:9 → 864x486；+36 标题栏
    expect(computeInitialWindowSize(16 / 9, HD)).toEqual({ w: 864, h: 486 + FLOAT_BAR_HEIGHT })
  })

  it('竖屏视频：受高度比例约束，回缩宽度以贴合 70% 高度上限', () => {
    // maxW = 864，但 9:16 下高度会到 1536 > 1080*0.7-36 = 720 → 回缩到 405x720
    expect(computeInitialWindowSize(9 / 16, HD)).toEqual({ w: 405, h: 720 + FLOAT_BAR_HEIGHT })
  })

  it('横屏视频不会被竖屏兜底比例压成窄窗', () => {
    // 回归：兜底 9:16 的宽度是 405，真实 16:9 若只保宽度就会得到 405x264 的小窗
    const portrait = computeInitialWindowSize(9 / 16, HD)
    const landscape = computeInitialWindowSize(16 / 9, HD)
    expect(portrait.w).toBe(405)
    expect(landscape.w).toBe(864)
    expect(landscape.w).toBeGreaterThan(portrait.w * 2)
  })

  it('两个方向各自的比例都不受对方影响', () => {
    // 横屏吃宽度上限，竖屏吃高度上限；同一块屏幕上两者互不干扰
    const small = { width: 1366, height: 768 }
    // 竖屏：高度封顶 502，宽度回缩到 282
    expect(computeInitialWindowSize(9 / 16, small)).toEqual({ w: 282, h: 502 + FLOAT_BAR_HEIGHT })
    // 横屏：宽度 615 未被高度封顶，直接铺满
    expect(computeInitialWindowSize(16 / 9, small)).toEqual({ w: 615, h: 346 + FLOAT_BAR_HEIGHT })
  })

  it('分辨率翻倍时窗口同步翻倍，占屏比保持一致', () => {
    const uhd = computeInitialWindowSize(9 / 16, { width: 3840, height: 2160 })
    expect(uhd.h).toBe(2 * (720 + FLOAT_BAR_HEIGHT))
    // 宽度取整会带来零点几个百分点的偏差，占屏比应当基本重合
    const hdRatio = 405 / HD.width
    const uhdRatio = uhd.w / 3840
    expect(Math.abs(uhdRatio - hdRatio)).toBeLessThan(0.02)
  })

  it('横屏占屏宽比在各分辨率下恒定', () => {
    expect(computeInitialWindowSize(16 / 9, HD).w / HD.width).toBeCloseTo(0.45, 2)
    expect(computeInitialWindowSize(16 / 9, { width: 3840, height: 2160 }).w / 3840).toBeCloseTo(0.45, 2)
  })

  it('小屏不会占掉半个屏幕', () => {
    const small = computeInitialWindowSize(9 / 16, { width: 1366, height: 768 })
    expect(small.h).toBeLessThanOrEqual(Math.round(768 * 0.7))
    expect(small.w).toBeLessThan(small.h)
  })

  it('极小工作区退化为最小尺寸而非负数', () => {
    expect(computeInitialWindowSize(9 / 16, { width: 200, height: 100 })).toEqual({ w: 240, h: 160 })
  })
})
