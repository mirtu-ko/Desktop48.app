/**
 * 房间（口袋成员留言频道）的共用定义：常量、类型与纯函数，主进程与渲染层同源。
 * 目的是让「取数口径」与「显示口径」同源，不各自写一份：
 * - ROOM_MESSAGE_LIMIT：主进程按此条数拉取并计数，渲染层角标按同一条数收敛；
 * - OFFICIAL_POCKET_USER_ID：两边剔除同一批官方系统账号发言；
 * - mergeFollowedIds / PocketRoomFollowSource：关注名单并集与来源在两边同口径。
 */

/** 房间消息单次拉取条数：一屏量，翻历史用 nextTime 游标；也是未读计数的上限 */
export const ROOM_MESSAGE_LIMIT = 50

/**
 * 口袋官方系统账号：homeowner（只看房主）接口会混入其发言，渲染层在成员视图里
 * 剔除它，主进程计数同样不把它算成成员的房间新消息（否则角标会多出看不见的未读）。
 */
export const OFFICIAL_POCKET_USER_ID = '121569667'

/** 关注来源：pocket = 来自口袋账号（拉取同步），local = 仅本地添加，both = 两边都有 */
export type PocketRoomFollowSource = 'pocket' | 'local' | 'both'

/**
 * 关注名单唯一口径（主进程未读检测与渲染层房间页共用）：
 * 口袋关注 ∪ 本地关注，去重后剔除屏蔽（屏蔽与关注正交，屏蔽优先）。
 * 无效 id（NaN / 非正数）一并过滤。isBlocked 由调用方注入：
 * 主进程传屏蔽 Set 的 has，渲染层传 store 的 isBlocked（各自负责先加载名单）。
 */
export function mergeFollowedIds(
  pocketIds: number[],
  localIds: number[],
  isBlocked: (userId: number) => boolean,
): { ids: number[], followSourceOf: Map<number, PocketRoomFollowSource> } {
  const pocketIdSet = new Set<number>()
  for (const id of pocketIds) {
    const userId = Number(id)
    if (Number.isFinite(userId) && userId > 0)
      pocketIdSet.add(userId)
  }
  const localIdSet = new Set<number>()
  for (const id of localIds) {
    const userId = Number(id)
    if (Number.isFinite(userId) && userId > 0)
      localIdSet.add(userId)
  }
  const ids = new Set<number>()
  const followSourceOf = new Map<number, PocketRoomFollowSource>()
  for (const userId of [...pocketIdSet, ...localIdSet]) {
    if (isBlocked(userId))
      continue
    ids.add(userId)
    const inPocket = pocketIdSet.has(userId)
    const inLocal = localIdSet.has(userId)
    followSourceOf.set(userId, inPocket && inLocal ? 'both' : inPocket ? 'pocket' : 'local')
  }
  return { ids: [...ids], followSourceOf }
}
