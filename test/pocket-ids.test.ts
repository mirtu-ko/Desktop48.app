import { toApiId, toMessageId } from '@common/pocket-ids'
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

describe('pocket-ids / toMessageId', () => {
  it('有效 id 统一成字符串（数值与字符串同形）', () => {
    expect(toMessageId('1234567890123456789')).toBe('1234567890123456789')
    expect(toMessageId(7261234)).toBe('7261234')
    expect(toMessageId(' srv-1 ')).toBe('srv-1')
  })

  it('0 / \'0\' 与缺失一律归一成空串（视为「无 id」，退回时刻比较）', () => {
    expect(toMessageId(0)).toBe('')
    expect(toMessageId('0')).toBe('')
    expect(toMessageId(' 0 ')).toBe('')
    expect(toMessageId('')).toBe('')
    expect(toMessageId(null)).toBe('')
    expect(toMessageId(undefined)).toBe('')
    expect(toMessageId({})).toBe('')
  })

  it('负数不做「有效 id」处理（服务端不会下发，防御性归一）', () => {
    expect(toMessageId(-1)).toBe('')
  })
})
