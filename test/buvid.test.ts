import { describe, expect, it } from 'vitest'
import { createFallbackBuvid, pickBuvid } from '../src/main/bilibili/buvid'

describe('pickBuvid', () => {
  it('取 data.b_3，而不是 b_4', () => {
    expect(pickBuvid({ code: 0, data: { b_3: 'ABC-123infoc', b_4: 'DEF-456' } })).toBe('ABC-123infoc')
  })

  it('b_3 缺失 / 空串 / 非字符串一律返回 null，交给调用方回落', () => {
    // 反向验证：把 b_3 读成 b_4、或空串也照收，这三条就会转红
    expect(pickBuvid({ code: 0, data: { b_4: 'DEF-456' } })).toBeNull()
    expect(pickBuvid({ code: 0, data: { b_3: '' } })).toBeNull()
    expect(pickBuvid({ code: 0, data: { b_3: 42 } })).toBeNull()
  })

  it('响应结构异常不抛', () => {
    expect(pickBuvid(null)).toBeNull()
    expect(pickBuvid('nope')).toBeNull()
    expect(pickBuvid({})).toBeNull()
  })
})

describe('createFallbackBuvid', () => {
  it('非空且形如 buvid3，不会被服务端当成「留空」', () => {
    const buvid = createFallbackBuvid()

    expect(buvid).not.toBe('')
    expect(buvid).toMatch(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/)
  })

  it('每次不同，多个房间不共用同一标识', () => {
    expect(createFallbackBuvid()).not.toBe(createFallbackBuvid())
  })
})
