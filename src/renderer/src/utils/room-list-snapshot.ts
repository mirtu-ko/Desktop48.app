/**
 * 房间左列快照的纯函数：解析 / 序列化「上一次成功首灌的列表」。
 * 无状态、无 IO（读写在各调用方），可直接单测。
 *
 * 为什么要这份快照：左列任何一行都必须先解析出频道（解析不出 = 成员没有房间 = 不进列表），
 * 于是列表被「关注名单 → 频道解析」按住，冷启动这两段网络串起来一秒起步。
 * 快照让首帧先渲染上次的结论，随后首灌用权威结果整体覆盖：它只负责第一眼，
 * 不参与任何判定（未读 / 关闭态 / 排序仍在各自的地方算）。
 */

/** localStorage 键（带版本后缀：存量格式不兼容时换键即可，不必写迁移） */
export const ROOM_LIST_SNAPSHOT_KEY = 'rooms:list-snapshot:v1'

/** 快照行数上限：关注名单正常几十人，超出视为脏档 */
const MAX_SNAPSHOT_ROOMS = 200

/** 一行 = 左列条目的静态部分；直播 / 未读 / 置顶这类会变的东西一律不落盘 */
export interface RoomSnapshotRow {
  userId: number
  nickname: string
  avatar: string
  teamName: string
  teamColor: string
  followSource?: 'pocket' | 'local' | 'both'
  serverId: string
  channelId: string
  preview: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 单行校验：userId 必须为正数、频道两项必须非空 —— 缺频道的行在左列本来就进不去，
 * 留着只会在下次水合时露出一条点不开的条目。
 */
function toSnapshotRow(value: unknown): RoomSnapshotRow | null {
  if (!isRecord(value))
    return null
  const userId = Number(value.userId)
  const serverId = toText(value.serverId)
  const channelId = toText(value.channelId)
  if (!Number.isFinite(userId) || userId <= 0 || !serverId || !channelId)
    return null
  const followSource = value.followSource === 'pocket' || value.followSource === 'local' || value.followSource === 'both'
    ? value.followSource
    : undefined
  return {
    userId,
    nickname: toText(value.nickname) || `口袋用户 ${userId}`,
    avatar: toText(value.avatar),
    teamName: toText(value.teamName),
    teamColor: toText(value.teamColor),
    followSource,
    serverId,
    channelId,
    preview: toText(value.preview),
  }
}

/**
 * 解析存量快照：ownerId（口袋 userId）不符 / 结构不符 / 脏 JSON 一律整份丢弃。
 * 逐行校验丢掉坏行，重复 userId 只留第一条（同一成员不该出现两次）。
 */
export function parseRoomListSnapshot(raw: string | null | undefined, ownerId: string): RoomSnapshotRow[] {
  if (!raw || !ownerId)
    return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return []
  }
  if (!isRecord(parsed) || parsed.owner !== ownerId || !Array.isArray(parsed.rooms))
    return []
  const seen = new Set<number>()
  const rows: RoomSnapshotRow[] = []
  for (const value of parsed.rooms) {
    const row = toSnapshotRow(value)
    if (!row || seen.has(row.userId))
      continue
    seen.add(row.userId)
    rows.push(row)
    if (rows.length >= MAX_SNAPSHOT_ROOMS)
      break
  }
  return rows
}

/** 序列化：只收有频道的行（临时房间由调用方先剔除，它不属于关注名单） */
export function serializeRoomListSnapshot(ownerId: string, rooms: readonly RoomSnapshotRow[]): string {
  const rows = rooms
    .filter(room => Number.isFinite(room.userId) && room.userId > 0 && !!room.serverId && !!room.channelId)
    .slice(0, MAX_SNAPSHOT_ROOMS)
    .map(room => ({
      userId: room.userId,
      nickname: room.nickname,
      avatar: room.avatar,
      teamName: room.teamName,
      teamColor: room.teamColor,
      followSource: room.followSource,
      serverId: room.serverId,
      channelId: room.channelId,
      preview: room.preview,
    }))
  return JSON.stringify({ owner: ownerId, savedAt: Date.now(), rooms: rows })
}
