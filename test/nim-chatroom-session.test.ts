import type { Buffer } from 'node:buffer'
import type { WirePacket } from '../src/main/pocket48/nim-common'
import type { NimSession, SessionOptions } from '../src/main/pocket48/nim-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatroomMessageBody, NimChatroomClient } from '../src/main/pocket48/nim-chatroom'
import { decodeProperties, encodeProperties, text } from '../src/main/pocket48/nim-common'

/**
 * 聊天室客户端的会话消费行为：消息归一与去重、回执（13/35 走 session.send）、
 * 断线退避重连（重连壳仍在客户端，会话层只报 onClose）、初连失败不内部重试。
 * TCP/握手/心跳属会话层（nim-session.test.ts），这里一律假会话。
 */

vi.mock('../src/main/pocket48/client-profile', () => ({
  pocketDeviceId: () => 'device-for-test',
}))

/** 假会话：deliver 注入 13/7 消息帧，simulateClose 触发 onClose 重连分支 */
class FakeSession implements NimSession {
  connected = false
  destroyed = false
  failConnect = false
  sent: Array<{ serviceId: number, commandId: number, body: Buffer }> = []
  /** 收到的请求（13/6 等需要回包的指令）；requestReply 为回包帧体，缺省空体 */
  requests: Array<{ serviceId: number, commandId: number, body: Buffer }> = []
  requestReply: Buffer = encodeProperties({})

  constructor(private options: SessionOptions) {}

  async connect(): Promise<void> {
    if (this.failConnect)
      throw new Error('聊天室 登录失败（417）')
    this.connected = true
  }

  async request(serviceId: number, commandId: number, body: Buffer, _failureMessage: string): Promise<WirePacket> {
    this.requests.push({ serviceId, commandId, body })
    return { serviceId, commandId, serial: 0, resultCode: 200, body: this.requestReply }
  }

  send(serviceId: number, commandId: number, body: Buffer): void {
    this.sent.push({ serviceId, commandId, body })
  }

  destroy(): void {
    this.destroyed = true
    this.connected = false
  }

  deliver(body: Buffer): void {
    this.options.onPacket?.({ serviceId: 13, commandId: 7, serial: 0, resultCode: 200, body })
  }

  simulateClose(): void {
    this.connected = false
    this.options.onClose(this)
  }
}

/** 13/7 消息体：属性 1=uuid、2=msgType（0 文本）、3=正文、7=昵称、20=时刻、21=发送者、38=要求回执 */
function messageBody(uuid: string, content: string, needAck = false): Buffer {
  const properties: Record<number, string> = {
    1: uuid,
    2: '0',
    3: content,
    7: `昵称${uuid}`,
    20: '1728000000000',
    21: '10001',
  }
  if (needAck)
    properties[38] = '1'
  return encodeProperties(properties)
}

let sessions: FakeSession[]
let events: string[]

beforeEach(() => {
  sessions = []
  events = []
  vi.useFakeTimers()
  // LBS chat.jsp：客户端建连前的唯一外部依赖
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ link: ['127.0.0.1:9939'] }),
  })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function createClient(firstSessionFails = false): NimChatroomClient {
  return new NimChatroomClient({
    appKey: 'app-key',
    account: 'acc-1',
    token: 'im-token',
    roomId: '12345',
    nim: { sdkVersion: 92012, packageName: 'com.pocket.snh48.activity' },
    sessionFactory: (options) => {
      const session = new FakeSession(options)
      session.failConnect = firstSessionFails && sessions.length === 0
      sessions.push(session)
      return session
    },
    onConnected: () => events.push('connected'),
    onDisconnected: () => events.push('disconnected'),
    onReconnecting: attempt => events.push(`reconnecting:${attempt}`),
    onMessage: message => events.push(`message:${message.uuid}:${message.text}`),
    onError: error => events.push(`error:${error.message}`),
  })
}

describe('nim-chatroom / 会话消费', () => {
  it('消息归一为 text 视图并按 uuid 去重（长直播不重复上屏）', async () => {
    const client = createClient()
    await client.connect()
    expect(events).toContain('connected')

    sessions[0].deliver(messageBody('u1', '大家好'))
    sessions[0].deliver(messageBody('u1', '大家好'))
    expect(events.filter(item => item.startsWith('message:'))).toEqual(['message:u1:大家好'])
  })

  it('属性 38=1 的消息回执 13/35：body 带 uuid 与房间号', async () => {
    const client = createClient()
    await client.connect()

    sessions[0].deliver(messageBody('u2', '收到请回执', true))
    expect(sessions[0].sent).toHaveLength(1)
    const ack = sessions[0].sent[0]
    expect([ack.serviceId, ack.commandId]).toEqual([13, 35])
    const props = decodeProperties(ack.body)
    expect(text(props.get(1))).toBe('u2')
    expect(text(props.get(2))).toBe('12345')
  })

  it('已进入过的会话断开：onDisconnected → 退避 2s 重连，重连后消息照收', async () => {
    const client = createClient()
    await client.connect()
    events.length = 0

    sessions[0].simulateClose()
    expect(events).toEqual(['disconnected', 'reconnecting:1'])
    await vi.advanceTimersByTimeAsync(2000)

    expect(sessions).toHaveLength(2)
    expect(client.connected).toBe(true)
    expect(events).toContain('connected')
    sessions[1].deliver(messageBody('u3', '重连后的消息'))
    expect(events).toContain('message:u3:重连后的消息')
    // 去重环跨会话保留：重连后重放旧 uuid 不再上屏
    sessions[1].deliver(messageBody('u3', '重连后的消息'))
    expect(events.filter(item => item === 'message:u3:重连后的消息')).toHaveLength(1)
  })

  it('迟到的旧会话 onClose 被忽略：新会话已建立，旧连接的回调不触发掉线/重连', async () => {
    const client = createClient()
    await client.connect()
    expect(sessions).toHaveLength(1)

    // 旧会话断开 → 退避后重建，当前会话换成新的
    sessions[0].simulateClose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sessions).toHaveLength(2)
    expect(client.connected).toBe(true)
    events.length = 0

    // 旧会话的关闭迟到了（例如已被 destroy 才回调）：只认当前会话，必须静默忽略
    sessions[0].simulateClose()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(events).toEqual([])
    expect(sessions).toHaveLength(2)
    expect(client.connected).toBe(true)
  })

  it('初连失败是终态：connect 拒绝，不内部重试（重连壳只服务已进房）', async () => {
    const client = createClient(true)
    await expect(client.connect()).rejects.toThrow('聊天室 登录失败')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(sessions).toHaveLength(1)
    expect(events.some(item => item.startsWith('reconnecting'))).toBe(false)
  })

  it('destroy 后不再重连', async () => {
    const client = createClient()
    await client.connect()
    sessions[0].simulateClose()
    client.destroy()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(sessions).toHaveLength(1)
    expect(client.connected).toBe(false)
  })
})

describe('nim-chatroom / 发送弹幕', () => {
  /** 发送者特征：字段名与 Android `AppIMMessage` 的 user / config 对齐 */
  const sender = {
    user: {
      userId: '10001',
      nickName: '测试用户',
      avatar: 'https://example.com/a.png',
      level: 12,
      roleId: 3,
      vip: true,
      pfUrl: 'https://example.com/pf.png',
      teamLogo: 'https://example.com/team.png',
      badge: ['粉丝团'],
    },
    appName: 'seine48',
    appVersion: '1.3.4',
    deviceModel: 'PocketPhone',
    osVersion: 'Android 14',
  }

  it('13/6 报文与官方同构：属性 1/2/3/4/10/11 齐备，正文只进 remoteExtension.text', () => {
    const body = buildChatroomMessageBody({ uuid: 'uuid-1', roomId: '12345', liveId: '888', text: '晚上好', sender })
    const props = decodeProperties(body)

    expect(text(props.get(1))).toBe('uuid-1')
    expect(text(props.get(2))).toBe('100')
    // 属性 3 存在且为空（自定义消息无附件）
    expect(props.get(3)?.length).toBe(0)
    expect(text(props.get(10))).toBe('1')
    expect(JSON.parse(text(props.get(11)))).toEqual({ type: '1', data: '晚上好' })

    const extension = JSON.parse(text(props.get(4)))
    expect(extension).toMatchObject({
      messageType: 'BARRAGE_NORMAL',
      module: 'live',
      text: '晚上好',
      roomId: '12345',
      sourceId: '888',
      fromApp: 'seine48',
    })
    expect(extension.user).toMatchObject({ userId: '10001', nickName: '测试用户', level: 12 })
    expect(extension.config).toMatchObject({ appName: 'seine48', versionName: '1.3.4', model: 'PocketPhone' })
  })

  it('已连接时在既有会话上发 13/6，并按回执取消息 ID 与时刻', async () => {
    const client = createClient()
    await client.connect()
    sessions[0].requestReply = encodeProperties({ 1: 'server-uuid', 20: '1728000000123' })

    const result = await client.sendMessage({ text: '  晚上好  ', liveId: '888', sender })

    expect(result).toEqual({ uuid: 'server-uuid', time: 1728000000123 })
    expect(sessions[0].requests).toHaveLength(1)
    const request = sessions[0].requests[0]
    expect([request.serviceId, request.commandId]).toEqual([13, 6])
    const extension = JSON.parse(text(decodeProperties(request.body).get(4)))
    // 正文去掉首尾空白后再发
    expect(extension.text).toBe('晚上好')
    expect(extension.sourceId).toBe('888')
  })

  it('空回执按本地生成值兜底：消息已发出就不算失败', async () => {
    const client = createClient()
    await client.connect()

    const result = await client.sendMessage({ text: '晚上好', liveId: '888', sender })

    expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.time).toBeGreaterThan(0)
  })

  it('未连接 / 空内容 / 超长 / 缺 liveId 一律拒绝且不发帧', async () => {
    const client = createClient()
    await expect(client.sendMessage({ text: '晚上好', liveId: '888', sender })).rejects.toThrow('未连接')

    await client.connect()
    await expect(client.sendMessage({ text: '   ', liveId: '888', sender })).rejects.toThrow('请输入弹幕内容')
    await expect(client.sendMessage({ text: '字'.repeat(101), liveId: '888', sender })).rejects.toThrow('不能超过')
    await expect(client.sendMessage({ text: '晚上好', liveId: '', sender })).rejects.toThrow('直播信息未就绪')

    expect(sessions[0].requests).toHaveLength(0)
  })
})
