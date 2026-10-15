import type { PocketRoomMessageView } from '../src/renderer/src/utils/pocket-room-message'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

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

interface SetupOptions {
  /** 口袋账号关注 ID */
  pocketIds?: number[]
  /** 本地关注名单（主进程 getMemberFlags 解析结果） */
  localFlags?: Array<{ userId: number, realName: string, teamColor: string }>
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
}

async function setup(options: SetupOptions = {}) {
  const calls = {
    pocketFollowedIds: 0,
    livePages: [] as string[],
    channelFetched: [] as number[],
    lastMessageFetched: [] as string[][],
    messageFetched: [] as Array<{ channelId: string, nextTime: number, scope: 'member' | 'all' }>,
    openFloatWindow: [] as unknown[],
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
      getMemberFlags: vi.fn(async () => options.localFlags ?? []),
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
      openFloatWindow: vi.fn(async (kind: string, payload: unknown) => {
        calls.openFloatWindow.push([kind, payload])
      }),
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
  const scope = effectScope()
  const api = scope.run(() => usePocketRooms())!
  activeScope = scope
  return {
    api,
    calls,
    scope,
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
      { channelId: 'ch-10002', starName: '乙', msgContent: '乙的最新消息', msgTime: 500 },
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

  /** 直播分享卡视图模型（只挑 openSharedLive 会读的字段） */
  function shareMsg(overrides: Partial<PocketRoomMessageView> = {}): PocketRoomMessageView {
    return {
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
      audioUrl: '',
      videoUrl: '',
      videoPoster: '',

      liveId: 'L9',
      liveType: 2,
      liveMode: 0,
      liveStartTime: 1728000000000,
      liveCover: '',
      liveIsPlayback: false,
      ...overrides,
    }
  }

  it('openSharedLive：liveId 在播 → 直播播放窗（kind=live）', async () => {
    // 在播判定来自首灌拉的直播列表：liveId 出现在列表里才走直播窗
    const { api, calls } = await setup({
      pocketIds: [10001],
      livePages: [{ next: '0', liveList: [live('L9', 10001)] }],
    })
    await api.load()
    api.openSharedLive(shareMsg())

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
})
