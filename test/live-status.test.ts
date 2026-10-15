import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apisMock } = vi.hoisted(() => ({
  apisMock: {
    lives: vi.fn(async (_next: string, _options?: unknown) => ({ next: '0', liveList: [] as any[] })),
  },
}))

vi.mock('@renderer/services/apis', () => ({
  default: {
    lives: (next: string, options?: unknown) => apisMock.lives(next, options),
  },
}))

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

function live(liveId: string, userId: number) {
  return {
    liveId,
    userInfo: { userId, nickname: `成员${userId}` },
  }
}

describe('live-status 共享 store', () => {
  let store: typeof import('@renderer/stores/live-status')

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    apisMock.lives.mockClear()
    apisMock.lives.mockImplementation(async () => ({ next: '0', liveList: [] as any[] }))
    store = await import('@renderer/stores/live-status')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('非强刷在 120 秒新鲜期内复用缓存，过期后重拉', async () => {
    await store.useLiveStatusStore().ensureLiveStatusFresh()
    expect(apisMock.lives).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(119_999)
    await store.useLiveStatusStore().ensureLiveStatusFresh()
    expect(apisMock.lives).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await store.useLiveStatusStore().ensureLiveStatusFresh()
    expect(apisMock.lives).toHaveBeenCalledTimes(2)
  })

  it('force=true 绕过新鲜缓存立即刷新', async () => {
    const api = store.useLiveStatusStore()
    await api.ensureLiveStatusFresh()
    expect(apisMock.lives).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await api.refreshLiveStatus(true)
    expect(apisMock.lives).toHaveBeenCalledTimes(2)
  })

  it('并发刷新共用同一个 in-flight 请求', async () => {
    let resolveLives!: (value: { next: string, liveList: any[] }) => void
    apisMock.lives.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLives = resolve
    }))

    const api = store.useLiveStatusStore()
    const first = api.refreshLiveStatus()
    const second = api.ensureLiveStatusFresh()
    const forced = api.refreshLiveStatus(true)

    resolveLives({ next: '0', liveList: [live('L1', 1)] })
    const items = await Promise.all([first, second, forced])

    expect(apisMock.lives).toHaveBeenCalledTimes(1)
    expect(items.every(value => value[0]?.liveId === 'L1')).toBe(true)
  })

  it('分页拉取直到没有下一页，并按 liveId 去重', async () => {
    apisMock.lives
      .mockImplementationOnce(async () => ({ next: '2', liveList: [live('L1', 1)] }))
      .mockImplementationOnce(async () => ({ next: '0', liveList: [live('L1', 1), live('L2', 2)] }))

    const items = await store.useLiveStatusStore().refreshLiveStatus(true)

    expect(apisMock.lives.mock.calls.map(call => call[0])).toEqual(['0', '2'])
    expect(items.map(item => item.liveId)).toEqual(['L1', 'L2'])
    expect(store.useLiveStatusStore().liveIdSet.value).toEqual(new Set(['L1', 'L2']))
  })

  it('轮询按消费者引用计数启动和停止', async () => {
    const api = store.useLiveStatusStore()
    const release1 = api.acquireLiveStatusPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(apisMock.lives).toHaveBeenCalledTimes(1)

    const release2 = api.acquireLiveStatusPolling()
    release1()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(apisMock.lives).toHaveBeenCalledTimes(2)

    release2()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(apisMock.lives).toHaveBeenCalledTimes(2)
  })
})
