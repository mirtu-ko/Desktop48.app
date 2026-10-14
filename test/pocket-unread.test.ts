/**
 * 房间未读检测（main/pocket48/pocket-unread.ts）核心规则单测：
 * 首见锚定水位 / 新消息计数与防重复 / markRead 清零并推进水位 / 未登录清空 / 快照持久化。
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

function lastOf(msgTime: number, msgContent: string) {
  return [{ channelId: 'c1', starName: '成员', msgContent, msgTime, unreadCount: 0 }]
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
  it('首次见到频道：水位锚定当前最新消息，历史不算未读', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('超过水位的新消息计 +1，同一轮的同一条不重复累计', async () => {
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
    // 再跑一轮：msgTime 没超过 counted，不重复累加
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(2))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1'].count).toBe(1)
  })

  it('markRead 清零并推进水位，之后的新消息重新计数', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf(1000, '历史消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomLastMessages).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    auth.getRoomLastMessages.mockResolvedValue(lastOf(2000, '新消息'))
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getState().total).toBe(1))
    mod.stopPocketUnread()

    // 标记已读：清零 + 广播
    mod.markRead(1, 2000)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
    expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 })

    // 更新的消息照常计：水位是 2000，3000 > 水位且未被计入
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

    // token 失效：本轮抛错只冻结，未读保留。前两轮 tick 已消耗 2 次调用，
    // startPocketUnread 会立刻发起第 3 次，按基线等待本轮，不写死绝对次数
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

    // 重新登录：账号相关水位/计数已随登出清空，当前消息重新锚定，不会补回登出前未读
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

  it('取关成员：未读与水位一并清理并广播；重新关注后首见重新锚定', async () => {
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

    // 重新关注：水位已清，首轮重新锚定当前最新，历史不算未读（频道缓存已随取关清掉，会重新解析）
    auth.getFollowedIds.mockResolvedValue([1])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getRoomChannel.mock.calls.length).toBe(2))
    await vi.waitFor(() => expect(mod.getState()).toEqual({ rooms: {}, total: 0 }))
    mod.stopPocketUnread()
  })
})
