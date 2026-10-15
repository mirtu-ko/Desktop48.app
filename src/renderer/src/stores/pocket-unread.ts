/**
 * 房间未读镜像（模块级单例，与 stores/tasks.ts 同一模式）。
 *
 * 唯一真相在主进程（main/pocket48/pocket-unread.ts）：主进程 60s 轮询检测，
 * 未读变化经 pocketUnreadBatch 全量广播下来，本 store 只做镜像；
 * markRead 走 invoke 由主进程推进已读水位后广播回来（本地乐观清零只为避免数字闪现，
 * 广播到达后值一致）。页面没开 / 窗口最小化时未读照常积累，与页面自身轮询无关。
 */
import type { PocketUnreadBatch, PocketUnreadRoomState } from '@preload/ipc-contract'
import { computed, ref } from 'vue'

/** 未读快照镜像：userId（字符串键）→ 单房间状态 */
const unreadRooms = ref<Record<string, PocketUnreadRoomState>>({})

/** 全部房间未读总数（Dock tab「房间」角标用） */
const totalUnread = computed(() =>
  Object.values(unreadRooms.value).reduce((sum, item) => sum + item.count, 0),
)

function applyState(state: PocketUnreadBatch): void {
  unreadRooms.value = state.rooms
}

let installed = false

/** 应用级安装：订阅未读广播并回取一次快照；幂等，每个窗口调用一次 */
export function installPocketUnread(): void {
  if (installed)
    return
  installed = true
  window.mainAPI.pocketUnreadBatch(applyState)
  void window.mainAPI.pocketUnreadState()
    .then(applyState)
    .catch((error) => {
      console.error('[pocket-unread] 未读快照回取失败:', error)
    })
}

/** 某房间的未读数（无未读返回 0）；左列房间条目角标用 */
export function unreadCountOf(userId: number): number {
  return unreadRooms.value[String(userId)]?.count ?? 0
}

/** 某房间大/小房间各自的未读数；频道切换 tab 的点点用 */
export function unreadChannelOf(userId: number): { big: number, small: number } {
  const entry = unreadRooms.value[String(userId)]
  return { big: entry?.bigCount ?? 0, small: entry?.smallCount ?? 0 }
}

/**
 * 标记房间已读（点进房间 / 贴底看到新消息时调用）。
 * target 区分大房间 / 小房间（暗号频道）：两个频道各有查看入口，进哪个清哪个，
 * 另一路未读保留（主进程按频道拆分，把该频道的已读水位推到当下）。
 * 只传 userId：主进程清零该频道未读并把水位对齐到「此刻」，下一轮检测数出的就是
 * 读了之后又来的新消息——不传渲染层消息 id，两侧取数不是同一次分页，混写会让已读复活。
 */
export async function markRoomRead(userId: number, target: 'room' | 'small' = 'room'): Promise<void> {
  const key = String(userId)
  const entry = unreadRooms.value[key]
  // 乐观清零：只清目标频道，另一路（大房间 / 小房间各算一路）保留——
  // 主进程同样按频道拆分对齐，广播稍后到达，值一致
  if (entry) {
    const kept = target === 'small' ? entry.bigCount : entry.smallCount
    const next = { ...unreadRooms.value }
    if (kept > 0) {
      next[key] = {
        ...entry,
        count: kept,
        bigCount: target === 'small' ? kept : 0,
        smallCount: target === 'small' ? 0 : kept,
      }
    }
    else {
      delete next[key]
    }
    unreadRooms.value = next
  }
  try {
    await window.mainAPI.pocketMarkRead(userId, target)
  }
  catch (error) {
    console.error('[pocket-unread] 标记已读失败:', error)
  }
}

/** 未读 store：房间未读的全局镜像与已读标记（模块级单例） */
export function usePocketUnreadStore() {
  return { unreadRooms, totalUnread, unreadCountOf, unreadChannelOf, markRoomRead }
}

export default usePocketUnreadStore
