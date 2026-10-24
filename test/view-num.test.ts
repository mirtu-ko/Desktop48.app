import { describe, expect, it } from 'vitest'
import { formatViewNum } from '../src/renderer/src/utils/view-num'

describe('formatViewNum', () => {
  it('小于 1 万原样输出', () => {
    expect(formatViewNum(1)).toBe('1')
    expect(formatViewNum(159)).toBe('159')
    expect(formatViewNum(9999)).toBe('9999')
  })

  it('大于等于 1 万归一为 X.YW', () => {
    expect(formatViewNum(10000)).toBe('1W')
    expect(formatViewNum(12345)).toBe('1.2W')
    expect(formatViewNum(100000)).toBe('10W')
    expect(formatViewNum(123456)).toBe('12.3W')
  })

  it('非正数与非有限数归零', () => {
    expect(formatViewNum(0)).toBe('0')
    expect(formatViewNum(-5)).toBe('0')
    expect(formatViewNum(Number.NaN)).toBe('0')
    expect(formatViewNum(Number.POSITIVE_INFINITY)).toBe('0')
  })
})
