/**
 * 房间未读检测（main/pocket48/pocket-unread.ts）核心规则单测：
 * 首见锚定回执键 / 新消息按身份键变化计数 / markRead 清零（删回执键待重锚，已读不复活）/
 * 未登录清空 / 取关清理 / 归属自愈 / 小房间归属 / 快照持久化。
 * electron、pocket-auth、ipc/send、logger 全部 mock，状态落盘指向临时目录；
 * 每个用例经 vi.resetModules 重新加载被测模块，模拟「同一份持久化、全新会话」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tmpUserData = ''
let broadcasts: Array<{ rooms: Record<string, unknown>, total: number }> = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? tmpUserData : ''),
    setBadgeCount: vi.fn(),
  },
}))

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../src/main/ipc/send', () => ({
  broadcastIpc: vi.fn((_channel: unknown, state: { rooms: Record<string, unknown>, total: number }) => {
    broadcasts.push(state)
  }),
}))

vi.mock('../src/main/pocket48/pocket-auth', () => ({
  getToken: vi.fn(),
  getFollowedIds: vi.fn(),
  getRoomChannel: vi.fn(),
  getRoomChannelOwner: vi.fn(),
  getRoomLastMessages: vi.fn(),
}))

/** 重新加载被测模块与其 mock 依赖：resetModules 后 vi.fn 都是新实例，必须一并取回配置 */
async function freshModule() {
  vi.resetModules()
  broadcasts = []
  const mod = await import('../src/main/pocket48/pocket-unread')
  const auth = await import('../src/main/pocket48/pocket-auth')
  return { mod, auth }
}

/** lastMsgList 单条回包（降级形状：无 unreadCount 字段，检测走身份键粗算） */
function lastOf(msgTime: number, msgContent: string) {
  return [{
    channelId: 'c1',
    serverId: 's1',
    starName: '成员',
    msgContent,
    msgKey: `key-${msgTime}`,
    msgTime,
    unreadCount: null,
  }]
}

/** 登录态 + 单成员单频道的最小环境 */
function stubOnline(auth: {
  getToken: ReturnType<typeof vi.fn>
  getFollowedIds: ReturnType<typeof vi.fn>
  getRoomChannel: ReturnType<typeof vi.fn>
  getRoomLastMessages: ReturnType<typeof vi.fn>
}, last: ReturnType<typeof lastOf>) {
  auth.getToken.mockReturnValue('tok')
  auth.getFollowedIds.mockResolvedValue([1])
  auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
  auth.getRoomLastMessages.mockResolvedValue(last)
}

beforeEach(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-unread-test-'))
})

afterEach(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true })
})

describe('pocket-unread（房间未读检测）', () => {
  it('首次见到频道：回执键锚定当前最新消息，历史不算未读', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('最新消息身份键变化计 +1，同一条不重复累计', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()

    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, latestTime: 2000 })
    // 再跑一轮：身份键没变（还是同一条最新消息），不重复累加
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1'].count).toBe(1)
  })

  it('markRead 清零后同一条消息不复活；下一条新消息重新计数', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()

    // 标记已读：清零 + 广播 + 即时对齐基线/锚（内部会拉一轮批量预览）
    await mod.markRead(1)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
    expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 })

    // 回归（已读复活 bug）：下一轮检测看到的还是刚读过的同一条消息（key-2000）——
    // 重锚后不计数；markRead 若混写过渲染层键，这里会误判成新消息 +1。
    // markRead 内部基线对齐已消耗一次调用，start 的立即轮按相对基线等待
    const callsBefore = auth.getRoomLastMessages.mock.calls.length
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(callsBefore + 1))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()

    // 更新的消息照常计：身份键 key-3000 ≠ 重锚后的 key-2000
    auth.getRoomLastMessages.mockResolvedValue(lastOf(3000, '更新'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, latestTime: 3000 })
  })

  it('未登录时清空未读并广播；token 失效（请求抛错）时冻结不清', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()

    // token 失效：本轮抛错只冻结，未读保留。前两轮 tick 已消耗调用，
    // startPocketUnread 会立刻再发起一次，按基线等待本轮，不写死绝对次数
    auth.getFollowedIds.mockRejectedValue(new Error('登录已过期，请重新登录口袋48账号'))
    const callsBefore = auth.getFollowedIds.mock.calls.length
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getFollowedIds.mock.calls.length).toBe(callsBefore + 1))
    mod.stopPocketUnread()
    expect(mod.getState().total).toBe(1)

    // 彻底未登录（凭证不存在）：清空并广播
    auth.getFollowedIds.mockReset()
    auth.getToken.mockReturnValue('')
    mod.startPocketUnread()
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 重新登录：账号相关回执键已随登出清空，当前消息重新锚定，不会补回登出前未读
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    const messageCalls = auth.getRoomLastMessages.mock.calls.length
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages.mock.calls.length).toBe(messageCalls + 1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('未读快照随持久化文件跨会话保留（重启不丢）', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()

    // 同一 userData 目录、全新模块实例 = 模拟重启
    const { mod: restarted } = await freshModule()
    expect(restarted.getState().rooms['1']).toMatchObject({ count: 1, latestTime: 2000 })
  })

  it('取关成员：未读与回执键一并清理并广播；重新关注后首见重新锚定', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()

    // 取关：房间已不在列表，markRead 无从触发——未读必须随频道缓存一并清理并广播
    auth.getFollowedIds.mockResolvedValue([])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 重新关注：回执键已清，首轮重新锚定当前最新，历史不算未读（频道缓存已随取关清掉，会重新解析）
    auth.getFollowedIds.mockResolvedValue([1])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannel.mock.calls.length).toBe(2))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()
  })

  it('未归属频道自愈：room/info 反查房主补全归属表，下一轮开始计数', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1, 2])
    // 成员 2 的频道解析失败（空占位），其房间 c2 只会出现在 lastMsgList 回包里
    auth.getRoomChannel.mockImplementation(async (id: number) =>
      id === 1 ? { serverId: 's1', channelId: 'c1' } : { serverId: 's1', channelId: '' })
    const item = (key: string) => [{
      channelId: 'c2',
      serverId: 's1',
      starName: '最后发言人',
      msgContent: 'hi',
      msgKey: key,
      msgTime: 0,
      unreadCount: null,
    }]
    auth.getRoomLastMessages.mockResolvedValue(item('k1'))
    auth.getRoomChannelOwner.mockResolvedValue({ channelId: 'c2', serverId: 's1', ownerId: 2 })

    // 第 1 轮：c2 无法归属 → 自愈反查 → 补进归属表（本轮不计数）
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 2 轮：c2 已归属 → 首见锚定 k1，历史不算未读；正向缓存不再反查
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1)
    mod.stopPocketUnread()

    // 第 3 轮：新消息 k2 → 正常计未读
    auth.getRoomLastMessages.mockResolvedValue(item('k2'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['2']).toMatchObject({ count: 1 })
  })

  it('归属反查确定性失败（频道不存在）记负缓存，不每轮重试', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    auth.getRoomLastMessages.mockResolvedValue([{
      channelId: 'cX',
      serverId: 's1',
      starName: '最后发言人',
      msgContent: 'm',
      msgKey: 'k1',
      msgTime: 0,
      unreadCount: null,
    }])
    // 翻牌/礼物回复类频道：room/info 回「频道不存在」
    auth.getRoomChannelOwner.mockRejectedValue(new Error('频道不存在'))

    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()

    // 第二轮：负缓存生效，不再反查；未归属频道只是无法计数，不影响其他房间
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    mod.stopPocketUnread()
    expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1)
  })

  it('暗号频道（小房间）按同 server 大房间归属，新消息计入该成员未读', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    // cX 与成员 1 的大房间 c1 同 server，room/info 被暗号拦下（questionId 信封）
    auth.getRoomLastMessages.mockResolvedValue([{
      channelId: 'cX',
      serverId: 's1',
      starName: '最后发言人',
      msgContent: 'm',
      msgKey: 'k1',
      msgTime: 0,
      unreadCount: null,
    }])
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"596","question":"暗号"}'))

    // 第 1 轮：cX 识别为成员 1 的小房间并补全归属（本轮不计数）
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 2 轮：cX 已归属 → 首见锚定 k1，历史不算未读；不再反查
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1)
    mod.stopPocketUnread()

    // 第 3 轮：小房间新消息 k2 → 计入成员 1 未读
    auth.getRoomLastMessages.mockResolvedValue([{
      channelId: 'cX',
      serverId: 's1',
      starName: '最后发言人',
      msgContent: 'm2',
      msgKey: 'k2',
      msgTime: 0,
      unreadCount: null,
    }])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1 })
  })

  it('精确模式：unreadCount 与基线做差算出真实条数；markRead 对齐基线后不复活', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    const withCount = (n: number) => [{
      channelId: 'c1',
      serverId: 's1',
      starName: '成员',
      msgContent: 'm',
      msgKey: `k${n}`,
      msgTime: 1000,
      unreadCount: n,
    }]

    // 第 1 轮：首见锚定基线 2，历史不算未读
    auth.getRoomLastMessages.mockResolvedValue(withCount(2))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 2 轮：服务端计数涨到 5 → 未读 = 3（精确条数，不是粗算 +1）
    auth.getRoomLastMessages.mockResolvedValue(withCount(5))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(3))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 3, latestTime: 1000 })

    // markRead：即时拉一轮批量预览把基线对齐到当下（回 5）→ 清零不复活
    await mod.markRead(1)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 3 轮：服务端计数没变（还是 5）→ 不复活
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()

    // 第 4 轮：服务端计数回落到 1（手机上已读）→ 基线对齐、自动清零
    auth.getRoomLastMessages.mockResolvedValue(withCount(1))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(5))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('markRead 按频道拆分：读大房间保留小房间未读；getSmallChannel 暴露小房间频道', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    // c1 大房间 + cX 小房间（同 server，room/info 被暗号拦下）
    const both = (bigKey: string, smallKey: string) => [
      { channelId: 'c1', serverId: 's1', starName: '成员', msgContent: '大房间', msgKey: bigKey, msgTime: 0, unreadCount: null },
      { channelId: 'cX', serverId: 's1', starName: '成员', msgContent: '小房间', msgKey: smallKey, msgTime: 0, unreadCount: null },
    ]
    auth.getRoomLastMessages.mockResolvedValue(both('k1a', 'k1b'))
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"596","question":"暗号"}'))

    // 第 1 轮：c1 锚定；cX 识别为小房间并归属（本轮不计数）
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()

    // 第 2 轮：cX 锚定；小房间频道可查
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    mod.stopPocketUnread()
    expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cX' })
    expect(mod.getSmallChannel(2)).toBeNull()

    // 两个频道各来一条新消息：聚合 total 2，大/小房间分计各 1
    auth.getRoomLastMessages.mockResolvedValue(both('k2a', 'k2b'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(2))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 2, bigCount: 1, smallCount: 1 })

    // 读大房间：只清大房间，小房间未读保留
    await mod.markRead(1, 'room')
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, bigCount: 0, smallCount: 1 })

    // 读小房间：清零
    await mod.markRead(1, 'small')
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })
})
