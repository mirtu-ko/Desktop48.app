import { describe, expect, it } from 'vitest'
import { mergeFollowedIds } from '../src/common/pocket-rooms'

describe('mergeFollowedIds（口袋关注 ∪ 本地关注 − 屏蔽）', () => {
  it('并集去重，followSourceOf 标注来源；顺序口袋在前', () => {
    const { ids, followSourceOf } = mergeFollowedIds([2, 1], [1, 3], () => false)
    expect(ids).toEqual([2, 1, 3])
    expect(followSourceOf.get(1)).toBe('both')
    expect(followSourceOf.get(2)).toBe('pocket')
    expect(followSourceOf.get(3)).toBe('local')
  })

  it('被屏蔽成员整体剔除（屏蔽优先，与关注正交）', () => {
    const { ids, followSourceOf } = mergeFollowedIds([1, 2], [2, 3], userId => userId === 2)
    expect(ids).toEqual([1, 3])
    expect(followSourceOf.has(2)).toBe(false)
  })

  it('无效 id（NaN / 0 / 负数）过滤', () => {
    const { ids } = mergeFollowedIds([Number.NaN, 0, -1, 5], [Number.POSITIVE_INFINITY], () => false)
    expect(ids).toEqual([5])
  })

  it('空输入得空结果', () => {
    expect(mergeFollowedIds([], [], () => false)).toEqual({ ids: [], followSourceOf: new Map() })
  })
})
