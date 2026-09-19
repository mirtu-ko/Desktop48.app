/**
 * 关注名单的纯函数集合（与 domain/blocked-members.ts 同构）：id 归一化匹配、从成员表解析关注成员。
 * 只做无副作用的计算与过滤（落库留在 Database 类里），可直接单测。
 */
import type { MemberRecord } from './member-tree'

/** 判断 userId 是否在关注名单里（Number 归一化，避免历史字符串 id 与数字 id 判重失败） */
export function isFollowedId(followedIds: Array<number | string> | undefined, userId: number): boolean {
  return (followedIds || []).some(id => Number(id) === Number(userId))
}

/** 向关注名单添加 userId（幂等）。已存在时返回 null 表示无需落库，否则返回新数组（不改动入参） */
export function addFollowedMemberId(
  followedIds: Array<number | string> | undefined,
  userId: number,
): Array<number | string> | null {
  const list = followedIds || []
  if (isFollowedId(list, userId))
    return null
  return [...list, userId]
}

/** 从关注名单里移除 userId，返回新数组（不改动入参）；名单未初始化视为空 */
export function removeFollowedId(
  followedIds: Array<number | string> | undefined,
  userId: number,
): Array<number | string> {
  return (followedIds || []).filter(id => Number(id) !== Number(userId))
}

/** 按关注名单解析成员详情：查不到的 id（已退团等）静默跳过，成员数据未初始化视为无关注 */
export function resolveFollowedMembers(
  followedIds: Array<number | string> | undefined,
  starInfo: MemberRecord[] | undefined,
): MemberRecord[] {
  if (!starInfo)
    return []
  return (followedIds || [])
    .map(id => starInfo.find(m => Number(m.userId) === Number(id)))
    .filter((member): member is MemberRecord => member !== undefined)
}
