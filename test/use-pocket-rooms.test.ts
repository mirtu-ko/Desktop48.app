import type { FloatPlayerKind, FloatPlayerPayload } from '@preload/ipc-contract'
import type { PocketRoomMessageView } from '../src/renderer/src/utils/pocket-room-message'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

/**
 * use-pocket-rooms 编排层：关注名单合并、房间遍历（过滤无房间）、
 * 左列最新消息预览、消息拉取/轮询/翻历史、切人与降级。
 *
 * 真实接入 pocket-room-message（归一）与 member-flags（本地关注 store），
 * 仅 mock 四个边界：成员目录、直播列表接口、口袋登录态、主进程房间接口。
 */

const { directoryMock, apisMock, authMock, roomMock } = vi.hoisted(() => ({
  directoryMock: {
    /** userId → 成员详情；默认查不到（降级为「口袋用户 N」） */
    find: async (_userId: number) => null as any,
  },
  apisMock: {
    lives: async (_next: string, _options?: unknown) => ({ next: '0', liveList: [] as any[] }),
  },
  authMock: {
    state: null as any,
    setLoggedIn: (value: boolean) => {
      authMock.state.value = { ...authMock.state.value, loggedIn: value }
    },
  },
  roomMock: {
    /** userId → 抛错（频道解析失败，加载时按无房间过滤）；未设置 = 全部成功 */
    channelFail: new Set<number>(),
    /** channelId → 消息失败（消息拉取失败） */
    messageFail: new Set<string>(),
  },
}))

vi.mock('@renderer/stores/member-directory', () => ({
  useMemberDirectoryStore: () => ({ findMemberByUserId: (userId: number) => directoryMock.find(userId) }),
}))

vi.mock('@renderer/services/apis', () => ({
  default: {
    lives: (next: string, options?: unknown) => apisMock.lives(next, options),
  },
}))

vi.mock('@renderer/stores/pocket-auth', async () => {
  const { ref } = await import('vue')
  const state = ref({
    loggedIn: true,
    nickname: '',
    avatar: '',
    mobileMasked: '',
    plainFallback: false,
    savedAt: 0,
  })
  authMock.state = state
  return {
    pocketAuthState: state,
    refreshPocketAuthState: async () => state.value,
  }
})

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface LiveItem {
  liveId: string
  title: string
  ctime: string
  liveType: number
  liveMode: number
  userInfo: { userId: number, nickname: string }
}

/** 直播列表条目（只挑编排层会读的字段） */
function live(liveId: string, userId: number, title = `${liveId} 的直播`): LiveItem {
  return { liveId, title, ctime: '1728000000000', liveType: 1, liveMode: 0, userInfo: { userId, nickname: `口袋昵称${userId}` } }
}

/** 房间消息（CustomMessageV2 形态；接口按 msgTime 倒序返回，最新在前） */
function roomMsg(msgIdClient: string, msgTime: number, text: string, nick = '粉丝甲') {
  return {
    msgIdServer: `srv-${msgIdClient}`,
    msgIdClient,
    msgType: 'TEXT',
    msgTime,
    bodys: text,
    extInfo: JSON.stringify({ user: { userId: 1, nickName: nick, level: 5 } }),
  }
}

/**
 * setup() 创建的 effectScope：afterEach 必须停掉。
 * 否则上个用例的 api 实例（watch(loggedIn) → load）会在全局 stub 卸载后
 * 被 afterEach 的 setLoggedIn(true) 唤醒，打出 window is not defined 噪音。
 */
let activeScope: ReturnType<typeof effectScope> | null = null
/**
 * 同一个假主进程下临时多开的 composable 实例（模拟 <KeepAlive :key> 重建后 Rooms 重挂载）：
 * 同样要在 afterEach 停掉，理由同上。
 */
const extraScopes: Array<ReturnType<typeof effectScope>> = []

interface SetupOptions {
  /** 口袋账号关注 ID */
  pocketIds?: number[]
  /** 本地关注名单（主进程 getMemberFlags 解析结果） */
  localFlags?: Array<{ userId: number, realName: string, teamColor: string }>
  /** 本地屏蔽名单（同为 getMemberFlags，kind='blocked'）：进左列前会被剔除 */
  blockedFlags?: Array<{ userId: number, realName: string, teamColor: string }>
  /** getLiveList 分页：数组元素为一页 */
  livePages?: Array<{ next: string, liveList: LiveItem[] }>
  /** true = pocketGetFollowedIds 抛错（过期/网络） */
  pocketFollowFails?: boolean
  /** 成员目录反查结果 */
  directory?: Record<number, { realName: string, avatar: string, teamName: string, teamColor: string }>
  /** channelId → { 请求 nextTime: 响应页 }；响应页 nextTime 即更早历史的游标 */
  roomPages?: Record<string, Record<number, { nextTime: number, messages: ReturnType<typeof roomMsg>[] }>>
  /** serverId → 最新一条消息（team/classic/last/message/get 的 lastMsgList 条目） */
  lastMessages?: Array<{ channelId: string, starName?: string, msgContent: string, msgTime?: number }>
  /** serverId → 该 server 下的频道（seine 频道详情，页签显示真实频道名用） */
  serverChannels?: Record<string, Array<{ channelId: string, channelName: string }>>
  /** userId → 已发现的小房间频道；未设置 = 未发现（页签只有大房间） */
  smallChannels?: Record<number, { serverId: string, channelId: string }>
  /** channelId → 暗号问题；未设置 = room/info 未被拦（无门禁，切进去直接拉消息） */
  roomQuestions?: Record<string, { questionId: string, question: string }>
  /** channelId → 正确暗号；不设置则该频道的提交一律判错 */
  roomAnswers?: Record<string, string>
}

async function setup(options: SetupOptions = {}) {
  const calls = {
    pocketFollowedIds: 0,
    livePages: [] as string[],
    channelFetched: [] as number[],
    lastMessageFetched: [] as string[][],
    messageFetched: [] as Array<{ channelId: string, nextTime: number, scope: 'member' | 'all' }>,
    serverChannelsFetched: [] as string[],
    answerChecks: [] as Array<{ channelId: string, answer: string }>,
    openFloatWindow: [] as Array<[FloatPlayerKind, FloatPlayerPayload]>,
  }
  roomMock.channelFail = new Set()
  roomMock.messageFail = new Set()

  vi.stubGlobal('window', {
    mainAPI: {
      pocketGetFollowedIds: vi.fn(async () => {
        calls.pocketFollowedIds++
        if (options.pocketFollowFails)
          throw new Error('登录已过期')
        return options.pocketIds ?? []
      }),
      getMemberFlags: vi.fn(async (kind: string) =>
        (kind === 'blocked' ? options.blockedFlags : options.localFlags) ?? []),
      pocketGetAuthState: vi.fn(async () => authMock.state.value),
      pocketGetRoomChannel: vi.fn(async (userId: number) => {
        calls.channelFetched.push(userId)
        if (roomMock.channelFail.has(userId))
          throw new Error('频道解析失败')
        return { serverId: `srv-${userId}`, channelId: `ch-${userId}` }
      }),
      pocketGetRoomLastMessages: vi.fn(async (serverIds: string[]) => {
        calls.lastMessageFetched.push(serverIds)
        return (options.lastMessages ?? []).filter(item =>
          serverIds.includes(`srv-${item.channelId.replace('ch-', '')}`),
        )
      }),
      pocketGetRoomMessages: vi.fn(async (channelId: string, _serverId: string, nextTime = 0, scope: 'member' | 'all' = 'member') => {
        calls.messageFetched.push({ channelId, nextTime, scope })
        if (roomMock.messageFail.has(channelId))
          throw new Error('消息拉取失败')
        const page = options.roomPages?.[channelId]?.[nextTime] ?? { nextTime: 0, messages: [] }
        return page
      }),
      pocketGetServerChannels: vi.fn(async (serverId: string) => {
        calls.serverChannelsFetched.push(serverId)
        return options.serverChannels?.[serverId] ?? []
      }),
      // 小房间频道发现走主进程归属自愈：默认未发现（页签只有大房间）
      pocketGetSmallChannel: vi.fn(async (userId: number) => options.smallChannels?.[userId] ?? null),
      // 默认无门禁（room/info 未被拦）；给了问题即视为被暗号拦下
      pocketGetRoomQuestion: vi.fn(async (channelId: string) => options.roomQuestions?.[channelId] ?? null),
      pocketCheckRoomAnswer: vi.fn(async (channelId: string, _questionId: string, answer: string) => {
        calls.answerChecks.push({ channelId, answer })
        return options.roomAnswers?.[channelId] === answer
          ? { ok: true, via: 'server' as const }
          : { ok: false, reason: 'wrong' as const, message: '暗号不正确' }
      }),
      openFloatWindow: vi.fn(async (kind: FloatPlayerKind, payload: FloatPlayerPayload) => {
        calls.openFloatWindow.push([kind, payload])
      }),
      // 标记房间已读（进房 / 贴底时由页面层调用）：未读真相在主进程，这里只收下调用
      pocketMarkRead: vi.fn(async () => {}),
      // 开直播窗前会做 FFmpeg 校验（use-live-guard）：给就绪态，选中直播的用例才开得出窗
      getFfmpegStatus: vi.fn(async () => ({
        ok: true,
        problem: null,
        directory: '/opt/ffmpeg',
        binaryPath: '/opt/ffmpeg/ffmpeg',
      })),
    },
  })

  directoryMock.find = async (userId: number) => options.directory?.[userId] ?? null
  const pages = options.livePages ?? [{ next: '0', liveList: [] }]
  let pageIndex = 0
  apisMock.lives = async (next: string) => {
    calls.livePages.push(next)
    const page = pages[Math.min(pageIndex, pages.length - 1)]
    pageIndex++
    return page
  }

  const { usePocketRooms } = await import('@renderer/composables/use-pocket-rooms')
  // 解锁表是模块级单例，跨用例存活：每个用例开头清空，还原成「进程刚起来」的状态
  const { clearSmallRoomUnlocks } = await import('@renderer/utils/small-room-unlock')
  clearSmallRoomUnlocks()
  // 大房间频道解析缓存同理（详情卡入口与临时房间共用，见 test/room-channel.test.ts）
  const { clearRoomChannelCache, resolveMemberRoomChannel } = await import('@renderer/services/room-channel')
  clearRoomChannelCache()
  for (const extra of extraScopes.splice(0))
    extra.stop()
  // 未读镜像也是模块级单例：清空后才建新实例，免得上个用例的未读影响本次排序
  const { markRoomRead, unreadCountOf, usePocketUnreadStore } = await import('@renderer/stores/pocket-unread')
  const { unreadRooms } = usePocketUnreadStore()
  unreadRooms.value = {}
  // 关注 / 屏蔽名单 store 同样是模块级单例，且 ensureLoaded 只灌一次：显式重灌，
  // 还原成「进程刚起来」的状态（否则上个用例的屏蔽名单会漏到本次）
  const { useBlockedMembersStore, useFollowedMembersStore } = await import('@renderer/stores/member-flags')
  const blockedStore = useBlockedMembersStore()
  await blockedStore.refreshBlockedMembers()
  await useFollowedMembersStore().refreshFollowedMembers()
  const scope = effectScope()
  const api = scope.run(() => usePocketRooms())!
  activeScope = scope
  return {
    api,
    calls,
    scope,
    unreadCountOf,
    markRoomRead,
    /** 模拟主进程未读广播（快照里只含 count > 0 的房间） */
    setUnread: (counts: Record<number, number>) => {
      unreadRooms.value = Object.fromEntries(
        Object.entries(counts).map(([userId, count]) => [
          userId,
          { count, bigCount: count, smallCount: 0, latestTime: 0 },
        ]),
      )
    },
    /** 详情卡入口显隐用的那条解析路径（与临时房间共用缓存） */
    resolveRoomChannel: resolveMemberRoomChannel,
    /**
     * 直接改屏蔽名单单例：模拟「在本页挂在 keep-alive 后台时，于成员页 / 直播页屏蔽了某人」。
     * 走 store 的响应式名单，watch(blockedMembers) 据此就地摘条目。
     */
    setBlocked: (userIds: number[]) => {
      blockedStore.blockedMembers.value = userIds.map(userId => ({
        userId,
        realName: `成员${userId}`,
        teamColor: '',
      }))
    },
    /** 再开一个 composable 实例：模拟页面层重建（实例换了，模块级单例状态应当留着） */
    newInstance: () => {
      const extra = effectScope()
      extraScopes.push(extra)
      return extra.run(() => usePocketRooms())!
    },
    /** 当前房间消息流的 [昵称, 正文, 时刻] 摘要 */
    digest: () => api.messages.value.map(item => [item.nick, item.text, item.msgTime]),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  activeScope?.stop()
  activeScope = null
  for (const extra of extraScopes.splice(0))
    extra.stop()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  authMock.setLoggedIn(true)
})

describe('use-pocket-rooms / 房间列表构建', () => {
  it('口袋关注 ∪ 本地关注，在直播的排前面，其余按昵称排序', async () => {
    const { api } = await setup({
      pocketIds: [10002, 10001],
      localFlags: [{ userId: 10003, realName: '丙', teamColor: '' }],
      livePages: [{ next: '0', liveList: [live('L1', 10003, '丙的电台'), live('L2', 10001, '甲的直播')] }],
      directory: {
        10001: { realName: '甲', avatar: '/a.jpg', teamName: 'TEAM SII', teamColor: '88ccff' },
        10002: { realName: '乙', avatar: '', teamName: 'TEAM NII', teamColor: 'ffcc88' },
        10003: { realName: '丙', avatar: '/c.jpg', teamName: 'TEAM HII', teamColor: 'ccff88' },
      },
    })
    await api.load()

    expect(api.rooms.value.map(room => [room.userId, room.nickname, !!room.live]))
      .toEqual([[10003, '丙', true], [10001, '甲', true], [10002, '乙', false]])
    // 详情由成员目录补全；目录查不到时昵称兜底
    expect(api.rooms.value[0].teamName).toBe('TEAM HII')
    expect(api.rooms.value[2].avatar).toBe('')
  })

  it('直播列表分页拉全：next 非 0 继续翻，关注成员在哪页都能匹配', async () => {
    const { api, calls } = await setup({
      pocketIds: [10002],
      livePages: [
        { next: '5', liveList: [live('L1', 999)] },
        { next: '0', liveList: [live('L2', 10002)] },
      ],
    })
    await api.load()

    expect(calls.livePages).toEqual(['0', '5'])
    expect(api.rooms.value[0].live?.liveId).toBe('L2')
  })

  it('目录查不到的成员用「口袋用户 N」兜底，不影响房间出现', async () => {
    const { api } = await setup({
      pocketIds: [777],
      livePages: [{ next: '0', liveList: [live('L9', 777, '神秘房间')] }],
    })
    await api.load()

    expect(api.rooms.value).toHaveLength(1)
    // 直播条目自带昵称时优先用它；目录与直播都没有才兜底
    expect(api.rooms.value[0].nickname).toBe('口袋昵称777')
  })

  it('未登录：不发任何请求，房间为空', async () => {
    authMock.setLoggedIn(false)
    const { api, calls } = await setup({ pocketIds: [1] })
    await api.load()

    expect(api.loggedIn.value).toBe(false)
    expect(api.rooms.value).toEqual([])
    expect(calls.pocketFollowedIds).toBe(0)
  })

  it('口袋关注拉取失败：降级为本地名单并给出提示', async () => {
    const { api } = await setup({
      pocketFollowFails: true,
      localFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await api.load()

    expect(api.pocketFollowError.value).toBe('登录已过期')
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
  })
})

describe('use-pocket-rooms / 屏蔽优先', () => {
  function blockFixture(blockedFlags: SetupOptions['blockedFlags']): SetupOptions {
    return {
      pocketIds: [10001, 10002],
      blockedFlags,
      directory: {
        10001: { realName: '甲', avatar: '', teamName: '', teamColor: '' },
        10002: { realName: '乙', avatar: '', teamName: '', teamColor: '' },
      },
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '甲的留言')] } },
        'ch-10002': { 0: { nextTime: 0, messages: [roomMsg('b', 200, '乙的留言')] } },
      },
    }
  }

  // 关注与屏蔽正交（见 use-member-actions）：账号关注照旧存在，但屏蔽的成员不进左列——
  // 顺带也就不必为它解析房间频道
  it('被屏蔽的成员不进左列，也不为它解析频道', async () => {
    const { api, calls } = await setup(blockFixture([{ userId: 10002, realName: '乙', teamColor: '' }]))
    await api.load()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
    expect(calls.channelFetched).toEqual([10001])
  })

  // 屏蔽入口在成员页 / 直播页 / 回放页，本页常挂在 keep-alive 后台：
  // 只靠 load() 过滤的话，切回来看到的还是旧列表
  it('屏蔽名单变化：条目就地摘除，正看着的成员右侧一并收起', async () => {
    const { api, setBlocked } = await setup(blockFixture([]))
    await api.load()
    await api.selectRoom(10002)
    expect(api.chatStatus.value).toBe('ready')

    setBlocked([10002])
    await nextTick()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
    expect(api.selectedUserId.value).toBeNull()
    expect(api.chatStatus.value).toBe('idle')
  })

  // 临时条目是用户从成员详情卡主动打开的，显式意图压过屏蔽
  it('临时房间不受屏蔽影响', async () => {
    const { api, setBlocked } = await setup({
      pocketIds: [10001],
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
      directory: { 10002: { realName: '乙', avatar: '', teamName: '', teamColor: '' } },
    })
    await api.load()
    expect(api.rooms.value).toEqual([])

    setBlocked([10001, 10002])
    await nextTick()
    expect(await api.openTemporaryRoom(10002)).toEqual({ ok: true })

    expect(api.rooms.value.map(room => [room.userId, !!room.temporary])).toEqual([[10002, true]])
  })
})

describe('use-pocket-rooms / 左列排序', () => {
  /**
   * 三个关注成员：昵称取「成员N」保证 localeCompare('zh') 结果确定（成员1 < 成员2 < 成员3），
   * 其中 10001 在直播 —— 用来验证「正在直播」压过未读这一档。
   */
  function sortFixture(): SetupOptions {
    return {
      pocketIds: [10001, 10002, 10003],
      livePages: [{ next: '0', liveList: [live('L1', 10001, '成员1开播了')] }],
      directory: {
        10001: { realName: '成员1', avatar: '', teamName: '', teamColor: '' },
        10002: { realName: '成员2', avatar: '', teamName: '', teamColor: '' },
        10003: { realName: '成员3', avatar: '', teamName: '', teamColor: '' },
      },
    }
  }

  it('「正在直播」压过未读排最前；未读只在非直播档内优先，再按昵称', async () => {
    const { api, setUnread } = await setup(sortFixture())
    await api.load()
    // 无未读：在直播的排前，其余按昵称
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10002, 10003])

    setUnread({ 10003: 5 })
    await nextTick()

    // 10001 在直播 → 仍居首；10003 有未读 → 在非直播档内压过 10002
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10003, 10002])
  })

  it('新消息到达：该房间在非直播档内浮到最前，压不过在播成员', async () => {
    const { api, setUnread } = await setup(sortFixture())
    await api.load()

    setUnread({ 10003: 1 })
    await nextTick()

    // 10001 在直播 → 仍居首；10003 新消息 → 非直播档内浮到 10002 之前
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10003, 10002])
  })

  // 回归：进房即 markRead（本地乐观清零 + 主进程广播）。若未读变化一律重排，
  // 用户刚点的那一条会在他眼皮底下被抽走，观感是「列表在躲我」。
  it('读掉未读不重排：条目留在原位，下一次自然排序才归位', async () => {
    const { api, markRoomRead, setUnread } = await setup(sortFixture())
    await api.load()
    setUnread({ 10003: 2 })
    await nextTick()
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10003, 10002])

    await markRoomRead(10003)
    await nextTick()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10003, 10002])

    // 手动刷新 = 一次自然排序：按当下未读归位
    await api.refreshRoomStatus()
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10002, 10003])
  })

  it('临时房间的置顶优先于未读：带未读的关注房间也不越位', async () => {
    const { api, setUnread } = await setup(sortFixture())
    await api.load()
    setUnread({ 10001: 9 })
    await nextTick()
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10002, 10003])

    await api.openTemporaryRoom(10004)

    expect(api.rooms.value.map(room => [room.userId, !!room.temporary]))
      .toEqual([[10004, true], [10001, false], [10002, false], [10003, false]])
  })
})

describe('use-pocket-rooms / 房间遍历与过滤', () => {
  it('解析不出频道的成员（无房间/房间已关闭）从列表过滤，并计入隐藏数', async () => {
    const { api, calls } = await setup({ pocketIds: [10001, 10002] })
    roomMock.channelFail.add(10002)
    await api.load()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
    expect(api.hiddenRoomCount.value).toBe(1)
    expect(calls.channelFetched).toEqual([10001, 10002])
  })

  it('频道为空（接口成功但无 serverId/channelId）按无房间过滤', async () => {
    const { api } = await setup({ pocketIds: [10001, 10002] })
    const channelMock = vi.mocked(window.mainAPI.pocketGetRoomChannel)
    channelMock.mockImplementationOnce(async () => ({ serverId: '', channelId: '' }))
    await api.load()

    // 10001 的第一次解析返回空频道（mockImplementationOnce 按调用序命中）
    expect(api.rooms.value).toHaveLength(1)
    expect(api.hiddenRoomCount.value).toBe(1)
  })

  it('能解析出频道的成员一律保留：不再按 channelStatus 过滤（语义不明，实测正常房间也非 0）', async () => {
    const { api } = await setup({ pocketIds: [10001, 10002] })
    await api.load()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001, 10002])
    expect(api.hiddenRoomCount.value).toBe(0)
  })

  it('全部解析异常（接口故障）：整页报错而不是展示空列表', async () => {
    const { api } = await setup({ pocketIds: [10001, 10002] })
    roomMock.channelFail.add(10001)
    roomMock.channelFail.add(10002)
    await api.load()

    expect(api.rooms.value).toEqual([])
    expect(api.loadError.value).toBe('频道解析失败')
    expect(api.loading.value).toBe(false)
  })

  it('token 失效：整页报错「登录已过期」', async () => {
    const { api } = await setup({ pocketIds: [10001] })
    const channelMock = vi.mocked(window.mainAPI.pocketGetRoomChannel)
    channelMock.mockImplementationOnce(async () => {
      throw new Error('登录已过期，请重新登录口袋48账号')
    })
    await api.load()

    expect(api.loadError.value).toBe('登录已过期，请重新登录口袋48账号')
    expect(api.rooms.value).toEqual([])
  })
})

describe('use-pocket-rooms / 左列最新消息预览', () => {
  it('首灌：批量 lastMsgList → 房间预览文案（含类型分发）', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001, 10002],
      lastMessages: [
        { channelId: 'ch-10001', msgContent: JSON.stringify({ messageType: 'TEXT', text: '大家晚安' }), msgTime: 300 },
        { channelId: 'ch-10002', msgContent: JSON.stringify({ messageType: 'IMAGE' }), msgTime: 200 },
      ],
    })
    await api.load()

    expect(calls.lastMessageFetched).toEqual([['srv-10001', 'srv-10002']])
    expect(api.rooms.value.map(room => [room.userId, room.preview])).toEqual([
      [10001, '大家晚安'],
      [10002, '[图片消息]'],
    ])
  })

  it('无预览的房间预览为空串', async () => {
    const { api } = await setup({ pocketIds: [10001] })
    await api.load()

    expect(api.rooms.value[0].preview).toBe('')
  })

  it('预览批量拉取失败：静默降级，房间照常可用', async () => {
    const { api } = await setup({ pocketIds: [10001] })
    vi.mocked(window.mainAPI.pocketGetRoomLastMessages).mockImplementationOnce(async () => {
      throw new Error('批量接口故障')
    })
    await api.load()

    expect(api.rooms.value).toHaveLength(1)
    expect(api.rooms.value[0].preview).toBe('')
    expect(api.loadError.value).toBe('')
  })

  it('选中房间轮询到新消息：左列预览即时更新', async () => {
    const { api } = await setup({
      pocketIds: [10001],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'first')] } } },
    })
    await api.load()
    await api.selectRoom(10001)

    const messagesMock = vi.mocked(window.mainAPI.pocketGetRoomMessages)
    messagesMock.mockImplementationOnce(async (_channelId: string, _serverId: string) => {
      return { nextTime: 0, messages: [roomMsg('b', 200, 'second')] }
    })
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.rooms.value[0].preview).toBe('second')
    expect(api.rooms.value[0].previewTime).toBe(200)
  })

  // 回归：本页曾只剩「重进页面 / 手动刷新」两条预览更新路径（60s 定时器在抽出共享直播
  // store 时被一并删掉），表现为未读角标照涨、左列文案不动。定时器现在驱动这个函数。
  it('refreshRoomPreviews：刷新非选中房间的预览，且不碰直播刷新态、不重复拉直播', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001, 10002],
      lastMessages: [
        { channelId: 'ch-10001', msgContent: '旧预览', msgTime: 100 },
        { channelId: 'ch-10002', msgContent: '旧预览', msgTime: 100 },
      ],
    })
    await api.load()
    await api.selectRoom(10001)

    vi.mocked(window.mainAPI.pocketGetRoomLastMessages).mockImplementationOnce(async () => [
      { channelId: 'ch-10002', starName: '乙', msgContent: '乙的新消息', msgTime: 500, unreadCount: null },
    ])
    await api.refreshRoomPreviews()

    // 非选中房间的预览也随批量快照更新（此前只有选中房间的 5s 轮询会更新它）
    expect(api.rooms.value.find(room => room.userId === 10002)?.preview).toBe('乙的新消息')
    // 只走批量预览接口，不经过 refreshRoomStatus —— 否则 liveRefreshing 每轮闪一下，
    // 刷新按钮（loading = loading || liveRefreshing）在无人操作时自己转圈
    expect(api.liveRefreshing.value).toBe(false)
    expect(calls.livePages).toHaveLength(1)
    // 一次刷新 = 一次批量请求（首灌一次 + 本次一次）
    expect(window.mainAPI.pocketGetRoomLastMessages).toHaveBeenCalledTimes(2)
  })

  // 选中房间的预览归 5s 轮询：批量接口有延迟，回写会把用户正看着的房间退回上一条。
  // 注意这里用 msgTime=0（真实回包形状）而不是更旧的 msgTime——后者该接口永远不会给，
  // 拿它做载荷只会为一层不存在的保护背书。
  it('refreshRoomPreviews：选中房间的预览由 5s 轮询维护，批量回包不回写', async () => {
    const { api } = await setup({
      pocketIds: [10001],
      lastMessages: [{ channelId: 'ch-10001', msgContent: '首灌快照', msgTime: 100 }],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'first')] } } },
    })
    await api.load()
    await api.selectRoom(10001)

    // 选中房间的 5s 轮询先拿到更新的消息（previewTime 推到 200）
    vi.mocked(window.mainAPI.pocketGetRoomMessages).mockImplementationOnce(async () => ({
      nextTime: 0,
      messages: [roomMsg('b', 200, 'second')],
    }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.rooms.value[0].previewTime).toBe(200)

    // 然后批量回包到位：文案不同（滞后快照），也不得回写选中房间
    vi.mocked(window.mainAPI.pocketGetRoomLastMessages).mockImplementationOnce(async () => [
      { channelId: 'ch-10001', starName: '甲', msgContent: '迟到的旧快照', msgTime: 0, unreadCount: null },
    ])
    await api.refreshRoomPreviews()

    expect(api.rooms.value[0].preview).toBe('second')
    expect(api.rooms.value[0].previewTime).toBe(200)
  })

  // 回归：批量预览接口拿不到真实 msgTime（恒为 0，见 pa-sign 的降级回包说明），
  // 时间守卫在这条链路上无从建立。旧守卫 `0 >= previewTime` 对「曾被 5s 轮询推高过水位」
  // 的房间永远不成立，表现为选中过一次之后该房文案冻结 —— 切走之后也不再更新。
  it('refreshRoomPreviews：msgTime=0 时仍更新「曾被轮询推高过水位」的非选中房间', async () => {
    const { api } = await setup({
      pocketIds: [10001, 10002],
      lastMessages: [
        { channelId: 'ch-10001', msgContent: '甲的首灌快照', msgTime: 0 },
        { channelId: 'ch-10002', msgContent: '乙的首灌快照', msgTime: 0 },
      ],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'first')] } } },
    })
    await api.load()
    await api.selectRoom(10001)

    // 选中期间 5s 轮询把 10001 的水位推到真实时间 200
    vi.mocked(window.mainAPI.pocketGetRoomMessages).mockImplementationOnce(async () => ({
      nextTime: 0,
      messages: [roomMsg('b', 200, 'second')],
    }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.rooms.value.find(room => room.userId === 10001)?.previewTime).toBe(200)

    // 切走：10001 成为非选中房间，预览改由批量接口维护
    await api.selectRoom(10002)

    vi.mocked(window.mainAPI.pocketGetRoomLastMessages).mockImplementationOnce(async () => [
      { channelId: 'ch-10001', starName: '甲', msgContent: '更新的新消息', msgTime: 0, unreadCount: null },
    ])
    await api.refreshRoomPreviews()

    const room = api.rooms.value.find(item => item.userId === 10001)
    // 批量快照不带时间（msgTime=0）但文案更新了：要能写进预览
    expect(room?.preview).toBe('更新的新消息')
    // 文案虽更新，本地真实水位不被 0 冲掉（供后续带真实时间的快照比较）
    expect(room?.previewTime).toBe(200)
  })
})

describe('use-pocket-rooms / 选中连房与消息流', () => {
  it('选中成员：解析频道并拉取消息，倒序返回翻转为时间升序', async () => {
    const { api, calls, digest } = await setup({
      pocketIds: [10001],
      roomPages: {
        'ch-10001': {
          0: {
            nextTime: 100,
            messages: [roomMsg('c', 300, ' newest '), roomMsg('b', 200, 'middle'), roomMsg('a', 100, 'oldest')],
          },
        },
      },
    })
    await api.load()
    await api.selectRoom(10001)

    expect(calls.channelFetched).toEqual([10001])
    expect(calls.messageFetched).toEqual([{ channelId: 'ch-10001', nextTime: 0, scope: 'member' }])
    expect(digest()).toEqual([['粉丝甲', 'oldest', 100], ['粉丝甲', 'middle', 200], ['粉丝甲', 'newest', 300]])
    expect(api.chatStatus.value).toBe('ready')
  })

  it('未开播成员：选中后同样加载房间消息（留言流与直播无关）', async () => {
    const { api, calls } = await setup({
      pocketIds: [10002],
      livePages: [{ next: '0', liveList: [] }],
      roomPages: { 'ch-10002': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '在吗')] } } },
    })
    await api.load()
    await api.selectRoom(10002)

    expect(api.rooms.value[0].live).toBeNull()
    expect(calls.channelFetched).toEqual([10002])
    expect(api.messages.value).toHaveLength(1)
    expect(api.chatStatus.value).toBe('ready')
  })

  it('频道解析失败（缓存未命中）：error 态 + 原因', async () => {
    const { api } = await setup({
      pocketIds: [10001],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'hi')] } } },
    })
    // 不走首灌直接选中：频道缓存未命中，走懒解析分支（首灌已解析的房间不会到这）
    roomMock.channelFail.add(10001)
    await api.selectRoom(10001)

    expect(api.chatStatus.value).toBe('error')
    expect(api.chatStatusText.value).toBe('频道解析失败')
  })

  it('消息拉取失败：error 态，切走再切回可重试', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'hi')] } } },
    })
    await api.load()
    roomMock.messageFail.add('ch-10001')
    await api.selectRoom(10001)
    expect(api.chatStatus.value).toBe('error')

    roomMock.messageFail.clear()
    await api.selectRoom(10002)
    await api.selectRoom(10001)
    expect(api.chatStatus.value).toBe('ready')
    // 频道在首灌遍历时已全部解析并缓存，选中不再重复解析
    expect(calls.channelFetched).toEqual([10001, 10002])
  })

  it('频道解析结果按成员缓存：切回不重复请求', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001, 10002],
    })
    await api.load()
    await api.selectRoom(10001)
    await api.selectRoom(10002)
    await api.selectRoom(10001)

    expect(calls.channelFetched).toEqual([10001, 10002])
  })

  it('轮询增量：只追加新消息，已见消息不重复插入', async () => {
    const { api, calls, digest } = await setup({
      pocketIds: [10001],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'first')] } } },
    })
    await api.load()
    await api.selectRoom(10001)
    expect(digest()).toEqual([['粉丝甲', 'first', 100]])

    // 轮询回包：旧消息 + 一条新的（Once 实现同样要记 calls）
    const messagesMock = vi.mocked(window.mainAPI.pocketGetRoomMessages)
    messagesMock.mockImplementationOnce(async (_channelId: string, _serverId: string, nextTime = 0) => {
      calls.messageFetched.push({ channelId: 'ch-10001', nextTime, scope: 'member' })
      return {
        nextTime: 0,
        messages: [roomMsg('c', 300, 'third'), roomMsg('a', 100, 'first'), roomMsg('b', 200, 'second')],
      }
    })
    await vi.advanceTimersByTimeAsync(5000)

    expect(calls.messageFetched).toHaveLength(2)
    expect(digest()).toEqual([
      ['粉丝甲', 'first', 100],
      ['粉丝甲', 'second', 200],
      ['粉丝甲', 'third', 300],
    ])
  })

  it('加载更早历史：prepend 到消息流头部，游标到头后禁用', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001],
      roomPages: {
        'ch-10001': {
          0: { nextTime: 100, messages: [roomMsg('b', 200, 'newer'), roomMsg('a', 100, 'older')] },
          100: { nextTime: 50, messages: [roomMsg('z', 50, 'oldest')] },
          50: { nextTime: 0, messages: [] },
        },
      },
    })
    await api.load()
    await api.selectRoom(10001)
    expect(api.messages.value.map(item => item.text)).toEqual(['older', 'newer'])
    expect(api.historyExhausted.value).toBe(false)

    await api.loadMoreHistory()
    expect(api.messages.value.map(item => item.text)).toEqual(['oldest', 'older', 'newer'])
    expect(calls.messageFetched.at(-1)).toEqual({ channelId: 'ch-10001', nextTime: 100, scope: 'member' })

    // 更早一页 nextTime=0：到头
    await api.loadMoreHistory()
    expect(api.historyExhausted.value).toBe(true)
  })

  it('切人：清空消息流并重新加载新房间', async () => {
    const { api, calls, digest } = await setup({
      pocketIds: [10001, 10002],
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '甲房间')] } },
        'ch-10002': { 0: { nextTime: 0, messages: [roomMsg('b', 100, '乙房间')] } },
      },
    })
    await api.load()
    await api.selectRoom(10001)
    expect(digest()).toEqual([['粉丝甲', '甲房间', 100]])

    await api.selectRoom(10002)
    expect(digest()).toEqual([['粉丝甲', '乙房间', 100]])
    expect(calls.messageFetched.map(item => item.channelId)).toEqual(['ch-10001', 'ch-10002'])
  })

  it('消息范围切换：重拉当前房间并换接口；官方账号发言只在「全部消息」出现', async () => {
    // homeowner 接口会混入官方系统账号 121569667 的发言（真实行为）
    const officialMsg = {
      ...roomMsg('a', 100, '官方通知', '口袋官方'),
      extInfo: JSON.stringify({ user: { userId: 121569667, nickName: '口袋官方', level: 0 } }),
    }
    const { api, calls, digest } = await setup({
      pocketIds: [10001],
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('b', 200, '成员发言'), officialMsg] } },
      },
    })
    await api.load()
    await api.selectRoom(10001)
    // 默认 member 档：官方系统账号被过滤
    expect(digest()).toEqual([['粉丝甲', '成员发言', 200]])

    api.messageScope.value = 'all'
    // watch 回调里 selectRoom 有多次 await，须把微任务队列冲干净再断言
    await vi.advanceTimersByTimeAsync(0)
    // 同频道两接口口径不同，切档即重拉；游标/去重键随 clearChat 复位
    expect(api.chatStatus.value).toBe('ready')
    expect(digest()).toEqual([
      ['口袋官方', '官方通知', 100],
      ['粉丝甲', '成员发言', 200],
    ])
    expect(calls.messageFetched.map(item => item.scope)).toEqual(['member', 'all'])
  })

  it('小房间视图下切消息范围：留在小房间，只换拉取口径（回归：原先被弹回大房间）', async () => {
    const { api, calls, digest } = await setup({
      pocketIds: [10001],
      smallChannels: { 10001: { serverId: 'srv-10001', channelId: 'ch-10001-small' } },
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '大房间留言')] } },
        'ch-10001-small': { 0: { nextTime: 0, messages: [roomMsg('s', 300, '小房间密语')] } },
      },
    })
    await api.load()
    await api.selectRoom(10001)
    // 小房间频道是 selectRoom 里 fire-and-forget 发现的，冲一遍微任务
    await vi.advanceTimersByTimeAsync(0)
    expect(api.smallChannel.value?.channelId).toBe('ch-10001-small')

    await api.setViewMode('small')
    expect(api.viewMode.value).toBe('small')
    expect(digest()).toEqual([['粉丝甲', '小房间密语', 300]])

    api.messageScope.value = 'all'
    await vi.advanceTimersByTimeAsync(0)

    // 范围切换只换口径：视图仍在小房间，拉的也还是小房间频道（原先走 selectRoom 会被复位）
    expect(api.viewMode.value).toBe('small')
    expect(digest()).toEqual([['粉丝甲', '小房间密语', 300]])
    expect(calls.messageFetched.map(item => [item.channelId, item.scope])).toEqual([
      ['ch-10001', 'member'],
      ['ch-10001-small', 'member'],
      ['ch-10001-small', 'all'],
    ])
  })

  it('小房间被暗号拦下时切消息范围：仍留在小房间（暗号层展示，不发小房间消息请求）', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001],
      smallChannels: { 10001: { serverId: 'srv-10001', channelId: 'ch-10001-small' } },
      roomQuestions: { 'ch-10001-small': { questionId: 'q1', question: '暗号是什么？' } },
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '大房间留言')] } } },
    })
    await api.load()
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.smallRequiresAnswer.value).toBe(true)

    await api.setViewMode('small')
    expect(api.viewMode.value).toBe('small')
    expect(api.smallLocked.value).toBe(true)

    api.messageScope.value = 'all'
    await vi.advanceTimersByTimeAsync(0)

    expect(api.viewMode.value).toBe('small')
    expect(api.smallLocked.value).toBe(true)
    // 锁定态本来就不拉小房间消息；切范围同样不该回落大房间重拉
    expect(calls.messageFetched.map(item => item.channelId)).toEqual(['ch-10001'])
  })

  /** 小房间暗号用例的公共假环境：10001 的小房间被暗号拦着（答案 open-sesame），10002 另有暗号 */
  function smallRoomAnswerFixture() {
    return {
      pocketIds: [10001, 10002],
      smallChannels: {
        10001: { serverId: 'srv-10001', channelId: 'ch-10001-small' },
        10002: { serverId: 'srv-10002', channelId: 'ch-10002-small' },
      },
      roomQuestions: {
        'ch-10001-small': { questionId: 'q1', question: '暗号是什么？' },
        'ch-10002-small': { questionId: 'q2', question: '暗号是什么？' },
      },
      roomAnswers: { 'ch-10001-small': 'open-sesame' },
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '大房间留言')] } },
        'ch-10002': { 0: { nextTime: 0, messages: [roomMsg('b', 110, '另一人留言')] } },
        'ch-10001-small': { 0: { nextTime: 0, messages: [roomMsg('s', 300, '小房间密语')] } },
      },
    } satisfies SetupOptions
  }

  it('解锁一次后同会话内免校验：判错不放行、切走成员再回来不重锁', async () => {
    const { api, calls, digest } = await setup(smallRoomAnswerFixture())
    await api.load()
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)
    await api.setViewMode('small')
    expect(api.smallLocked.value).toBe(true)

    // 判错不放行，也不写进解锁表
    expect((await api.unlockSmall('乱猜')).ok).toBe(false)
    expect(api.smallLocked.value).toBe(true)
    // 判对即解锁并当场拉出小房间消息
    expect((await api.unlockSmall('open-sesame')).ok).toBe(true)
    expect(api.smallLocked.value).toBe(false)
    expect(digest()).toEqual([['粉丝甲', '小房间密语', 300]])

    // 切到别的成员（其小房间另有暗号）再切回来：仍免校验，不该再要一次
    await api.selectRoom(10002)
    await vi.advanceTimersByTimeAsync(0)
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)
    await api.setViewMode('small')
    expect(api.smallLocked.value).toBe(false)
    expect(calls.answerChecks.map(item => item.answer)).toEqual(['乱猜', 'open-sesame'])
  })

  it('页面层重建（Rooms 实例重挂载）后仍免校验：解锁态活在模块级单例', async () => {
    const { api, calls, newInstance } = await setup(smallRoomAnswerFixture())
    await api.load()
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)
    await api.setViewMode('small')
    expect((await api.unlockSmall('open-sesame')).ok).toBe(true)

    // App.vue 捕获渲染错误会 pageLayerKey += 1 重建整棵 <KeepAlive>：实例是新的，进程没重启
    const fresh = newInstance()
    await fresh.load()
    await fresh.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)
    await fresh.setViewMode('small')
    expect(fresh.smallLocked.value).toBe(false)
    expect(fresh.messages.value.map(item => [item.nick, item.text, item.msgTime]))
      .toEqual([['粉丝甲', '小房间密语', 300]])
    // 全程只有第一次那一声校验
    expect(calls.answerChecks.map(item => item.answer)).toEqual(['open-sesame'])
  })
})

describe('use-pocket-rooms / 临时房间（成员详情卡入口）', () => {
  /** 详情卡入口带进来的成员：10002 未关注、有大房间；10001 是已关注的且在直播 */
  function tempFixture(pocketIds: number[] = [10001]): SetupOptions {
    return {
      pocketIds,
      livePages: [{ next: '0', liveList: [live('L1', 10001, '甲开播了')] }],
      directory: {
        10001: { realName: '甲', avatar: '/a.jpg', teamName: 'TEAM SII', teamColor: '88ccff' },
        10002: { realName: '乙', avatar: '/b.jpg', teamName: 'TEAM NII', teamColor: 'ffcc88' },
      },
      roomPages: {
        'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, '甲的留言')] } },
        'ch-10002': { 0: { nextTime: 0, messages: [roomMsg('t', 300, '乙的留言')] } },
      },
    }
  }

  it('打开未关注成员的大房间：左列插入标记临时的条目并置顶、自动选中，不写关注名单', async () => {
    const { api, calls, digest } = await setup(tempFixture())
    await api.load()
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])

    const result = await api.openTemporaryRoom(10002)

    expect(result).toEqual({ ok: true })
    // 置顶：临时房间排在「正在直播的关注房间」前面
    expect(api.rooms.value.map(room => [room.userId, !!room.temporary, room.nickname]))
      .toEqual([[10002, true, '乙'], [10001, false, '甲']])
    expect(api.selectedRoom.value?.userId).toBe(10002)
    expect(api.chatStatus.value).toBe('ready')
    expect(digest()).toEqual([['粉丝甲', '乙的留言', 300]])
    // 关注的那位在首灌遍历时解析，临时这位按需解析
    expect(calls.channelFetched).toEqual([10001, 10002])
  })

  it('已在关注名单里的成员：不建第二条条目，直接选中关注房间', async () => {
    const { api } = await setup(tempFixture())
    await api.load()

    expect(await api.openTemporaryRoom(10001)).toEqual({ ok: true })

    expect(api.rooms.value.map(room => [room.userId, !!room.temporary])).toEqual([[10001, false]])
    expect(api.temporaryRoom.value).toBeNull()
    expect(api.selectedRoom.value?.userId).toBe(10001)
  })

  it('与详情卡入口共用频道解析：先探测过的成员打开时不再重复请求', async () => {
    const { api, calls, resolveRoomChannel } = await setup(tempFixture())
    await api.load()

    // 详情卡打开该成员时已探过一次（入口显隐用）
    await resolveRoomChannel(10002)
    await api.openTemporaryRoom(10002)

    expect(calls.channelFetched.filter(id => id === 10002)).toHaveLength(1)
  })

  it('查不到大房间：如实返回失败，不插入条目', async () => {
    const { api } = await setup(tempFixture([]))
    await api.load()
    vi.mocked(window.mainAPI.pocketGetRoomChannel)
      .mockImplementationOnce(async () => ({ serverId: '', channelId: '' }))

    const result = await api.openTemporaryRoom(10002)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('未查询到该成员的大房间')
    expect(api.rooms.value).toEqual([])
    expect(api.selectedRoom.value).toBeNull()
  })

  it('未登录：拒绝打开且不发频道请求', async () => {
    authMock.setLoggedIn(false)
    const { api, calls } = await setup(tempFixture())

    const result = await api.openTemporaryRoom(10002)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('登录口袋48账号后才能查看房间')
    expect(calls.channelFetched).toEqual([])
    expect(api.rooms.value).toEqual([])
  })

  it('刷新重建列表后临时条目仍在，选中不被打断', async () => {
    const { api, digest } = await setup(tempFixture())
    await api.load()
    await api.openTemporaryRoom(10002)

    await api.load()

    expect(api.rooms.value.map(room => [room.userId, !!room.temporary])).toEqual([[10002, true], [10001, false]])
    expect(api.temporaryRoom.value?.userId).toBe(10002)
    expect(api.selectedRoom.value?.userId).toBe(10002)
    expect(digest()).toEqual([['粉丝甲', '乙的留言', 300]])
  })

  it('关闭临时房间：撤掉条目并清空右侧，之后刷新也不会补回来', async () => {
    const { api } = await setup(tempFixture())
    await api.load()
    await api.openTemporaryRoom(10002)

    api.closeTemporaryRoom()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
    expect(api.temporaryRoom.value).toBeNull()
    expect(api.selectedRoom.value).toBeNull()
    expect(api.messages.value).toEqual([])

    await api.load()
    expect(api.rooms.value.map(room => room.userId)).toEqual([10001])
  })

  it('临时房间的成员随后被关注：临时条目就地撤掉，只留关注条目且选中不断', async () => {
    const pocketIds = [10001]
    const { api } = await setup(tempFixture(pocketIds))
    await api.load()
    await api.openTemporaryRoom(10002)
    expect(api.temporaryRoom.value?.userId).toBe(10002)

    // 在别的页面关注了 TA：口袋关注名单变化，房间页重新首灌
    pocketIds.push(10002)
    await api.load()

    expect(api.rooms.value.map(room => [room.userId, !!room.temporary]))
      .toEqual([[10001, false], [10002, false]])
    expect(api.temporaryRoom.value).toBeNull()
    expect(api.selectedRoom.value?.userId).toBe(10002)
  })
})

describe('use-pocket-rooms / 刷新与卸载', () => {
  it('refreshRoomStatus 只补直播状态与预览：保留选中与消息流', async () => {
    const { api, digest } = await setup({
      pocketIds: [10001, 10002],
      livePages: [{ next: '0', liveList: [] }],
      lastMessages: [{ channelId: 'ch-10001', msgContent: '旧预览', msgTime: 100 }],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'keep me')] } } },
    })
    await api.load()
    await api.selectRoom(10001)

    apisMock.lives = async () => ({ next: '0', liveList: [live('L1', 10002, '乙开播了')] })
    const lastMessagesMock = vi.mocked(window.mainAPI.pocketGetRoomLastMessages)
    lastMessagesMock.mockImplementationOnce(async () => [
      { channelId: 'ch-10002', starName: '乙', msgContent: '乙的最新消息', msgTime: 500, unreadCount: null },
    ])
    await api.refreshRoomStatus()

    expect(api.rooms.value.map(room => room.userId)).toEqual([10002, 10001])
    expect(digest()).toEqual([['粉丝甲', 'keep me', 100]])
    expect(api.selectedRoom.value?.userId).toBe(10001)
    // 预览按 channelId 更新：10002 有新预览，10001 无更早快照不覆盖（空快照不进 map 的逻辑由 fetchLastMessageMap 兜底）
    expect(api.rooms.value.find(room => room.userId === 10002)?.preview).toBe('乙的最新消息')
  })

  it('作用域销毁：停止轮询，不再发请求', async () => {
    const { api, calls, scope } = await setup({
      pocketIds: [10001],
      roomPages: { 'ch-10001': { 0: { nextTime: 0, messages: [roomMsg('a', 100, 'hi')] } } },
    })
    await api.load()
    await api.selectRoom(10001)
    scope.stop()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(calls.messageFetched).toHaveLength(1)
    expect(calls.livePages).toHaveLength(1)
  })

  /**
   * 直播分享卡视图模型（只挑 openSharedLive 会读的字段）。
   * 中间对象显式标注而不是直接 return 字面量：展开 Partial 会把未写出的必填字段
   * （imageWidth / imageHeight / videoWidth / videoHeight）退化成可选。
   */
  function shareMsg(overrides: Partial<PocketRoomMessageView> = {}): PocketRoomMessageView {
    const base: PocketRoomMessageView = {
      id: 'm1',
      kind: 'live',
      text: '[直播分享] 小猫咪来了',
      userId: '1',
      nick: '成员甲',
      avatar: '',
      level: 0,
      isMember: true,
      msgTime: 1728000000000,
      quote: null,
      imageUrl: '',
      imageWidth: 0,
      imageHeight: 0,
      audioUrl: '',
      videoUrl: '',
      videoPoster: '',
      videoWidth: 0,
      videoHeight: 0,

      liveId: 'L9',
      liveType: 2,
      liveMode: 0,
      liveStartTime: 1728000000000,
      liveCover: '',
      liveIsPlayback: false,
    }
    return { ...base, ...overrides }
  }

  it('openSharedLive：liveId 在播 → 直播播放窗（kind=live）', async () => {
    // 在播判定来自首灌拉的直播列表：liveId 出现在列表里才走直播窗
    const { api, calls } = await setup({
      pocketIds: [10001],
      livePages: [{ next: '0', liveList: [live('L9', 10001)] }],
    })
    await api.load()
    api.openSharedLive(shareMsg())
    // openLive 保持同步签名，开窗前的 FFmpeg 校验在内部异步完成，这里等它跑完
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.openFloatWindow).toHaveLength(1)
    expect(calls.openFloatWindow[0][0]).toBe('live')
    expect(calls.openFloatWindow[0][1]).toMatchObject({
      liveId: 'L9',
      title: '小猫咪来了',
      nickname: '成员甲',
      liveType: 2,
      startTime: 1728000000000,
    })
  })

  it('openSharedLive：liveId 不在播 → 回放播放窗（kind=playback，yaya_msg 同款选路）', async () => {
    // 分享消息不带可靠回放标记，以当前直播列表为准：不在播即回放
    const { api, calls } = await setup({ pocketIds: [10001] })
    await api.load()
    api.openSharedLive(shareMsg())

    expect(calls.openFloatWindow).toHaveLength(1)
    expect(calls.openFloatWindow[0][0]).toBe('playback')
  })

  it('openSharedLive：liveId 缺失（未解析到）时不开窗', async () => {
    const { api, calls } = await setup({ pocketIds: [10001] })
    await api.load()
    api.openSharedLive(shareMsg({ liveId: '', liveType: 0, liveStartTime: 0 }))

    expect(calls.openFloatWindow).toHaveLength(0)
  })

  it('openSharedLive：回放分享走回放播放窗（kind=playback）', async () => {
    const { api, calls } = await setup({ pocketIds: [10001] })
    await api.load()
    api.openSharedLive(shareMsg({ liveIsPlayback: true }))

    expect(calls.openFloatWindow).toHaveLength(1)
    expect(calls.openFloatWindow[0][0]).toBe('playback')
  })

  it('频道名：取服务端给的 channelName（页签显示真实名称的来源）', async () => {
    const { api, calls } = await setup({
      pocketIds: [10001],
      serverChannels: {
        'srv-10001': [
          { channelId: 'ch-10001', channelName: '小晴的房间' },
          { channelId: 'ch-small', channelName: '悄悄话频道' },
        ],
      },
    })
    await api.load()
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)

    // 一次请求覆盖该 server 下全部频道
    expect(calls.serverChannelsFetched).toEqual(['srv-10001'])
    expect(api.roomChannelName.value).toBe('小晴的房间')
  })

  it('频道名：接口没给名称时留空（渲染层回退通用名）', async () => {
    const { api } = await setup({ pocketIds: [10001] })
    await api.load()
    await api.selectRoom(10001)
    await vi.advanceTimersByTimeAsync(0)

    expect(api.roomChannelName.value).toBe('')
  })
})
