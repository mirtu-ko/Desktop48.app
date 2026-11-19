import { describe, expect, it } from 'vitest'
import { centerWindow, computeWindowBounds, WINDOW_EDGE_GAP, WINDOW_PREFERRED } from '../src/main/window-bounds'

/** 大屏：期望尺寸原样使用，留白不影响 */
const BIG = { width: 1920, height: 1160 }
/** 1280×800 笔记本：菜单栏 25 + Dock 约 70 */
const LAPTOP_1280 = { width: 1280, height: 705 }

describe('computeWindowBounds', () => {
  it('工作区足够大时原样返回期望尺寸', () => {
    expect(computeWindowBounds(BIG)).toEqual(WINDOW_PREFERRED)
  })

  it('1366×768（任务栏 40）四边各让出留白', () => {
    expect(computeWindowBounds({ width: 1366, height: 728 })).toEqual({
      width: 1366 - 2 * WINDOW_EDGE_GAP,
      height: 728 - 2 * WINDOW_EDGE_GAP,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1080p@125%（1536×832）：宽度保住期望值，高度让出留白', () => {
    // 回归重点：不留边时这个尺寸会出现「上下贴边、左右留空」的半裁窗口
    expect(computeWindowBounds({ width: 1536, height: 832 })).toEqual({
      width: WINDOW_PREFERRED.width,
      height: 832 - 2 * WINDOW_EDGE_GAP,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1280×800 笔记本不再占满屏幕', () => {
    expect(computeWindowBounds(LAPTOP_1280)).toEqual({
      width: 1216,
      height: 641,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('1080p@150% 缩放下限不被初始尺寸撑大', () => {
    // 1280×800 的笔记本开 150% 缩放，工作区约 853×533
    const bounds = computeWindowBounds({ width: 853, height: 533 })
    expect(bounds).toEqual({ width: 789, height: 533, minWidth: 720, minHeight: 533 })
    // 回归重点：minHeight 若停留在 560，Electron 会把 533 的初始高度抻回 560，窗口又比屏幕高
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
    // 阈值 1944（1400 / 0.65）：低于它时比例值不如基准大，窗口与旧版逐像素一致
    expect(computeWindowBounds({ width: 1920, height: 1040 })).toEqual(WINDOW_PREFERRED)
    expect(computeWindowBounds({ width: 1680, height: 1050 })).toEqual(WINDOW_PREFERRED)
    // 2560×1080 / 2560×1440：宽取 2560×0.65=1664；高 676 / 875 都不足 900，仍是 900
    expect(computeWindowBounds({ width: 2560, height: 1040 })).toEqual({
      width: 1664,
      height: 900,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
    expect(computeWindowBounds({ width: 2560, height: 1346 }).width).toBe(1664)
  })

  it('4K@100% 上宽高一起放大', () => {
    expect(computeWindowBounds({ width: 3840, height: 2055 })).toEqual({
      width: 2496,
      height: 1336,
      minWidth: WINDOW_PREFERRED.minWidth,
      minHeight: WINDOW_PREFERRED.minHeight,
    })
  })

  it('任意工作区都满足 下限 ≤ 初始尺寸 ≤ 工作区', () => {
    const areas = [
      BIG,
      { width: 3840, height: 2055 },
      { width: 2560, height: 1346 },
      { width: 1536, height: 832 },
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

  it('自定义期望尺寸同样按工作区收敛', () => {
    const bounds = computeWindowBounds({ width: 1200, height: 700 }, {
      width: 1600,
      height: 1000,
      minWidth: 900,
      minHeight: 620,
    })
    expect(bounds).toEqual({ width: 1136, height: 636, minWidth: 900, minHeight: 620 })
  })
})

describe('centerWindow', () => {
  it('在大屏工作区内居中', () => {
    const workArea = { x: 0, y: 25, width: 1920, height: 1160 }
    expect(centerWindow(workArea, WINDOW_PREFERRED)).toEqual({ x: 260, y: 155 })
  })

  it('留白相等时坐标正好等于留白值', () => {
    const workArea = { x: 0, y: 25, width: 1280, height: 705 }
    const bounds = computeWindowBounds(workArea)
    expect(centerWindow(workArea, bounds)).toEqual({ x: 32, y: 57 })
  })

  it('副屏坐标是偏移量而不是屏幕绝对零点', () => {
    const workArea = { x: 1920, y: 0, width: 1280, height: 705 }
    const bounds = computeWindowBounds(workArea)
    expect(centerWindow(workArea, bounds)).toEqual({ x: 1952, y: 32 })
  })
})
