/**
 * 房间未读镜像（模块级单例，与 stores/tasks.ts 同一模式）。
 *
 * 唯一真相在主进程（main/pocket48/pocket-unread.ts）：主进程 60s 轮询检测，
 * 未读变化经 pocketUnreadBatch 全量广播下来，本 store 只做镜像；
 * markRead 走 invoke 由主进程推进水位后广播回来（本地乐观清零只为避免数字闪现，
 * 广播到达后值一致）。页面没开 / 窗口最小化时未读照常积累，与页面自身轮询无关。
 */
import type { PocketUnreadBatch, PocketUnreadRoomState } from '../../../preload/ipc-contract'
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
 * 标记房间已读（进入房间拉到消息 / 贴底看到新消息时调用）。
 * target 区分大房间 / 小房间（暗号频道）：两个频道各有查看入口，进哪个清哪个，
 * 另一路未读保留（主进程按频道拆分对齐基线）。
 * 只传 userId：主进程清零未读并删回执键，下一轮检测重新锚定到最新消息——
 * 不传渲染层消息 id，因为渲染层 id 与主进程检测键不同空间，混写会导致已读复活。
 */
export async function markRoomRead(userId: number, target: 'room' | 'small' = 'room'): Promise<void> {
  const key = String(userId)
  // 乐观清零：广播稍后到达，值一致
  if (unreadRooms.value[key]) {
    const next = { ...unreadRooms.value }
    delete next[key]
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
