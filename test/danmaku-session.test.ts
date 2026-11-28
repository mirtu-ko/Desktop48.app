import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupDanmakuSessions,
  handleDanmakuStart,
  handleDanmakuStop,
} from '../src/main/bilibili/danmaku-session'
import {
  cleanupPocketDanmakuSessions,
  handlePocketDanmakuStart,
  handlePocketDanmakuStop,
  resetPocketDanmakuSessions,
} from '../src/main/pocket48/pocket-danmaku'

/**
 * 直播双源弹幕会话层（bilibili/danmaku-session.ts & pocket48/pocket-danmaku.ts）：
 * 聚焦订阅者 destroyed 监听摘除、并发握手防重连覆盖与会话清理边界。
 */

const { wsMock, nimMock, authMock, sendMock } = vi.hoisted(() => ({
  wsMock: {
    instances: [] as Array<{
      url: string
      readyState: number
      closeCalls: number
    }>,
  },
  nimMock: {
    instances: [] as Array<{
      options: Record<string, unknown>
      connectCalls: number
      destroyCalls: number
    }>,
    connectImpl: null as null | (() => Promise<void>),
  },
  authMock: {
    credentialsImpl: null as null | (() => Promise<{ accid: string, token: string }>),
  },
  sendMock: {
    calls: [] as unknown[][],
  },
}))

vi.mock('ws', () => {
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    url: string
    readyState = FakeWebSocket.OPEN
    closeCalls = 0

    constructor(url: string) {
      this.url = url
      wsMock.instances.push(this)
    }

    on(): this {
      return this
    }

    send(): void {}

    close(): void {
      this.closeCalls++
      this.readyState = FakeWebSocket.CLOSED
    }
  }
  return { default: FakeWebSocket }
})

vi.mock('../src/main/pocket48/nim-chatroom', () => ({
  NimChatroomClient: class {
    options: Record<string, unknown>
    connectCalls = 0
    destroyCalls = 0

    constructor(options: Record<string, unknown>) {
      this.options = options
      nimMock.instances.push(this)
    }

    async connect(): Promise<void> {
      this.connectCalls++
      if (nimMock.connectImpl)
        return nimMock.connectImpl()
    }

    destroy(): void {
      this.destroyCalls++
    }
  },
}))

vi.mock('../src/main/pocket48/pocket-auth', () => ({
  IM_APP_KEY: 'fixed-app-key',
  getImCredentials: async () => (
    authMock.credentialsImpl
      ? authMock.credentialsImpl()
      : { accid: 'acc-1', token: 'im-token' }
  ),
  getRoomSenderProfile: async () => ({
    userId: '1',
    nickname: 'me',
    avatar: '',
    level: 1,
    roleId: 0,
    vip: false,
    pfUrl: '',
    teamLogo: '',
    badge: [],
  }),
}))

vi.mock('../src/main/pocket48/client-profile', () => ({
  nimIdentity: () => ({ sdkVersion: 92110, packageName: 'com.seine48.app' }),
  POCKET_CLIENT: { appInfo: () => ({}) },
  pocketDeviceId: () => 'dev-1',
}))

vi.mock('../src/main/ipc/send', () => ({
  sendIpc: (...args: unknown[]) => {
    sendMock.calls.push(args)
  },
}))

type FakeSender = WebContents & {
  listenerCount: () => number
  markDestroyed: () => void
}

function fakeSender(): FakeSender {
  let destroyed = false
  const listeners = new Set<() => void>()
  const sender = {
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed')
        listeners.add(listener)
    },
    removeListener: (event: string, listener: () => void) => {
      if (event === 'destroyed')
        listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
    markDestroyed: () => {
      destroyed = true
      for (const listener of [...listeners])
        listener()
      listeners.clear()
    },
  }
  return sender as unknown as FakeSender
}

function mockBilibiliFetch(options: { onGetInfo?: () => Promise<void> } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/room/v1/Room/get_info')) {
      await options.onGetInfo?.()
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { room_id: 21452505 } }) }
    }
    if (url.includes('/x/frontend/finger/spi'))
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { b_3: 'buvid-test' } }) }
    if (url.includes('/x/web-interface/nav')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        }),
      }
    }
    if (url.includes('getDanmuInfo')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            token: 'danmu-token',
            host_list: [{ host: 'broadcastlv.chat.bilibili.com', wss_port: 443 }],
          },
        }),
      }
    }
    throw new Error(`unexpected fetch url: ${url}`)
  }))
}

beforeEach(() => {
  wsMock.instances = []
  nimMock.instances = []
  nimMock.connectImpl = null
  authMock.credentialsImpl = null
  sendMock.calls = []
})

afterEach(() => {
  cleanupDanmakuSessions()
  cleanupPocketDanmakuSessions()
  vi.unstubAllGlobals()
})

describe('bilibili/danmaku-session', () => {
  it('显式退订时同步摘除 destroyed 监听，反复启停不累积', async () => {
    mockBilibiliFetch()
    const sender = fakeSender()

    expect(await handleDanmakuStart(48, sender)).toBe(true)
    expect(sender.listenerCount()).toBe(1)

    handleDanmakuStop(48, sender)
    expect(sender.listenerCount()).toBe(0)
    expect(wsMock.instances[0].closeCalls).toBe(1)

    expect(await handleDanmakuStart(48, sender)).toBe(true)
    expect(sender.listenerCount()).toBe(1)
    handleDanmakuStop(48, sender)
    expect(sender.listenerCount()).toBe(0)
  })

  it('并发握手同一房间时复用已入册会话，不覆盖也不建第二条连接', async () => {
    let releaseFirst!: () => void
    let callIndex = 0
    mockBilibiliFetch({
      onGetInfo: () => {
        callIndex++
        if (callIndex === 1) {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve()
      },
    })

    const winA = fakeSender()
    const winB = fakeSender()

    const firstStart = handleDanmakuStart(48, winA)
    const secondStart = handleDanmakuStart(48, winB)

    // 第二个先完成握手并建连，再放行第一个
    expect(await secondStart).toBe(true)
    expect(wsMock.instances).toHaveLength(1)

    releaseFirst()
    expect(await firstStart).toBe(true)
    expect(wsMock.instances).toHaveLength(1)
    expect(winA.listenerCount()).toBe(1)
    expect(winB.listenerCount()).toBe(1)

    // 单个退订不断连，两个都退订后才关闭唯一连接
    handleDanmakuStop(48, winA)
    expect(winA.listenerCount()).toBe(0)
    expect(wsMock.instances[0].closeCalls).toBe(0)

    handleDanmakuStop(48, winB)
    expect(winB.listenerCount()).toBe(0)
    expect(wsMock.instances[0].closeCalls).toBe(1)
  })
})

describe('pocket48/pocket-danmaku', () => {
  it('显式退订与 reset 会同步摘除 destroyed 监听，不随启停累积', async () => {
    const sender = fakeSender()

    expect(await handlePocketDanmakuStart('10086', 'live-1', sender)).toBe(true)
    expect(sender.listenerCount()).toBe(1)
    expect(nimMock.instances).toHaveLength(1)

    handlePocketDanmakuStop('10086', sender)
    expect(sender.listenerCount()).toBe(0)
    expect(nimMock.instances[0].destroyCalls).toBe(1)

    expect(await handlePocketDanmakuStart('10086', 'live-1', sender)).toBe(true)
    expect(sender.listenerCount()).toBe(1)

    resetPocketDanmakuSessions()
    expect(sender.listenerCount()).toBe(0)
    expect(nimMock.instances[1].destroyCalls).toBe(1)
  })

  it('初连失败时摘除订阅监听并销毁 client，同窗口重试不累积', async () => {
    nimMock.connectImpl = () => Promise.reject(new Error('connect failed'))
    const sender = fakeSender()

    expect(await handlePocketDanmakuStart('10086', 'live-1', sender)).toBe(true)
    expect(sender.listenerCount()).toBe(1)
    expect(nimMock.instances).toHaveLength(1)

    // 失败清理在 void connect().catch 里异步执行，等它跑完
    await vi.waitFor(() => expect(sender.listenerCount()).toBe(0))
    expect(nimMock.instances[0].destroyCalls).toBe(1)

    // 同窗口重试会新建会话；旧监听已摘，只挂新会话这一个
    nimMock.connectImpl = null
    expect(await handlePocketDanmakuStart('10086', 'live-1', sender)).toBe(true)
    expect(nimMock.instances).toHaveLength(2)
    expect(sender.listenerCount()).toBe(1)
  })

  it('并发启动同一聊天室时只建立一条 NIM 客户端连接', async () => {
    let releaseFirst!: () => void
    let callIndex = 0
    authMock.credentialsImpl = () => {
      callIndex++
      if (callIndex === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ accid: 'acc-1', token: 'im-token' })
        })
      }
      return Promise.resolve({ accid: 'acc-1', token: 'im-token' })
    }

    const winA = fakeSender()
    const winB = fakeSender()

    const firstStart = handlePocketDanmakuStart('10086', 'live-1', winA)
    const secondStart = handlePocketDanmakuStart('10086', 'live-1', winB)

    expect(await secondStart).toBe(true)
    expect(nimMock.instances).toHaveLength(1)

    releaseFirst()
    expect(await firstStart).toBe(true)
    expect(nimMock.instances).toHaveLength(1)
    expect(winA.listenerCount()).toBe(1)
    expect(winB.listenerCount()).toBe(1)
  })
})
