// 原生 title 替身的定位与静止判定：重点验证边缘翻转与手抖容差。
import { describe, expect, it } from 'vitest'
import { isPointerStill, TITLE_TIP_DELAY, TITLE_TIP_MOVE_TOLERANCE, titleTipPosition } from '../src/renderer/src/utils/native-title'

const viewport = { width: 1280, height: 800 }

describe('native-title.titleTipPosition', () => {
  it('鼠标在中间时落在右下方 12/18 处', () => {
    const point = titleTipPosition({ x: 100, y: 100 }, { width: 120, height: 30 }, viewport)
    expect(point).toEqual({ left: 112, top: 118 })
    expect(point.left).not.toBe(100)
  })

  it('贴近右边缘时翻到鼠标左侧', () => {
    const point = titleTipPosition({ x: 1250, y: 100 }, { width: 120, height: 30 }, viewport)
    expect(point.left).toBe(1250 - 12 - 120)
    expect(point.left).toBeLessThan(1250)
  })

  it('贴近下边缘时翻到鼠标上方', () => {
    const point = titleTipPosition({ x: 100, y: 790 }, { width: 120, height: 30 }, viewport)
    expect(point.top).toBe(790 - 18 - 30)
    expect(point.top).toBeLessThan(790)
  })

  it('右下角同时翻转，且仍留在视口内', () => {
    const point = titleTipPosition({ x: 1270, y: 795 }, { width: 200, height: 60 }, viewport)
    expect(point.left).toBeLessThan(1270)
    expect(point.top).toBeLessThan(795)
    expect(point.left).toBeGreaterThanOrEqual(8)
    expect(point.top).toBeGreaterThanOrEqual(8)
  })

  it('浮层比视口还大时钳到边缘留白，不返回负坐标', () => {
    expect(titleTipPosition({ x: 600, y: 400 }, { width: 2000, height: 900 }, viewport))
      .toEqual({ left: 8, top: 8 })
  })

  it('鼠标贴左上角时不会越出视口', () => {
    const point = titleTipPosition({ x: -20, y: -20 }, { width: 120, height: 30 }, viewport)
    expect(point.left).toBeGreaterThanOrEqual(8)
    expect(point.top).toBeGreaterThanOrEqual(8)
  })
})

describe('native-title.isPointerStill', () => {
  it('完全不动算静止', () => {
    expect(isPointerStill({ x: 50, y: 50 }, { x: 50, y: 50 })).toBe(true)
  })

  it('容差内的手抖不重置计时', () => {
    expect(isPointerStill({ x: 50, y: 50 }, { x: 54, y: 46 })).toBe(true)
    expect(TITLE_TIP_MOVE_TOLERANCE).toBe(4)
  })

  it('任一轴超过容差都算移动（反向验证）', () => {
    expect(isPointerStill({ x: 50, y: 50 }, { x: 55, y: 50 })).toBe(false)
    expect(isPointerStill({ x: 50, y: 50 }, { x: 50, y: 55 })).toBe(false)
  })

  it('自定义容差生效', () => {
    expect(isPointerStill({ x: 0, y: 0 }, { x: 8, y: 0 }, 10)).toBe(true)
    expect(isPointerStill({ x: 0, y: 0 }, { x: 8, y: 0 }, 2)).toBe(false)
  })
})

describe('native-title.TITLE_TIP_DELAY', () => {
  it('延迟与浏览器原生 tooltip 的约 1 秒一致', () => {
    expect(TITLE_TIP_DELAY).toBe(1000)
  })
})
