/**
 * 屏蔽 / 关注名单的通用纯函数：id 归一化、幂等增删、按名单解析成员。
 *
 * 两类名单只存在语义与持久化字段上的差异，计算规则完全一致。
 * 变更落库留在 Database 类；本模块无状态、无 IO，可直接单测。
 */
import type { MemberRecord } from './member-tree'

/** 判断 userId 是否已在名单（Number 归一化，兼容历史字符串 id） */
export function hasMemberFlagId(
  memberIds: Array<number | string> | undefined,
  userId: number,
): boolean {
  return (memberIds || []).some(id => Number(id) === Number(userId))
}

/** 幂等添加；已存在返回 null 表示无需落库，否则返回新数组（不改动入参） */
export function addMemberFlagId(
  memberIds: Array<number | string> | undefined,
  userId: number,
): Array<number | string> | null {
  const list = memberIds || []
  if (hasMemberFlagId(list, userId))
    return null
  return [...list, userId]
}

/** 返回移除后的数组（不改动入参）；名单未初始化视为空 */
export function removeMemberFlagId(
  memberIds: Array<number | string> | undefined,
  userId: number,
): Array<number | string> {
  return (memberIds || []).filter(id => Number(id) !== Number(userId))
}

/** 按名单解析成员详情；查不到的 id（已退团等）与空成员表都返回空数组 */
export function resolveMemberFlags<T extends MemberRecord>(
  memberIds: Array<number | string> | undefined,
  starInfo: T[] | undefined,
): T[] {
  if (!starInfo)
    return []
  return (memberIds || [])
    .map(id => starInfo.find(member => Number(member.userId) === Number(id)))
    .filter((member): member is T => member !== undefined)
}
