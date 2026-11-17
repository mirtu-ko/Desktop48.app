/**
 * 左列置顶名单的纯函数：解析存量 JSON、幂等切换。
 * 存储与响应式包装在 stores/room-pins.ts；本模块无状态、无 IO，可直接单测。
 */

/** localStorage 键（带版本后缀：存量格式不兼容时换键即可，不必写迁移） */
export const ROOM_PIN_STORAGE_KEY = 'rooms:pinned-ids:v1'

/**
 * 解析存量置顶 id：非数组 / 解析失败一律按空名单，
 * 数组里非有限数字丢弃、重复 id 只留一份（脏值不能把整条排序带崩）。
 * 只认正数：`null` / 空串经 Number() 会变 0，落进名单就是一条永远匹配不上的幽灵记录。
 */
export function parsePinnedIds(raw: string | null | undefined): number[] {
  if (!raw)
    return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed))
    return []
  const ids: number[] = []
  for (const value of parsed) {
    const id = Number(value)
    if (Number.isFinite(id) && id > 0 && !ids.includes(id))
      ids.push(id)
  }
  return ids
}

/** 幂等切换：返回新数组，不改动入参；非法 id 原样返回 */
export function togglePinnedId(ids: readonly number[], userId: number): number[] {
  const id = Number(userId)
  if (!Number.isFinite(id))
    return [...ids]
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]
}
