import { describe, expect, it } from 'vitest'
import { addMemberFlagId, addMemberFlagIds, hasMemberFlagId, removeMemberFlagId } from '../src/main/domain/member-flags'

/** domain/member-flags：名单 id 的归一化与幂等增删（口袋关注批量合并的地基） */
describe('domain/member-flags', () => {
  describe('addMemberFlagIds（批量合并）', () => {
    it('去重合并且保留既有成员', () => {
      const merged = addMemberFlagIds([1, 2], [2, 3, 4])
      expect(merged).toEqual([1, 2, 3, 4])
    })

    it('字符串数字 id 与数字 id 视为同一人，不重复落库', () => {
      const merged = addMemberFlagIds(['1'], [1, '1', 2])
      expect(merged).toEqual(['1', 2])
    })

    it('全部已存在时返回 null（免写盘）', () => {
      expect(addMemberFlagIds([1, 2], [2, 1])).toBeNull()
    })

    it('名单未初始化视为空数组，空输入不改动', () => {
      expect(addMemberFlagIds(undefined, [])).toBeNull()
      expect(addMemberFlagIds(undefined, [7])).toEqual([7])
    })

    it('不改动入参数组', () => {
      const list = [1]
      addMemberFlagIds(list, [2])
      expect(list).toEqual([1])
    })
  })

  describe('单条操作（既有语义回归）', () => {
    it('hasMemberFlagId 跨数字/字符串判定', () => {
      expect(hasMemberFlagId(['12'], 12)).toBe(true)
      expect(hasMemberFlagId([], 12)).toBe(false)
      expect(hasMemberFlagId(undefined, 12)).toBe(false)
    })

    it('addMemberFlagId 幂等；removeMemberFlagId 归一化移除', () => {
      expect(addMemberFlagId([1], 1)).toBeNull()
      expect(addMemberFlagId([1], 2)).toEqual([1, 2])
      expect(removeMemberFlagId([1, '2', 3], 2)).toEqual([1, 3])
    })
  })
})
