import type { PocketRoomViewMode } from '../src/renderer/src/composables/use-pocket-rooms'
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useUnreadSeenGuard } from '../src/renderer/src/composables/use-unread-seen'

/**
 * 贴底自愈的连线：镜像里当前房间当前频道冒出未读 → 再标一次已读。
 * 用例直接驱动 ref 与门控开关，不挂组件（等价于 Rooms.vue 里的接线方式）。
 */
function setup(initial?: { userId?: number | null, viewMode?: PocketRoomViewMode }) {
  const unread = ref(0)
  const selectedUserId = ref<number | null>(initial?.userId === undefined ? 10001 : initial.userId)
  const viewMode = ref<PocketRoomViewMode>(initial?.viewMode ?? 'room')
  const atBottom = ref(true)
  const pageVisible = ref(true)
  const hasMessages = ref(true)
  let entryBusy = false
  const markRead = vi.fn()
  useUnreadSeenGuard({
    unread,
    selectedUserId,
    viewMode,
    atBottom,
    pageVisible,
    hasMessages,
    entryBusy: () => entryBusy,
    markRead,
  })
  return {
    unread,
    selectedUserId,
    viewMode,
    atBottom,
    pageVisible,
    hasMessages,
    markRead,
    setEntryBusy: (value: boolean) => { entryBusy = value },
  }
}

describe('useUnreadSeenGuard', () => {
  it('角标冒出未读且贴底可见时，按当前房间与频道补标已读', async () => {
    const guard = setup()
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).toHaveBeenCalledTimes(1)
    expect(guard.markRead).toHaveBeenCalledWith(10001, 'room')
  })

  it('小房间视图补标小房间频道', async () => {
    const guard = setup({ viewMode: 'small' })
    guard.unread.value = 2
    await nextTick()
    expect(guard.markRead).toHaveBeenCalledWith(10001, 'small')
  })

  it('上翻浏览中不补标：角标对应的是还没看到的消息', async () => {
    const guard = setup()
    guard.atBottom.value = false
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).not.toHaveBeenCalled()
  })

  it('窗口隐藏不补标', async () => {
    const guard = setup()
    guard.pageVisible.value = false
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).not.toHaveBeenCalled()
  })

  it('进房 / 切频道收尾在途不补标', async () => {
    const guard = setup()
    guard.setEntryBusy(true)
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).not.toHaveBeenCalled()
    // 收尾结束后角标再变才补标
    guard.setEntryBusy(false)
    guard.unread.value = 2
    await nextTick()
    expect(guard.markRead).toHaveBeenCalledTimes(1)
  })

  it('首屏没有消息不补标', async () => {
    const guard = setup()
    guard.hasMessages.value = false
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).not.toHaveBeenCalled()
  })

  it('没有选中房间不补标', async () => {
    const guard = setup({ userId: null })
    guard.unread.value = 1
    await nextTick()
    expect(guard.markRead).not.toHaveBeenCalled()
  })

  it('未读清零（自己标记或广播）不触发补标，不会来回打', async () => {
    const guard = setup()
    guard.unread.value = 1
    await nextTick()
    guard.unread.value = 0
    await nextTick()
    expect(guard.markRead).toHaveBeenCalledTimes(1)
  })
})
