/**
 * 成员大房间频道的渲染层解析缓存（userId → 频道）。两个消费方共用同一份结果，
 * 同一个人不会因「先看详情卡、再进房间页」被打两次 im/server/jump：
 * - 成员详情卡底栏入口的显隐（只有解析出频道才展示入口）；
 * - 房间页的临时房间条目（点入口跳过来后直接取用频道）。
 *
 * 缓存只活在模块作用域、不落盘（与 utils/small-room-unlock.ts 同一取舍）：
 * 频道是账号无关的静态归属，本进程问过一次即可，重启后重新解析。
 *
 * ⚠️ 「不可判定」不等于「没有大房间」：未登录时主进程不查、直接回空频道，
 * 接口故障则抛错——两者都不写缓存，否则登录后入口再也不出现。
 * 因此也不需要在账号变化时作废缓存。
 */
import type { PocketRoomChannel } from '@preload/ipc-contract'
import { pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import Tools from '@renderer/utils/tools'

/** userId → 频道；null = 已确认该成员没有大房间（不可判定不入表） */
const cache = new Map<number, PocketRoomChannel | null>()

/** 在途请求：详情卡连点 / 与房间页同时取用时，同一个人只打一次接口 */
const inflight = new Map<number, Promise<PocketRoomChannel | null>>()

function hasChannel(channel: PocketRoomChannel | null | undefined): channel is PocketRoomChannel {
  return !!channel?.serverId && !!channel?.channelId
}

/**
 * 解析成员的大房间频道；null = 没有大房间，或当前不可判定（未登录 / 接口故障）。
 * 调用方只需按「查不到就不给入口」处理，不必区分这两种情形。
 */
export async function resolveMemberRoomChannel(
  userId: number | string | undefined | null,
): Promise<PocketRoomChannel | null> {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id) || id <= 0)
    return null
  if (cache.has(id))
    return cache.get(id) ?? null
  const pending = inflight.get(id)
  if (pending)
    return pending

  const task = (async (): Promise<PocketRoomChannel | null> => {
    try {
      // 未登录先确认一次：冷启动首帧 pocketAuthState 还是「未登录」初值，
      // 此刻主进程不查直接回空频道，会被误判成「该成员没有大房间」
      if (!pocketAuthState.value.loggedIn)
        await refreshPocketAuthState()
      if (!pocketAuthState.value.loggedIn)
        return null
      const channel = await window.mainAPI.pocketGetRoomChannel(id)
      const resolved = hasChannel(channel) ? channel : null
      cache.set(id, resolved)
      return resolved
    }
    finally {
      inflight.delete(id)
    }
  })()
  // 接口故障不入缓存：下一次打开详情卡自然重试；调用方一律按「查不到」降级。
  // 护栏加在入册的那一份上，并发取用者拿到的是同一个已降级的 Promise
  const guarded = task.catch((): null => null)
  inflight.set(id, guarded)
  return guarded
}

/** 作废全部缓存（换账号 / 手动排查时用；频道本身与账号无关，非必需） */
export function clearRoomChannelCache(): void {
  cache.clear()
}
