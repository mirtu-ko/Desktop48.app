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
/** 本地关注名单：与口袋关注取并集——只在本地关注的成员同样要参与轮询（见 mergeFollowedIds） */
let localFollowedIds: number[] = []

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
  getServerChannels: vi.fn(),
}))

vi.mock('../src/main/database', () => ({
  Database: {
    instance: () => ({
      getMemberFlagIds: (kind: string) => (kind === 'followed' ? localFollowedIds : blockedIds),
    }),
  },
}))

interface AuthMock {
  getToken: ReturnType<typeof vi.fn>
  getFollowedIds: ReturnType<typeof vi.fn>
  getRoomChannel: ReturnType<typeof vi.fn>
  getRoomChannelOwner: ReturnType<typeof vi.fn>
  getRoomLastMessages: ReturnType<typeof vi.fn>
  getRoomMessages: ReturnType<typeof vi.fn>
  getServerChannels: ReturnType<typeof vi.fn>
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
  // 主动发现默认「该 server 下只有大房间」：多数用例不关心小房间枚举
  auth.getServerChannels.mockResolvedValue([{ channelId: 'c1', channelName: '大房间' }])
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
  localFollowedIds = []
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
    // 频道列表如实包含大房间与小房间（主动发现据此确认 cX 仍在，不会当作已被删）
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cX', channelName: '小房间' },
    ])

    // 第 1 轮：c1 首见锚定；cX 识别为小房间并归属（本轮还没进归属表，不探测）
    await runTick(auth, mod)
    await vi.waitFor(() => expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cX' }))
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

  it('小房间被房主更新（旧频道回「频道不存在」）：作废归属、清未读，下一轮重新发现新频道', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    auth.getFollowedIds.mockResolvedValue([1])
    auth.getRoomChannel.mockResolvedValue({ serverId: 's1', channelId: 'c1' })
    // 同 server 的暗号频道：room/info 被 questionId 信封拦下，拿不到 ownerId（只能按唯一关注成员归属）
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"596","question":"暗号"}'))
    // 频道列表包含大房间与旧小房间 cX（主动发现据列表判断 cX 是否已被房主删除）
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cX', channelName: '旧小房间' },
    ])
    // cX = 旧小房间，cY = 房主更新后的小房间
    auth.getRoomLastMessages.mockResolvedValue([lastOf('k1a', 'c1')[0], lastOf('k1b', 'cX')[0]])

    let smallGone = false
    let smallPage = pageOf('m1')
    auth.getRoomMessages.mockImplementation(async (channelId: string) => {
      if (channelId === 'c1')
        return pageOf('m1')
      if (smallGone)
        throw new Error('频道不存在')
      return smallPage
    })

    // 第 1 轮：cX 尚不在归属表（本轮不探测），末尾按「同 server 唯一关注成员」归为小房间
    await runTick(auth, mod)
    await settle()
    expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cX' })

    // 第 2 轮：cX 首见锚定（历史不算未读）
    auth.getRoomLastMessages.mockResolvedValue([lastOf('k2a', 'c1')[0], lastOf('k2b', 'cX')[0]])
    await runTick(auth, mod)
    await settle()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 3 轮：小房间来新消息 → 计未读（后面才能验证是「真被清掉」）
    smallPage = pageOf('m2', 'm1')
    auth.getRoomLastMessages.mockResolvedValue([lastOf('k3a', 'c1')[0], lastOf('k3b', 'cX')[0]])
    await runTick(auth, mod)
    await settle()
    expect(mod.getState().rooms['1']).toMatchObject({ count: 1, bigCount: 0, smallCount: 1 })

    // 第 4 轮：房主删掉了旧小房间（列表里已无 cX，还没建新的），
    // 探测回「频道不存在」→ 作废归属 + 清掉该频道的未读
    smallGone = true
    auth.getServerChannels.mockResolvedValue([{ channelId: 'c1', channelName: '大房间' }])
    auth.getRoomLastMessages.mockResolvedValue([lastOf('k4a', 'c1')[0], lastOf('k4b', 'cX')[0]])
    await runTick(auth, mod)
    await settle()
    expect(mod.getSmallChannel(1)).toBeNull()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })

    // 第 5 轮：房主新建的小房间出现在列表与 lastMsgList → 归属自愈重新挂到同一成员名下
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cY', channelName: '新小房间' },
    ])
    auth.getRoomLastMessages.mockResolvedValue([lastOf('k5a', 'c1')[0], lastOf('k5b', 'cY')[0]])
    await runTick(auth, mod)
    await settle()
    expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cY' })
  })

  it('房主删掉小房间且没建新的：频道列表里已无该频道 → 作废旧记录', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1', 'c1'))
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cX', channelName: '小房间' },
    ])
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"9","question":"暗号"}'))

    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getSmallChannel(1)).toMatchObject({ channelId: 'cX' }))
    mod.stopPocketUnread()

    // 房主只删不建：列表只剩大房间；旧频道已不在 lastMsgList，探测永远等不到 404
    auth.getServerChannels.mockResolvedValue([{ channelId: 'c1', channelName: '大房间' }])
    await mod.refreshSmallChannel(1, true)
    expect(mod.getSmallChannel(1)).toBeNull()
  })

  it('新建的小房间还没有消息（不在 lastMsgList）：靠 server 频道列表主动发现', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1', 'c1'))
    // 频道列表里多出一个频道，lastMsgList 完全没有它的条目——被动链路永远看不到
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cNew', channelName: '新小房间' },
    ])
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"9","question":"暗号"}'))

    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getSmallChannel(1)).toMatchObject({ serverId: 's1', channelId: 'cNew' }))
    mod.stopPocketUnread()
    // 还没人说话 → 不产生未读
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
  })

  it('同 server 的普通频道（room/info 正常回包）不会被当成小房间', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1', 'c1'))
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cNotice', channelName: '公告' },
    ])
    // 公告频道：room/info 正常回包（ownerId 命中成员也不能当暗号频道）
    auth.getRoomChannelOwner.mockResolvedValue({ channelId: 'cNotice', serverId: 's1', ownerId: 1 })

    mod.startPocketUnread()
    await vi.waitFor(() => expect(auth.getServerChannels).toHaveBeenCalled())
    await settle()
    mod.stopPocketUnread()
    expect(mod.getSmallChannel(1)).toBeNull()
  })

  it('旧小房间失效后，新频道即使不在 lastMsgList 也能重新枚举到', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1', 'c1'))
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cOld', channelName: '旧小房间' },
    ])
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"9","question":"暗号"}'))

    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getSmallChannel(1)).toMatchObject({ channelId: 'cOld' }))
    mod.stopPocketUnread()

    // 渲染层打开旧频道失败 → 通知作废（同时放开该 server 的发现间隔）
    mod.invalidateSmallChannel(1)
    expect(mod.getSmallChannel(1)).toBeNull()

    // 房主换上的新频道只出现在频道列表里，lastMsgList 仍只有大房间
    auth.getServerChannels.mockResolvedValue([
      { channelId: 'c1', channelName: '大房间' },
      { channelId: 'cNew', channelName: '新小房间' },
    ])
    mod.startPocketUnread()
    await vi.waitFor(() => expect(mod.getSmallChannel(1)).toMatchObject({ channelId: 'cNew' }))
    mod.stopPocketUnread()
  })

  it('发现间隔内不重复拉频道列表；force 刷新才重查', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1', 'c1'))

    await runTick(auth, mod)
    await settle()
    expect(auth.getServerChannels).toHaveBeenCalledTimes(1)

    // 第二轮仍在间隔内：不再枚举
    await runTick(auth, mod)
    await settle()
    expect(auth.getServerChannels).toHaveBeenCalledTimes(1)

    // 渲染层强制刷新（旧频道刚失效）：绕过间隔
    await mod.refreshSmallChannel(1, true)
    expect(auth.getServerChannels).toHaveBeenCalledTimes(2)
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

    // 登出 / token 失效由 IPC 层直接调用：不跑 tick 也立即清空 + 广播
    // （凭证失效后 tick 会因 token 无效整轮冻结，永远走不到未登录分支）
    broadcasts = []
    mod.clearAccountUnread()
    expect(mod.getState()).toEqual({ rooms: {}, total: 0 })
    expect(broadcasts.at(-1)).toEqual({ rooms: {}, total: 0 })

    // 已空再调不广播（并发失效报错时幂等）
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

  it('仅本地关注的成员同样参与轮询：解析大房间、发现小房间、消息计入未读', async () => {
    const { mod, auth } = await freshModule()
    auth.getToken.mockReturnValue('tok')
    // 口袋关注只有 1；2 只在本地关注（房间页照样显示他）
    auth.getFollowedIds.mockResolvedValue([1])
    localFollowedIds = [1, 2]
    auth.getRoomChannel.mockImplementation(async (userId: number) => (userId === 2
      ? { serverId: 's2', channelId: 'c2' }
      : { serverId: 's1', channelId: 'c1' }))
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k1', 'c2', 's2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m1'))
    auth.getServerChannels.mockImplementation(async (serverId: string) => (serverId === 's2'
      ? [{ channelId: 'c2', channelName: '大房间' }, { channelId: 'c2s', channelName: '暗号房' }]
      : [{ channelId: 'c1', channelName: '大房间' }]))
    // 该 server 下多余频道被暗号拦下 = 小房间
    auth.getRoomChannelOwner.mockRejectedValue(new Error('{"questionId":"9","question":"暗号是什么"}'))

    await runTick(auth, mod)
    await settle()

    // 并集去重：两人各解析一次
    expect(auth.getRoomChannel.mock.calls.map(call => call[0]).sort()).toEqual([1, 2])
    expect(mod.getSmallChannel(2)).toMatchObject({ serverId: 's2', channelId: 'c2s' })

    // 本地关注成员的新消息同样计入未读
    auth.getRoomLastMessages.mockResolvedValue(lastOf('k2', 'c2', 's2'))
    auth.getRoomMessages.mockResolvedValue(pageOf('m3', 'm2', 'm1'))
    await runTick(auth, mod)
    await settle()
    expect(mod.getState().rooms['2']).toMatchObject({ count: 2 })
  })

  it('本地关注同样受屏蔽约束：被屏蔽的成员不解析、不计未读', async () => {
    const { mod, auth } = await freshModule()
    stubOnline(auth, lastOf('k1'))
    // 1 是口袋关注（被屏蔽），2 只在本地关注 → 名单里只剩 2
    localFollowedIds = [1, 2]
    blockedIds = [1]
    await runTick(auth, mod)
    await settle()
    expect(auth.getRoomChannel.mock.calls.map(call => call[0])).toEqual([2])
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
