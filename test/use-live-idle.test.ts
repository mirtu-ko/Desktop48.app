import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

/**
 * useLiveIdle 空态时钟与上次检查同步测试：
 * 覆盖每 30 秒推进「已等待 N 分钟」以及同步共享 store 的 lastFetchedAt。
 */

const { lifecycleHooks, storeMock, apisMock } = vi.hoisted(() => ({
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
    openLives: vi.fn(async () => ({ liveList: [] })),
    playbackList: vi.fn(async () => ({ liveList: [], next: '0' })),
  },
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
    isBlocked: () => false,
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
  apisMock.playbackList.mockClear()
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
})
