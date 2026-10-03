import { describe, expect, it } from 'vitest'
import { formatMediaTime } from '../src/renderer/src/utils/time-format'

describe('formatMediaTime（媒体时长格式化）', () => {
  it('不足 1 小时用 mm:ss', () => {
    expect(formatMediaTime(0)).toBe('00:00')
    expect(formatMediaTime(9)).toBe('00:09')
    expect(formatMediaTime(65)).toBe('01:05')
    expect(formatMediaTime(599)).toBe('09:59')
    expect(formatMediaTime(3599)).toBe('59:59')
  })

  it('满 1 小时进位到 hh:mm:ss（小时也补零）', () => {
    expect(formatMediaTime(3600)).toBe('01:00:00')
    expect(formatMediaTime(3661)).toBe('01:01:01')
    expect(formatMediaTime(36000)).toBe('10:00:00')
  })

  it('秒数向下取整（currentTime 是小数）', () => {
    expect(formatMediaTime(12.9)).toBe('00:12')
    expect(formatMediaTime(59.999)).toBe('00:59')
  })

  it('负数按 0 处理（seek 越界 / 计算误差不显示负号）', () => {
    expect(formatMediaTime(-1)).toBe('00:00')
    expect(formatMediaTime(-90.5)).toBe('00:00')
  })

  it('naN 与 Infinity 按 0 处理（脏时长不得渲染成 Invalid Date）', () => {
    expect(formatMediaTime(Number.NaN)).toBe('00:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('00:00')
    expect(formatMediaTime(Number.NEGATIVE_INFINITY)).toBe('00:00')
  })

  it('专辑总时长场景：90 分钟显示 hh:mm:ss', () => {
    expect(formatMediaTime(5400)).toBe('01:30:00')
  })
})
