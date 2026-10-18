import { toApiId } from '@common/pocket-ids'
import { describe, expect, it } from 'vitest'

describe('pocket-ids / toApiId', () => {
  it('安全整数范围的纯数字 ID 保持 number 形状（既有请求体不变）', () => {
    expect(toApiId('7261234')).toBe(7261234)
    expect(toApiId('0')).toBe(0)
    expect(toApiId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('超出安全整数范围的 ID 原样保留字符串，避免精度丢失', () => {
    const snowflake = '1234567890123456789'
    expect(toApiId(snowflake)).toBe(snowflake)
  })

  it('非纯数字原样返回，不把空串 / 负号 / 小数转成数字', () => {
    expect(toApiId('')).toBe('')
    expect(toApiId('-1')).toBe('-1')
    expect(toApiId('1.5')).toBe('1.5')
    expect(toApiId('abc')).toBe('abc')
  })
})
