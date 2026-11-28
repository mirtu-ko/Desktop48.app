import type { PocketRoomViewMode } from '@renderer/composables/use-pocket-rooms'
import type { Ref } from 'vue'
import { shouldAutoMarkSeen } from '@renderer/utils/room-unread'
import { watch } from 'vue'

interface UnreadSeenGuardOptions {
  /** 当前房间、当前频道的角标未读（store 镜像） */
  unread: Ref<number>
  selectedUserId: Ref<number | null>
  viewMode: Ref<PocketRoomViewMode>
  atBottom: Ref<boolean>
  /** 页面处于激活态（KeepAlive 可见）且应用窗口可见 */
  pageVisible: Ref<boolean>
  hasMessages: Ref<boolean>
  /** 进房 / 切频道收尾在途：这期间不补标，分割线还要截旧水位 */
  entryBusy: () => boolean
  markRead: (userId: number, target: PocketRoomViewMode) => void
}

/**
 * 贴底自愈：把「已经看过、却被检测轮又数成未读」的角标补标掉。
 *
 * 贴底标记（进房 / 回底 / 收到新消息）与主进程 60s 检测轮有竞态：标记时主进程还没
 * 探测到新消息，count 为 0，`markRead` 只清零、不推进已读水位；检测轮随后把它数出来，
 * 角标就挂在已读的消息上，直到下一次标记（再发一条 / 重进房间）。
 * 这里在角标回来时再标一次——此时 count>0，主进程会清零并把水位推到最新。
 * 生效条件见 `shouldAutoMarkSeen`：贴底、窗口可见、有消息、不在收尾。
 */
export function useUnreadSeenGuard(options: UnreadSeenGuardOptions): void {
  watch(options.unread, (count) => {
    const seen = shouldAutoMarkSeen({
      unread: count,
      atBottom: options.atBottom.value,
      pageVisible: options.pageVisible.value,
      hasMessages: options.hasMessages.value,
      entryBusy: options.entryBusy(),
    })
    const userId = options.selectedUserId.value
    if (!seen || userId === null)
      return
    options.markRead(userId, options.viewMode.value)
  })
}
