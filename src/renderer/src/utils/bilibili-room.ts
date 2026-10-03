/**
 * 公演团体 → B 站官方直播间映射。
 *
 * 房间号人工确认后写死：B 站直播搜索接口对匿名返回风控 HTML，没有可用的自动发现途径。
 * 填的是真实房间号。只服务公演，个人直播没有对应房间，一律返回 undefined。
 */
import Constants from './constants'

const GROUP_ROOMS: Record<string, number> = {
  SNH48: 63727,
  BEJ48: 383045,
  GNZ48: 391199,
  CKG48: 6015846,
  CGT48: 27848865,
}

/**
 * groupId → 房间号。团体名的合法取值只有 Constants.GroupTabs 一处，故先归一成团体名再查表，
 * 不再单独维护一张 groupId → 房间的映射。
 */
function roomIdOfGroupId(groupId: number): number | undefined {
  const label = Constants.GroupTabs.find(tab => tab.key === String(groupId))?.label
  return label ? GROUP_ROOMS[label] : undefined
}

/**
 * 从公演条目推导 B 站直播间号。团体**只能认 groupId** —— 接口给的 teamName 是「TEAM SII」
 * 这类队伍名、不含团体名，做包含匹配一个都命中不了；teamList 为空时退回标题匹配。
 */
export function resolveBilibiliRoomId(options: {
  /** teamList[0].groupId；缺失或表里查不到房间时只用 texts 兜底 */
  groupId?: number
  /** 标题与副标题，仅在 groupId 不奏效时参与匹配 */
  texts?: Array<string | undefined>
}): number | undefined {
  if (options.groupId !== undefined) {
    const roomId = roomIdOfGroupId(options.groupId)
    if (roomId !== undefined)
      return roomId
  }

  const haystack = (options.texts ?? [])
    .filter((text): text is string => !!text)
    .join(' ')
    .toUpperCase()
  for (const { label } of Constants.GroupTabs) {
    const roomId = GROUP_ROOMS[label]
    if (roomId !== undefined && haystack.includes(label))
      return roomId
  }
  return undefined
}
