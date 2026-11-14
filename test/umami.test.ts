import { describe, expect, it } from 'vitest'
import { countBucket, DURATION_BUCKET_FAILED, durationBucket } from '../src/renderer/src/utils/umami'

describe('countBucket（数量只报低基数分桶）', () => {
  it('0 / 负数 / 非有限值单独成桶，不混进 1', () => {
    expect(countBucket(0)).toBe('0')
    expect(countBucket(-3)).toBe('0')
    expect(countBucket(Number.NaN)).toBe('0')
    expect(countBucket(Number.POSITIVE_INFINITY)).toBe('0')
  })

  it('边界值按桶递进，反向验证不会落到相邻桶', () => {
    expect(countBucket(0.5)).toBe('1')
    expect(countBucket(1)).toBe('1')
    expect(countBucket(2)).toBe('2-5')
    expect(countBucket(5)).toBe('2-5')
    expect(countBucket(6)).toBe('6-20')
    expect(countBucket(20)).toBe('6-20')
    expect(countBucket(21)).toBe('20+')
  })
})

describe('durationBucket（时长只报分桶）', () => {
  it('边界值按桶递进，反向验证不会落到相邻桶', () => {
    expect(durationBucket(0)).toBe('<1m')
    expect(durationBucket(59)).toBe('<1m')
    expect(durationBucket(60)).toBe('1-5m')
    expect(durationBucket(299)).toBe('1-5m')
    expect(durationBucket(300)).toBe('5-15m')
    expect(durationBucket(899)).toBe('5-15m')
    expect(durationBucket(900)).toBe('15m+')
  })

  it('从未出画用专用标记，不伪装成 <1m', () => {
    expect(DURATION_BUCKET_FAILED).toBe('failed')
    expect(DURATION_BUCKET_FAILED).not.toBe(durationBucket(0))
  })
})
