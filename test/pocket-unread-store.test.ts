import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * stores/pocket-unread 的乐观清零：markRoomRead 只清目标频道，
 * 另一路（大房间 / 小房间各算一路）未读在广播到达前不得被一起抹掉。
 * store 是模块级单例：每个用例 resetModules 后重新 import，拿到干净状态。
 */

interface RoomState {
  count: number
  bigCount: number
  smallCount: number
  latestTime: number
}

/** 主进程广播的全量快照（pocketUnreadBatch 的载荷） */
interface BatchState {
  rooms: Record<string, RoomState>
  total: number
  closedChannels?: Array<{ serverId: string, channelId: string }>
  previews?: Array<{ channelId: string, starName: string, msgContent: string, msgTime: number, unreadCount: number | null }>
}

/** 假主进程：未读快照回取一次 + 记录 markRead 调用 + 留住广播订阅回调（按生产链路推广播用） */
async function setup(
  rooms: Record<string, RoomState>,
  closedChannels?: Array<{ serverId: string, channelId: string }>,
  previews?: BatchState['previews'],
) {
  vi.resetModules()
  const calls: Array<[number, string]> = []
  // 生产链路的订阅方式：preload 的 pocketUnreadBatch 把回调转给 ipcRenderer.on，
  // 主进程每次广播都调它。这里留住回调，由用例按同样的方式推一次快照。
  let onBatch: ((state: BatchState) => void) | null = null
  vi.stubGlobal('window', {
    mainAPI: {
      pocketUnreadBatch: vi.fn((callback: (state: BatchState) => void) => {
        onBatch = callback
      }),
      pocketUnreadState: vi.fn(async () => ({
        rooms,
        total: 0,
        ...(closedChannels ? { closedChannels } : {}),
        ...(previews ? { previews } : {}),
      })),
      // markRead 原样带回清零前的水位（分割线锚点），这里给固定值供断言
      pocketMarkRead: vi.fn(async (userId: number, target: string) => {
        calls.push([userId, target])
        return { msgTime: 1000, msgIdServer: 'm1' }
      }),
    },
  })
  const store = await import('../src/renderer/src/stores/pocket-unread')
  store.installPocketUnread()
  // 快照回取是异步的，等它落到镜像里再断言
  await vi.waitFor(() => expect(store.unreadCountOf(1)).toBe(5))
  /** 模拟主进程广播：必须经订阅回调（未订阅即用例写错了） */
  const broadcast = (state: BatchState) => {
    if (!onBatch)
      throw new Error('未读广播未订阅（installPocketUnread 未注册回调）')
    onBatch(state)
  }
  return { store, calls, broadcast }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pocket-unread store（未读镜像与已读标记）', () => {
  it('清大房间未读：小房间那一路在广播到达前保持可见', async () => {
    const { store, calls } = await setup({
      1: { count: 5, bigCount: 3, smallCount: 2, latestTime: 100 },
    })

    await store.markRoomRead(1, 'room')

    expect(store.unreadChannelOf(1)).toEqual({ big: 0, small: 2 })
    expect(store.unreadCountOf(1)).toBe(2)
    expect(calls).toEqual([[1, 'room']])
  })

  it('清小房间未读：大房间那一路保留；target 缺省为大房间', async () => {
    const { store, calls } = await setup({
      1: { count: 5, bigCount: 3, smallCount: 2, latestTime: 100 },
    })

    await store.markRoomRead(1, 'small')
    expect(store.unreadChannelOf(1)).toEqual({ big: 3, small: 0 })

    // 缺省 target：清大房间（与「点进房间即清大房间」的入口一致）
    await store.markRoomRead(1)
    expect(store.unreadChannelOf(1)).toEqual({ big: 0, small: 0 })
    expect(store.unreadCountOf(1)).toBe(0)
    expect(calls).toEqual([[1, 'small'], [1, 'room']])
  })

  it('无未读的房间调用不清出错：镜像不变，仍照常上报主进程', async () => {
    const { store, calls } = await setup({
      1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 },
    })

    await store.markRoomRead(2, 'room')

    expect(store.unreadCountOf(1)).toBe(5)
    expect(calls).toEqual([[2, 'room']])
  })

  it('markRoomRead 原样带回主进程返回的清零前水位（分割线锚点）', async () => {
    const { store } = await setup({
      1: { count: 5, bigCount: 3, smallCount: 2, latestTime: 100 },
    })

    await expect(store.markRoomRead(1, 'room')).resolves.toEqual({ msgTime: 1000, msgIdServer: 'm1' })
  })

  it('latestUnreadTimeOf 透传快照里的最新未读时刻，无未读的房间回 0', async () => {
    const { store } = await setup({
      1: { count: 5, bigCount: 3, smallCount: 2, latestTime: 100 },
    })

    expect(store.latestUnreadTimeOf(1)).toBe(100)
    expect(store.latestUnreadTimeOf(2)).toBe(0)
  })

  it('快照里的关闭频道进入镜像；旧快照缺该字段时回落为空', async () => {
    const withClosed = await setup(
      { 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } },
      [{ serverId: 's1', channelId: 'c-old' }],
    )
    expect(withClosed.store.usePocketUnreadStore().closedChannels.value).toEqual([
      { serverId: 's1', channelId: 'c-old' },
    ])

    const legacy = await setup({ 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } })
    expect(legacy.store.usePocketUnreadStore().closedChannels.value).toEqual([])
  })
})

describe('pocket-unread store（预览镜像）', () => {
  it('快照里的预览进入镜像（channelId 为键）；旧快照缺字段回落为空', async () => {
    const withPreviews = await setup(
      { 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } },
      undefined,
      [{ channelId: 'c1', starName: '成员', msgContent: '正文', msgTime: 0, unreadCount: null }],
    )
    expect(withPreviews.store.usePocketUnreadStore().roomPreviews.value.get('c1')?.msgContent).toBe('正文')

    const legacy = await setup({ 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } })
    expect(legacy.store.usePocketUnreadStore().roomPreviews.value.size).toBe(0)
  })

  it('广播整体换新 Map：同键新值可被 watch 观测', async () => {
    const { store } = await setup({ 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } })
    const { roomPreviews } = store.usePocketUnreadStore()
    roomPreviews.value = new Map([['c1', { channelId: 'c1', starName: '', msgContent: '旧', msgTime: 0, unreadCount: null }]])
    expect(roomPreviews.value.get('c1')?.msgContent).toBe('旧')
  })

  it('广播链路：订阅回调推来的预览重建 roomPreviews，无 channelId 的条目不进镜像', async () => {
    const { store, broadcast } = await setup({ 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } })
    // 快照回取没有预览 → 镜像为空，随后由广播整体重建
    expect(store.usePocketUnreadStore().roomPreviews.value.size).toBe(0)

    broadcast({
      rooms: { 1: { count: 5, bigCount: 5, smallCount: 0, latestTime: 100 } },
      total: 5,
      closedChannels: [],
      previews: [
        { channelId: 'c1', starName: '成员', msgContent: '广播正文', msgTime: 0, unreadCount: null },
        { channelId: '', starName: '成员', msgContent: '无频道', msgTime: 0, unreadCount: null },
      ],
    })

    const { roomPreviews } = store.usePocketUnreadStore()
    expect([...roomPreviews.value.keys()]).toEqual(['c1'])
    expect(roomPreviews.value.get('c1')?.msgContent).toBe('广播正文')

    // 再推一次空预览：整体换新 Map（不是原地清空，watch 才能观测到）
    const before = roomPreviews.value
    broadcast({ rooms: {}, total: 0, closedChannels: [], previews: [] })
    expect(roomPreviews.value).not.toBe(before)
    expect(roomPreviews.value.size).toBe(0)
  })
})
