/**
 * 左列置顶名单（模块级单例）：纯展示顺序偏好，落 localStorage 而非 database.json
 * （与成员页卡片密度同层，不值得为此走 IPC）。
 *
 * 按 userId 记，与是否关注无关：取消关注后条目从列表消失、置顶记录留着，
 * 重新关注或从成员详情卡临时打开时照旧置顶。
 */
import { parsePinnedIds, ROOM_PIN_STORAGE_KEY, togglePinnedId } from '@renderer/utils/room-pin'
import Tools from '@renderer/utils/tools'
import { computed, ref } from 'vue'

/** 读存量：环境没有 localStorage（纯 Node 测试）或存量脏了，都按空名单起步，不影响列表本身 */
function readPinnedIds(): number[] {
  try {
    return parsePinnedIds(globalThis.localStorage?.getItem(ROOM_PIN_STORAGE_KEY) ?? null)
  }
  catch {
    return []
  }
}

const pinnedIds = ref<number[]>(readPinnedIds())
/** 判定用的集合：排序时每条都要问一次，顺手把「读依赖」收敛到一处 */
const pinnedIdSet = computed(() => new Set(pinnedIds.value))

function persistPinnedIds(): void {
  try {
    globalThis.localStorage?.setItem(ROOM_PIN_STORAGE_KEY, JSON.stringify(pinnedIds.value))
  }
  catch {
    // 写不进去（配额 / 隐私模式）只丢持久化：本次会话内仍然生效
  }
}

/** 该成员是否置顶（在 computed 里调用可建立响应依赖） */
export function isRoomPinned(userId: number | string | undefined | null): boolean {
  const id = Tools.normalizeUserId(userId)
  return Number.isFinite(id) && pinnedIdSet.value.has(id)
}

/** 切换置顶，返回切换后的状态 */
export function toggleRoomPin(userId: number | string): boolean {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id))
    return false
  pinnedIds.value = togglePinnedId(pinnedIds.value, id)
  persistPinnedIds()
  return pinnedIds.value.includes(id)
}

export function useRoomPinsStore() {
  return { pinnedIds, isRoomPinned, toggleRoomPin }
}
