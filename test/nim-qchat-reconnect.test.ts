import type { WirePacket } from '../src/main/pocket48/nim-common'
import type { QChatSession, SessionOptions } from '../src/main/pocket48/nim-qchat'
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeVarint } from '../src/main/pocket48/nim-common'
import { NimQChatClient } from '../src/main/pocket48/nim-qchat'

/**
 * QChat 断线重连（nim-qchat.ts 的 establish）：订阅恢复与 connected 广播的先后。
 *
 * 假会话替掉 TCP（options.sessionFactory），只保留「请求进了哪条会话」与
 * 「哪条会话断了」两件事——协议编解码不在这层的验证范围。
 */

vi.mock('../src/main/pocket48/client-profile', () => ({
  pocketDeviceId: () => 'device-for-test',
}))

/** 24/1：在 NIM 会话上索取 QChat 接入地址 */
const ADDRESS_REQUEST = { serviceId: 24, commandId: 1 }
/** 25/9：访客身份订阅频道（被拒才退 24/15，假会话一律成功） */
const VISITOR_SUBSCRIBE = { serviceId: 25, commandId: 9 }

/** varint(数量) + N × (varint(len) + bytes)，对应 decodeQChatStringArray 的格式 */
function stringArrayBody(items: string[]): Buffer {
  const parts = [encodeVarint(items.length)]
  for (const item of items) {
    const bytes = Buffer.from(item, 'utf8')
    parts.push(encodeVarint(bytes.length), bytes)
  }
  return Buffer.concat(parts)
}

function packet(serviceId: number, commandId: number, body: WirePacket['body'] = Buffer.alloc(0)): WirePacket {
  return { serviceId, commandId, serial: 2, resultCode: 200, body }
}

/** 假会话：记录请求；simulateClose 走真实的 onClose 分支触发重连 */
class FakeSession implements QChatSession {
  connected = false
  destroyed = false
  requests: Array<{ serviceId: number, commandId: number }> = []

  constructor(private options: SessionOptions, private events: string[]) {}

  async connect(): Promise<void> {
    this.connected = true
  }

  async request(serviceId: number, commandId: number, _body: Buffer, _failureMessage: string): Promise<WirePacket> {
    this.requests.push({ serviceId, commandId })
    this.events.push(`request:${serviceId}/${commandId}`)
    if (serviceId === ADDRESS_REQUEST.serviceId && commandId === ADDRESS_REQUEST.commandId)
      return packet(serviceId, commandId, stringArrayBody(['127.0.0.1:9939']))
    return packet(serviceId, commandId)
  }

  destroy(): void {
    this.destroyed = true
    this.connected = false
  }

  /** 模拟 TCP 断开：客户端据此开始退避重连 */
  simulateClose(): void {
    this.connected = false
    this.options.onClose(this)
  }
}

let sessions: FakeSession[]
let events: string[]

beforeEach(() => {
  sessions = []
  events = []
  vi.useFakeTimers()
  // LBS 取地址：establish 的第一步，假会话接管之前唯一的外部依赖
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ common: { link: ['127.0.0.1:9939'] } }),
  })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function createClient(): NimQChatClient {
  return new NimQChatClient({
    appKey: 'app-key',
    account: 'acc-1',
    token: 'im-token',
    nim: { sdkVersion: 92012, packageName: 'com.pocket.snh48.activity' },
    sessionFactory: (options) => {
      const session = new FakeSession(options, events)
      sessions.push(session)
      return session
    },
    onConnected: () => events.push('connected'),
    onDisconnected: () => events.push('disconnected'),
    onReconnecting: attempt => events.push(`reconnecting:${attempt}`),
    onError: error => events.push(`error:${error.message}`),
  })
}

describe('nim-qchat / 断线重连', () => {
  it('重连后先恢复订阅再广播 connected（订阅不被 disconnected 状态拦下）', async () => {
    const client = createClient()
    await client.connect()
    await client.subscribeChannel('1001', '2002')
    expect(sessions[1].requests).toContainEqual(VISITOR_SUBSCRIBE)

    events.length = 0
    // QChat 会话断开：第 1 次重连退避 2s（1000 × 2^1）
    sessions[1].simulateClose()
    await vi.advanceTimersByTimeAsync(2000)

    const reconnected = sessions.at(-1)!
    expect(client.connected).toBe(true)
    expect(reconnected.requests).toContainEqual(VISITOR_SUBSCRIBE)
    // 顺序断言：恢复请求先发出，connected 后广播。反过来就是「报已连接但收不到推送」
    const subscribeAt = events.indexOf(`request:${VISITOR_SUBSCRIBE.serviceId}/${VISITOR_SUBSCRIBE.commandId}`)
    expect(subscribeAt).toBeGreaterThan(-1)
    expect(events.indexOf('connected')).toBeGreaterThan(subscribeAt)
    // 恢复不该因为「未连接」而失败
    expect(events).not.toContainEqual(expect.stringContaining('房间连接已断开'))
  })
})
