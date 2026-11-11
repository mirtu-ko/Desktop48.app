import { describe, expect, it } from 'vitest'
import { formatRelativeDate } from '../src/renderer/src/utils/relative-date'

const NOW = new Date(2026, 10, 11, 15, 30).getTime()
const at = (daysAgo: number, hour = 9): number => new Date(2026, 10, 11 - daysAgo, hour, 5).getTime()

describe('formatRelativeDate（卡片相对日期）', () => {
  it('今天显示时刻', () => {
    expect(formatRelativeDate(at(0), NOW)).toBe('今天 09:05')
  })

  it('昨天与一周内显示自然日差并附带开播时刻', () => {
    expect(formatRelativeDate(at(1), NOW)).toBe('昨天 09:05')
    expect(formatRelativeDate(at(3), NOW)).toBe('3 天前 09:05')
    expect(formatRelativeDate(at(6, 23), NOW)).toBe('6 天前 23:05')
  })

  it('满一周回退绝对日期，跨年补年份（均不带时刻）', () => {
    expect(formatRelativeDate(at(7), NOW)).toBe('11月4日')
    expect(formatRelativeDate(new Date(2025, 11, 20, 9, 5).getTime(), NOW)).toBe('2025年12月20日')
  })

  it('毫秒时间戳串与已格式化的日期串都能解析', () => {
    expect(formatRelativeDate(String(at(2)), NOW)).toBe('2 天前 09:05')
    expect(formatRelativeDate('2026-11-09 09:05:00', NOW)).toBe('2 天前 09:05')
  })

  it('未来时间回退绝对日期', () => {
    expect(formatRelativeDate(new Date(2026, 10, 13, 9, 5).getTime(), NOW)).toBe('2026-11-13')
  })

  it('无效输入返回 null，交给调用方回退原日期串', () => {
    expect(formatRelativeDate('', NOW)).toBeNull()
    expect(formatRelativeDate('not a date', NOW)).toBeNull()
    expect(formatRelativeDate(null, NOW)).toBeNull()
    expect(formatRelativeDate(Number.NaN, NOW)).toBeNull()
  })
})
