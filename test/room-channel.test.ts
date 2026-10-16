/**
 * services/room-channel：大房间频道的渲染层解析缓存。
 *
 * 为什么盯这条：成员详情卡的入口显隐与房间页的临时房间都读它，缓存语义错一次
 * 就是「明明有房间却不给入口」或者「点进去扑空」。核心边界是
 * 「不可判定」（未登录 / 接口故障）与「确认没有大房间」不能混为一谈：
 * 前者一律不许落缓存，否则登录后那个入口再也长不出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRoomChannelCache, resolveMemberRoomChannel } from '../src/renderer/src/services/room-channel'

const mocks = vi.hoisted(() => ({
  /** 登录态镜像（mock 工厂里赋值） */
  state: null as any,
  refreshCalls: 0,
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
  mocks.state = state
  return {
    pocketAuthState: state,
    refreshPocketAuthState: async () => {
      mocks.refreshCalls++
      return state.value
    },
  }
})

/** 装一个假主进程频道接口，返回「调用过的 userId」流水 */
function stubChannel(impl: (userId: number) => Promise<{ serverId: string, channelId: string }>) {
  const calls: number[] = []
  vi.stubGlobal('window', {
    mainAPI: {
      pocketGetRoomChannel: vi.fn(async (userId: number) => {
        calls.push(userId)
        return impl(userId)
      }),
    },
  })
  return calls
}

/** 默认实装：任何人都有 `srv-N / ch-N` 的房间 */
function everyHasRoom(userId: number) {
  return Promise.resolve({ serverId: `srv-${userId}`, channelId: `ch-${userId}` })
}

beforeEach(() => {
  clearRoomChannelCache()
  mocks.refreshCalls = 0
  mocks.state.value = {
    loggedIn: true,
    nickname: '',
    avatar: '',
    mobileMasked: '',
    plainFallback: false,
    savedAt: 0,
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('room-channel / 大房间频道解析缓存', () => {
  it('解析成功即入缓存：同一个人只打一次接口', async () => {
    const calls = stubChannel(everyHasRoom)

    expect(await resolveMemberRoomChannel(10001)).toEqual({ serverId: 'srv-10001', channelId: 'ch-10001' })
    expect(await resolveMemberRoomChannel(10001)).toEqual({ serverId: 'srv-10001', channelId: 'ch-10001' })
    expect(calls).toEqual([10001])
  })

  it('并发取用只打一次接口（详情卡连点 / 与房间页同时取用）', async () => {
    const calls = stubChannel(everyHasRoom)

    const [first, second] = await Promise.all([
      resolveMemberRoomChannel(10001),
      resolveMemberRoomChannel(10001),
    ])

    expect(first).toEqual(second)
    expect(calls).toEqual([10001])
  })

  it('接口成功但没给频道：确认「没有大房间」，入缓存不重复请求', async () => {
    const calls = stubChannel(async () => ({ serverId: '', channelId: '' }))

    expect(await resolveMemberRoomChannel(10001)).toBeNull()
    expect(await resolveMemberRoomChannel(10001)).toBeNull()
    expect(calls).toEqual([10001])
  })

  it('未登录：不查接口也不落缓存，登录后仍能查出来', async () => {
    mocks.state.value = { ...mocks.state.value, loggedIn: false }
    const calls = stubChannel(everyHasRoom)

    expect(await resolveMemberRoomChannel(10001)).toBeNull()
    expect(calls).toEqual([])
    // 未登录要先确认一次登录态（冷启动首帧的镜像还是「未登录」初值）
    expect(mocks.refreshCalls).toBe(1)

    // 若上一步把 null 落进了缓存，这里会永远拿不到——入口也就再也不出现
    mocks.state.value = { ...mocks.state.value, loggedIn: true }
    expect(await resolveMemberRoomChannel(10001)).toEqual({ serverId: 'srv-10001', channelId: 'ch-10001' })
    expect(calls).toEqual([10001])
  })

  it('接口故障：按「查不到」降级且不落缓存，下次调用重试', async () => {
    const calls: number[] = []
    let failing = true
    vi.stubGlobal('window', {
      mainAPI: {
        pocketGetRoomChannel: vi.fn(async (userId: number) => {
          calls.push(userId)
          if (failing)
            throw new Error('接口故障')
          return { serverId: `srv-${userId}`, channelId: `ch-${userId}` }
        }),
      },
    })

    expect(await resolveMemberRoomChannel(10001)).toBeNull()

    failing = false
    expect(await resolveMemberRoomChannel(10001)).toEqual({ serverId: 'srv-10001', channelId: 'ch-10001' })
    expect(calls).toEqual([10001, 10001])
  })

  it('userId 缺失或脏值：不发请求，直接判不可用', async () => {
    const calls = stubChannel(everyHasRoom)

    expect(await resolveMemberRoomChannel(undefined)).toBeNull()
    expect(await resolveMemberRoomChannel(null)).toBeNull()
    expect(await resolveMemberRoomChannel('123abc')).toBeNull()
    expect(await resolveMemberRoomChannel('')).toBeNull()
    expect(calls).toEqual([])
  })
})
