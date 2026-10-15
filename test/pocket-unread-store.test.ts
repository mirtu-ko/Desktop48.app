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

/** 假主进程：未读快照回取一次 + 记录 markRead 调用（本用例不推广播，只看乐观值） */
async function setup(rooms: Record<string, RoomState>) {
  vi.resetModules()
  const calls: Array<[number, string]> = []
  vi.stubGlobal('window', {
    mainAPI: {
      pocketUnreadBatch: vi.fn(),
      pocketUnreadState: vi.fn(async () => ({ rooms, total: 0 })),
      pocketMarkRead: vi.fn(async (userId: number, target: string) => {
        calls.push([userId, target])
      }),
    },
  })
  const store = await import('../src/renderer/src/stores/pocket-unread')
  store.installPocketUnread()
  // 快照回取是异步的，等它落到镜像里再断言
  await vi.waitFor(() => expect(store.unreadCountOf(1)).toBe(5))
  return { store, calls }
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
})
