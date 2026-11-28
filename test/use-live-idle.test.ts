import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

/**
 * useLiveIdle 空态时钟与上次检查同步测试：
 * 覆盖每 30 秒推进「已等待 N 分钟」以及同步共享 store 的 lastFetchedAt。
 */

const { lifecycleHooks, storeMock, apisMock, blockedIds } = vi.hoisted(() => ({
  lifecycleHooks: {
    mounted: [] as Array<() => void>,
    unmounted: [] as Array<() => void>,
  },
  storeMock: {
    liveItems: null as any,
    lastFetchedAt: null as any,
    refreshLiveStatus: vi.fn(async () => [] as any[]),
    releasePolling: vi.fn(),
  },
  apisMock: {
    openLives: vi.fn(async () => ({ liveList: [] as any[] })),
    playbackList: vi.fn(async () => ({ liveList: [] as any[], next: '0' })),
  },
  blockedIds: new Set<string>(),
}))

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return {
    ...actual,
    onMounted: (fn: () => void) => lifecycleHooks.mounted.push(fn),
    onActivated: () => {},
    onDeactivated: () => {},
    onUnmounted: (fn: () => void) => lifecycleHooks.unmounted.push(fn),
  }
})

vi.mock('@renderer/stores/live-status', () => ({
  useLiveStatusStore: () => ({
    liveItems: storeMock.liveItems,
    lastFetchedAt: storeMock.lastFetchedAt,
    refreshLiveStatus: storeMock.refreshLiveStatus,
    acquireLiveStatusPolling: () => storeMock.releasePolling,
  }),
}))

vi.mock('@renderer/stores/member-flags', () => ({
  useFollowedMembersStore: () => ({
    followedMembers: ref([]),
    ensureFollowedLoaded: async () => {},
    isFollowed: () => false,
  }),
  useBlockedMembersStore: () => ({
    ensureBlockedLoaded: async () => {},
    isBlocked: (userId?: string | number) => blockedIds.has(String(userId ?? '')),
  }),
}))

vi.mock('@renderer/services/apis', () => ({
  default: {
    openLives: apisMock.openLives,
    playbackList: apisMock.playbackList,
  },
}))

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

async function setupIdle(initialEmpty = true) {
  const { useLiveIdle } = await import('../src/renderer/src/composables/use-live-idle')
  const isEmpty = ref(initialEmpty)
  const onLiveFound = vi.fn()
  const scope = effectScope()
  const idle = scope.run(() => useLiveIdle({
    isEmpty: () => isEmpty.value,
    onLiveFound,
  }))!

  for (const fn of lifecycleHooks.mounted.splice(0))
    fn()
  await nextTick()

  return {
    idle,
    isEmpty,
    onLiveFound,
    dispose: () => {
      for (const fn of lifecycleHooks.unmounted.splice(0))
        fn()
      scope.stop()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(2026, 10, 27, 20, 0, 0))
  lifecycleHooks.mounted = []
  lifecycleHooks.unmounted = []
  storeMock.liveItems = ref([])
  storeMock.lastFetchedAt = ref(0)
  storeMock.refreshLiveStatus.mockClear()
  storeMock.releasePolling.mockClear()
  apisMock.openLives.mockClear()
  apisMock.openLives.mockImplementation(async () => ({ liveList: [] }))
  apisMock.playbackList.mockClear()
  blockedIds.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useLiveIdle（空态时钟与上次检查同步）', () => {
  it('空态期间每 30 秒推进 clock，避免无人开播时等待时长冻结', async () => {
    const { idle, dispose } = await setupIdle(true)

    expect(idle.waitedText.value).toBe('刚刚开始等待')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(idle.waitedText.value).toBe('刚刚开始等待')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(idle.waitedText.value).toBe('已等待 1 分钟')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(idle.waitedText.value).toBe('已等待 2 分钟')

    dispose()
  })

  it('共享 store 的 lastFetchedAt 更新时同步刷新「上次检查」时间', async () => {
    const { idle, dispose } = await setupIdle(true)

    expect(idle.lastCheckText.value).toBe('20:00')

    const nextFetched = new Date(2026, 10, 27, 20, 2, 0).getTime()
    vi.setSystemTime(nextFetched)
    storeMock.lastFetchedAt.value = nextFetched
    await nextTick()

    expect(idle.lastCheckText.value).toBe(dayjs(nextFetched).format('HH:mm'))
    expect(idle.waitedText.value).toBe('已等待 2 分钟')

    dispose()
  })

  it('离开空态后暂停 30 秒时钟并释放共享轮询', async () => {
    const { idle, isEmpty, dispose } = await setupIdle(true)

    isEmpty.value = false
    await nextTick()
    expect(storeMock.releasePolling).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(idle.waitedText.value).toBe('刚刚开始等待')

    dispose()
  })

  it('全站仅有被屏蔽成员在播时，不误触发 onLiveFound', async () => {
    blockedIds.add('999')
    const blockedLive = { liveId: 'L-blocked', userInfo: { userId: '999', nickname: '已屏蔽' } }
    storeMock.refreshLiveStatus.mockResolvedValueOnce([blockedLive])

    const { onLiveFound, dispose } = await setupIdle(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onLiveFound).not.toHaveBeenCalled()

    // 共享 store 推送也只含被屏蔽主播 → 依然不唤醒
    storeMock.liveItems.value = [blockedLive]
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(onLiveFound).not.toHaveBeenCalled()

    // 出现未屏蔽成员开播 → 立即唤醒
    storeMock.liveItems.value = [blockedLive, { liveId: 'L-ok', userInfo: { userId: '100', nickname: '正常成员' } }]
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(onLiveFound).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('showsLoaded 在公演排期回包前为 false，完成后置 true 防兜底文案闪现', async () => {
    let releaseShows!: () => void
    apisMock.openLives.mockImplementationOnce(() => new Promise((resolve) => {
      releaseShows = () => resolve({ liveList: [] })
    }))

    const { idle, dispose } = await setupIdle(true)
    expect(idle.showsLoaded.value).toBe(false)

    releaseShows()
    await vi.advanceTimersByTimeAsync(0)
    expect(idle.showsLoaded.value).toBe(true)
    expect(idle.hasShows.value).toBe(false)

    dispose()
  })
})
