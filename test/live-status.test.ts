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

  it('removeLive 同步摘掉缓存条目，派生集合随之更新，新鲜期内也不会复活', async () => {
    apisMock.lives.mockImplementationOnce(async () => ({ next: '0', liveList: [live('L1', 1), live('L2', 2)] }))
    const api = store.useLiveStatusStore()
    await api.refreshLiveStatus(true)

    api.removeLive('L1')

    expect(api.liveItems.value.map(item => item.liveId)).toEqual(['L2'])
    expect(api.liveByUserId.value.has(1)).toBe(false)
    expect(api.liveIdSet.value).toEqual(new Set(['L2']))
    // 空态轮询在新鲜期内读缓存，不能再拿到已下架的那一场
    expect((await api.ensureLiveStatusFresh()).map(item => item.liveId)).toEqual(['L2'])

    // 即使服务端列表仍短暂带着已下架直播，强刷结果也要继续过滤
    apisMock.lives.mockImplementationOnce(async () => ({ next: '0', liveList: [live('L1', 1), live('L2', 2)] }))
    expect((await api.refreshLiveStatus(true)).map(item => item.liveId)).toEqual(['L2'])
  })

  it('removeLive 发生在刷新在途时，回包不会把已下架直播带回来', async () => {
    let resolveLives!: (value: { next: string, liveList: any[] }) => void
    apisMock.lives.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLives = resolve
    }))

    const api = store.useLiveStatusStore()
    const pending = api.refreshLiveStatus(true)
    // 广播在请求飞行途中到达：回包落地时要按最新的 removedLiveIds 过滤
    api.removeLive('L1')

    resolveLives({ next: '0', liveList: [live('L1', 1), live('L2', 2)] })
    expect((await pending).map(item => item.liveId)).toEqual(['L2'])
    expect(api.liveItems.value.map(item => item.liveId)).toEqual(['L2'])
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

  it('后台静默刷新在途失败时，前台非静默手动刷新自动补拉一次以给出错误提示', async () => {
    let rejectSilent!: (err: Error) => void
    apisMock.lives
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectSilent = reject
      }))
      .mockImplementationOnce(async () => ({ next: '0', liveList: [live('L1', 1)] }))

    const api = store.useLiveStatusStore()
    const silentReq = api.refreshLiveStatus(true, { silent: true })
    const foregroundReq = api.refreshLiveStatus(true, { silent: false })

    rejectSilent(new Error('network error'))
    await expect(silentReq).rejects.toThrow('network error')
    await expect(foregroundReq).resolves.toMatchObject([{ liveId: 'L1' }])
    expect(apisMock.lives).toHaveBeenCalledTimes(2)
    expect(apisMock.lives.mock.calls[0][1]).toEqual({ silent: true })
    expect(apisMock.lives.mock.calls[1][1]).toEqual({ silent: false })
  })
})
