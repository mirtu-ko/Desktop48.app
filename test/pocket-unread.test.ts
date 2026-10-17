/**
 * 房间未读检测（main/pocket48/pocket-unread.ts）核心规则单测：
 * 首见锚定已读水位 / 按消息列表数条数 / 预览身份键只作触发 / 一页封顶 /
 * 每轮探测名额轮转 / markRead 推水位（已读不复活）/ 未登录清空 / 取关清理 / 屏蔽剔除 /
 * 归属自愈 / 小房间归属 / 快照持久化。
 * electron、pocket-auth、database、ipc/send、logger 全部 mock，状态落盘指向临时目录；
 * 每个用例经 vi.resetModules 重新加载被测模块，模拟「同一份持久化、全新会话」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tmpUserData = ''
let broadcasts: Array<{ rooms: Record<string, unknown>, total: number }> = []
/** 本地屏蔽名单：被测模块每轮读它把成员从未读检测范围里剔除（见 tick） */
let blockedIds: number[] = []

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
  getRoomMessages: vi.fn(),
}))

vi.mock('../src/main/database', () => ({
  Database: {
    instance: () => ({ getMemberFlagIds: () => blockedIds }),
  },
}))

interface AuthMock {
  getToken: ReturnType<typeof vi.fn>
  getFollowedIds: ReturnType<typeof vi.fn>
  getRoomChannel: ReturnType<typeof vi.fn>
  getRoomChannelOwner: ReturnType<typeof vi.fn>
  getRoomLastMessages: ReturnType<typeof vi.fn>
  getRoomMessages: ReturnType<typeof vi.fn>
}

/** 重新加载被测模块与其 mock 依赖：resetModules 后 vi.fn 都是新实例，必须一并取回配置 */
async function freshModule() {
  vi.resetModules()
  broadcasts = []
  const mod = await import('../src/main/pocket48/pocket-unread')
  const auth = (await import('../src/main/pocket48/pocket-auth')) as unknown as AuthMock
  return { mod, auth }
}

/** 预览接口（last/message/get）单条回包：降级形状，只有身份键可供判断「有新消息」 */
function lastOf(msgKey: string, channelId = 'c1', serverId = 's1') {
  return [{
    channelId,
    serverId,
    starName: '成员',
    msgContent: '正文',
    msgKey,
    msgTime: 0,
    unreadCount: null,
  }]
}

/** 列表接口单条消息（主进程只用到 msgIdServer / msgTime / userId） */
function msg(msgIdServer: string, index: number, userId = '9') {
  return {
    msgIdServer,
    msgIdClient: '',
    msgType: 'TEXT',
    // 最新在前：index 0 的 msgTime 最大
    msgTime: 1_000_000 - index * 1_000,
    bodys: '{"content":"m"}',
    extInfo: '{}',
    userId,
  }
}

/** 一页消息：按「最新在前」给 id */
function pageOf(...ids: string[]) {
  return { messages: ids.map((id, index) => msg(id, index)), nextTime: 0 }
}

/** 登录态 + 单成员单频道的最小环境 */
function stubOnline(auth: AuthMock, last: ReturnType<typeof lastOf>) {
  auth.getToken.mockReturnValue('tok')
  auth.getFollowedIds.mockResolvedValue([1])
  auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
  auth.getRoomLastMessages.mockResolvedValue(last)
}

/** 跑一轮检测并等它把预览接口打完（轮询入口是同步的，用调用次数当轮次栅栏） */
async function runTick(auth: AuthMock, mod: { startPocketUnread: () => void, stopPocketUnread: () => void }) {
  const previewBefore = auth.getRoomLastMessages.mock.calls.length
  mod.startPocketUnread()
  await vi.waitFor(() => expect(auth.getRoomLastMessages.mock.calls.length).toBe(previewBefore + 1))
  mod.stopPocketUnread()
}

/** 等异步轮次彻底收尾（mock 的 promise 立即 settle，一个宏任务足够） */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 10))
}

beforeEach(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-unread-test-'))
  blockedIds = []
})

afterEach(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true })
})

describe('pocket-unread（房间未读检测）', () => {
  it('首见频道：拉一页列表锚定已读水位，历史不算未读', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    expect(auth.getRoomMessages).toHaveBeenCalledTimes(1)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('有新消息：按列表数出「比水位新」的条数（不是每轮 +1）', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)

    // 水位 = m1；新一页里比 m1 新的有 3 条
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().rooms['1']).toMatchObject({ count: 3, bigCount: 3, smallCount: 0 })
  })

  it('预览身份键没变就不重复探测：未读保留，不因轮询自己归零', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(3)

    // 再跑两轮：身份键未变 → 一次列表都不拉，未读原样保留
    const probeCalls = auth.getRoomMessages.mock.calls.length
    await runTick(auth, mod)
    await runTick(auth, mod)
    await settle()
    expect(auth.getRoomMessages.mock.calls.length).toBe(probeCalls)
    expect(mod.getState().total).toBe(3)
  })

  it('一页全是新消息（水位那条已沉出本页）→ 计到一页封顶 50', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('w1'))
    await runTick(auth, mod)

    const fresh = Array.from({ length: 50 }, (_, index) => `n${index}`)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf(...fresh))
    await runTick(auth, mod)
    expect(mod.getState().rooms['1'].count).toBe(50)
  })

  it('官方系统账号的发言不计入（与渲染层成员视图同口径）', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('mA'))
    await runTick(auth, mod)

    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue({
      messages: [msg('off', 0, '121569667'), msg('mB', 1), msg('mA', 2)],
      nextTime: 0,
    })
    await runTick(auth, mod)
    expect(mod.getState().rooms['1'].count).toBe(1)
  })

  it('关注房间过多：每轮最多探测 9 个，剩下的下一轮补上', async () => {
    const { mod, auth } = await freshModule()
    const userIds = Array.from({ length: 10 }, (_, index) => index + 1)
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue(userIds)
    auth.getRoomChannel.mockImplementation(async (userId: number) => ({
      serverId: 's1',
      channelId: `c${userId}`,
    }))
    auth.getRoomLastMessages.mockResolvedValue(
      userIds.map(userId => lastOf('k1', `c${userId}`)[0]),
    )
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))

    // 首轮 10 个频道都是首见 → 只探测 9 个
    await runTick(auth, mod)
    await settle()
    expect(auth.getRoomMessages).toHaveBeenCalledTimes(9)

    // 被挤掉的那个本轮没推进触发锚，下一轮仍是「有更新」→ 补上
    await runTick(auth, mod)
    await vi.waitFor(() => expect(auth.getRoomMessages).toHaveBeenCalledTimes(10))
    mod.stopPocketUnread()
  })

  it('markRead：目标频道清零、水位推到当下，同一条消息不复活；再来新消息照常计', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)

    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(3)

    // 标记已读：清零 + 广播 + 拉一页把水位推到当下（此页最新是 m4）
    await mod.markRead(1)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
    expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 })

    // 同一页消息不复活（水位已到 m4，即使键变化触发探测，数出来也是 0）
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k3'))
    await runTick(auth, mod)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 比水位新的消息照常计
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k4'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m5', 'm4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, latestTime: 1_000_000 })
  })

  it('markRead 按频道拆分：读大房间保留小房间未读；getSmallChannel 暴露小房间频道', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    // c1 大房间 + cX 小房间（同 server，room/info 被暗号拦下）
    const both = (bigKey: string, smallKey: string) => [
      lastOf(bigKey, 'c1')[0],
      lastOf(smallKey, 'cX')[0],
    ]
    auth.getRoomLastMessages.mockResolvedValue(both('k1a', 'k1b'))
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"596","question":"暗号"}'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))

    // 第 1 轮：c1 首见锚定；cX 识别为小房间并归属（本轮还没进归属表，不探测）
    await runTick(auth, mod)
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()

    // 第 2 轮：cX 已归属 → 首见锚定；小房间频道可查
    await runTick(auth, mod)
    expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cX' })
    expect(mod.getSmallChannel(2)).toBeNull()

    // 两个频道各来新消息：大 / 小房间各 1 条
    auth.getRoomLastMessages.mockResolvedValue(both('k2a', 'k2b'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m2', 'm1'))
    await runTick(auth, mod)
    await vi.waitFor(() => expect(mod.getState().total).toBe(2))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 2, bigCount: 1, smallCount: 1 })

    // 读大房间：只清大房间，小房间未读保留
    broadcasts = []
    await mod.markRead(1, 'room')
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, bigCount: 0, smallCount: 1 })
    // 清零广播当即按频道拆分（不是先整块清零、等对齐后再补回小房间）→ 渲染层角标不闪
    expect(broadcasts[0]).toMatchObject({ rooms: { 1: { count: 1, bigCount: 0, smallCount: 1 } } })

    // 读小房间：清零
    await mod.markRead(1, 'small')
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('预览回包缺条（该频道没回）：未读保留，不清零', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    auth.getRoomLastMessages.mockResolvedValue([])
    await runTick(auth, mod)
    await settle()
    expect(mod.getState().total).toBe(2)
  })

  it('未登录清空未读并广播；重新登录按首见重新锚定', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    // 彻底未登录（凭证不存在）：清空并广播
    auth.getToken.mockReturnValue('')
    mod.startPocketUnread()
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 }))
    await settle()
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 重新登录：账号相关状态已随登出清空，重新走首见锚定，不补回登出前未读
    auth.getToken.mockReturnValue('tok')
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    await settle()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('clearAccountUnread 即刻清空并广播归零，不等下一轮检测；无变化时静默', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    // 登出 / token 失效时由 IPC 层直接调用：不跑 tick 也立即清空 + 广播
    // （凭证失效后 tick 会因 token 无效整轮冻结，永远走不到未登录分支）
    broadcasts = []
    mod.clearAccountUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
    expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 })

    // 已空再调不广播（对齐 token 失效时多请求并发报错的重复清况）
    broadcasts = []
    mod.clearAccountUnread()
    expect(broadcasts).toEqual([])
  })

  it('取关成员：未读与水位一并清理并广播；重新关注后首见重新锚定', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    // 取关：房间已不在列表，markRead 无从触发——未读必须随频道缓存一并清理并广播
    auth.getFollowedIds.mockResolvedValue([])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 }))
    await settle()
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 重新关注：频道缓存与水位已清，首轮重新解析 + 重新锚定，历史不算未读
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomMessages.mockResolvedValue(pageOf('m4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    await vi.waitFor(() => expect(auth.getRoomChannel).toHaveBeenCalledTimes(2))
    await settle()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('屏蔽成员：剔除出检测范围，未读与频道缓存按取关同一条路径清理', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    // 屏蔽：账号关注照旧存在（关注与屏蔽正交），检测范围里剔除该成员，未读随之清零并广播
    blockedIds = [1]
    mod.startPocketUnread()
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 }))
    await settle()
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 解除屏蔽：频道缓存已清，重新解析 + 重新锚定，历史不算未读
    blockedIds = []
    auth.getRoomMessages.mockResolvedValue(pageOf('m4', 'm3', 'm2', 'm1'))
    await runTick(auth, mod)
    await vi.waitFor(() => expect(auth.getRoomChannel).toHaveBeenCalledTimes(2))
    await settle()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('未读快照与已读水位随持久化文件跨会话保留（重启不丢、也不误判未读）', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    await runTick(auth, mod)
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    expect(mod.getState().total).toBe(2)

    // 同一 userData 目录、全新模块实例 = 模拟重启：未读与水位都从盘上恢复
    const { mod: restarted, auth: restartedAuth } = await freshModule()
    expect(restarted.getState().rooms['1']).toMatchObject({ count: 2 })
    restartedAuth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    // 同一页消息不因重启被重新计一遍（水位已落盘）
    await runTick(restartedAuth, restarted)
    expect(restarted.getState().rooms['1'].count).toBe(2)
  })

  it('未归属频道自愈：room/info 反查房主补全归属表，下一轮开始计数', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1, 2])
    // 成员 2 的频道解析失败（空占位），其房间 c2 只会出现在 lastMsgList 回包里
    auth.getRoomChannel.mockImplementation(async (userId: number) =>
      userId === 1 ? { serverId: 's1', channelId: 'c1' } : { serverId: 's1', channelId: '' })
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k1', 'c2'))
    auth.getRoomChannelOwner.mockResolvedValue({ channelId: 'c2', serverId: 's1', ownerId: 2 })
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))

    // 第 1 轮：c2 无法归属 → 自愈反查 → 补进归属表（本轮不探测）
    await runTick(auth, mod)
    await vi.waitFor(() => expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1))
    mod.stopPocketUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 2 轮：c2 已归属 → 首见锚定；正向缓存不再反查
    await runTick(auth, mod)
    expect(auth.getRoomChannelOwner).toHaveBeenCalledTimes(1)
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 3 轮：新消息 → 按列表数出 2 条
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2', 'c2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    await vi.waitFor(() => expect(mod.getState().total).toBe(2))
    mod.stopPocketUnread()
    expect(mod.getState().rooms['2']).toMatchObject({ count: 2 })
  })
})
