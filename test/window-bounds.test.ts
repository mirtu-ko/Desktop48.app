import { describe, expect, it } from 'vitest'
import { centerWindow, computeWindowBounds, fitWindowToWorkArea, WIDE_SCREEN_MAX_SCALE, WINDOW_EDGE_GAP, WINDOW_MAX_ASPECT, WINDOW_PREFERRED } from '../src/main/window-bounds'

/** 大屏：期望尺寸原样使用，留白不影响 */
const BIG = { width: 1920, height: 1160 }
/** 1280×800 笔记本：菜单栏 25 + Dock 约 70 */
const LAPTOP_1280 = { width: 1280, height: 705 }
/** 1440×900 笔记本：菜单栏 25 + Dock 约 70 */
const LAPTOP_1440 = { width: 1440, height: 805 }

describe('computeWindowBounds', () => {
  it('工作区足够大时原样返回期望尺寸', () => {
    expect(computeWindowBounds(BIG)).toEqual(WINDOW_PREFERRED)
  })

  it('1366×768（任务栏 40）四边各让出留白，宽度再按长宽比收窄', () => {
    expect(computeWindowBounds({ width: 1366, height: 728 })).toEqual({
      width: 1129,
      height: 728 - 2 * WINDOW_EDGE_GAP,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1080p@125%（1536×832）：高度让出留白，宽度按 1.7 收到 1306', () => {
    expect(computeWindowBounds({ width: 1536, height: 832 })).toEqual({
      width: 1306,
      height: 832 - 2 * WINDOW_EDGE_GAP,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1280×800 笔记本窗口收到 1090×641', () => {
    expect(computeWindowBounds(LAPTOP_1280)).toEqual({
      width: 1090,
      height: 641,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1440×900 笔记本窗口收到 1260×741', () => {
    expect(computeWindowBounds(LAPTOP_1440)).toEqual({
      width: 1260,
      height: 741,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1080p@150% 缩放下限不被初始尺寸撑大', () => {
    // 1280×800 的笔记本开 150% 缩放，工作区约 853×533
    const bounds = computeWindowBounds({ width: 853, height: 533 })
    expect(bounds).toEqual({ width: 789, height: 533, minWidth: 720, minHeight: 533 })
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height)
  })

  it('工作区比下限还小时，放弃留白退回工作区尺寸', () => {
    expect(computeWindowBounds({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
      minWidth: 640,
      minHeight: 480,
    })
  })

  it('宽屏按比例放大，1920 及以下不受影响', () => {
    // 阈值 2154（1400 / 0.65）：低于它时比例值不如基准大，窗口与旧版逐像素一致
    expect(computeWindowBounds({ width: 1920, height: 1040 })).toEqual(WINDOW_PREFERRED)
    expect(computeWindowBounds({ width: 1680, height: 1050 })).toEqual(WINDOW_PREFERRED)
    // 2560 宽取 1664，高仍不足 900
    expect(computeWindowBounds({ width: 2560, height: 1040 })).toEqual({
      width: 1664,
      height: 900,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
    expect(computeWindowBounds({ width: 2560, height: 1346 }).width).toBe(1664)
  })

  it('4K@100% 上宽高按同一倍率放大，封顶在基准的 1.3 倍', () => {
    const bounds = computeWindowBounds({ width: 3840, height: 2055 })
    expect(bounds).toEqual({
      width: Math.round(WINDOW_PREFERRED.width * WIDE_SCREEN_MAX_SCALE),
      height: Math.round(WINDOW_PREFERRED.height * WIDE_SCREEN_MAX_SCALE),
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
    // 宽高共用倍率，所以大屏放大不会把窗口拉扁
    expect(Math.round(bounds.width / bounds.height * 100) / 100)
      .toBe(Math.round(WINDOW_PREFERRED.width / WINDOW_PREFERRED.height * 100) / 100)
  })

  it('放大倍率封顶后不再随工作区变宽，但区间内单调', () => {
    const widths = [2154, 2560, 3000, 3840].map(width => computeWindowBounds({ width, height: 2055 }).width)
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
    expect(widths[2]).toBe(widths[3])
  })

  it('高度被工作区压低时，窗口长宽比不超过 1.7', () => {
    for (const area of [LAPTOP_1280, LAPTOP_1440, { width: 1366, height: 728 }, { width: 1536, height: 832 }]) {
      const bounds = computeWindowBounds(area)
      // 宽度按四舍五入取整，个别尺寸会多出不到 0.001
      expect(Math.round(bounds.width / bounds.height * 100) / 100).toBeLessThanOrEqual(WINDOW_MAX_ASPECT)
    }
  })

  it('高度达到基准或宽屏放大时，不按长宽比收窄', () => {
    expect(computeWindowBounds(BIG).width).toBe(WINDOW_PREFERRED.width)
    expect(computeWindowBounds({ width: 1920, height: 1040 }).width).toBe(WINDOW_PREFERRED.width)
    expect(computeWindowBounds({ width: 2560, height: 1346 }).width).toBe(1664)
    expect(computeWindowBounds({ width: 3840, height: 2055 }).width).toBe(Math.round(WINDOW_PREFERRED.width * WIDE_SCREEN_MAX_SCALE))
  })

  it('工作区极矮时宽度仍不低于 minWidth', () => {
    const bounds = computeWindowBounds({ width: 800, height: 400 })
    expect(bounds.width).toBeGreaterThanOrEqual(bounds.minWidth)
  })

  it('任意工作区都满足 下限 ≤ 初始尺寸 ≤ 工作区', () => {
    const areas = [
      BIG,
      { width: 3840, height: 2055 },
      { width: 2560, height: 1346 },
      { width: 1536, height: 832 },
      { width: 1440, height: 805 },
      { width: 1366, height: 728 },
      LAPTOP_1280,
      { width: 1093, height: 589 },
      { width: 853, height: 533 },
      { width: 800, height: 600 },
      { width: 640, height: 480 },
    ]
    for (const area of areas) {
      const bounds = computeWindowBounds(area)
      expect(bounds.width).toBeLessThanOrEqual(area.width)
      expect(bounds.height).toBeLessThanOrEqual(area.height)
      expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width)
      expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height)
    }
  })

  it('自定义期望尺寸同样按工作区与长宽比收敛', () => {
    const bounds = computeWindowBounds({ width: 1200, height: 700 }, {
      width: 1600,
      height: 1000,
      minWidth: 900,
      minHeight: 620,
    })
    expect(bounds).toEqual({ width: 1081, height: 636, minWidth: 900, minHeight: 620 })
  })
})

describe('centerWindow', () => {
  it('在大屏工作区内居中', () => {
    const workArea = { x: 0, y: 25, width: 1920, height: 1160 }
    expect(centerWindow(workArea, WINDOW_PREFERRED)).toEqual({ x: 260, y: 155 })
  })

  it('小屏窗口按收窄后的宽度居中', () => {
    const workArea = { x: 0, y: 25, width: 1280, height: 705 }
    const bounds = computeWindowBounds(workArea)
    expect(centerWindow(workArea, bounds)).toEqual({ x: 95, y: 57 })
  })

  it('副屏坐标是偏移量而不是屏幕绝对零点', () => {
    const workArea = { x: 1920, y: 0, width: 1280, height: 705 }
    const bounds = computeWindowBounds(workArea)
    expect(centerWindow(workArea, bounds)).toEqual({ x: 2015, y: 32 })
  })
})

describe('fitWindowToWorkArea', () => {
  const area = { x: 0, y: 25, width: 1280, height: 705 }

  it('窗口在工作区内时原样保留，不放大也不居中', () => {
    const bounds = { x: 300, y: 100, width: 900, height: 600 }
    expect(fitWindowToWorkArea(bounds, area)).toEqual(bounds)
  })

  it('左边 / 上边越界时推回工作区', () => {
    expect(fitWindowToWorkArea({ x: -100, y: -50, width: 900, height: 600 }, area))
      .toEqual({ x: 0, y: 25, width: 900, height: 600 })
  })

  it('右边 / 下边越界时收回工作区', () => {
    expect(fitWindowToWorkArea({ x: 900, y: 500, width: 900, height: 600 }, area))
      .toEqual({ x: 380, y: 130, width: 900, height: 600 })
  })

  it('窗口比新工作区还大时缩到工作区尺寸', () => {
    expect(fitWindowToWorkArea({ x: 50, y: 20, width: 1400, height: 900 }, { x: 100, y: 50, width: 800, height: 500 }))
      .toEqual({ x: 100, y: 50, width: 800, height: 500 })
  })

  it('副屏坐标不会被归零', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 705 }
    const bounds = { x: 2000, y: 40, width: 900, height: 600 }
    expect(fitWindowToWorkArea(bounds, secondary)).toEqual(bounds)
  })
})
