import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodePacket, decodeProperties, encodeProperties, encodeVarint } from '../src/main/pocket48/nim-common'
import {
  buildNimLoginPacket,
  buildQChatMessageProperties,
  buildQChatSubscriptionBody,
  decodeQChatStringArray,
  FATAL_AUTH_CODES,
  isFatalAuthError,
  isRequestResponse,
  normalizeQChatMessage,
  readSubscribeFailures,
  sdkHumanVersion,
} from '../src/main/pocket48/nim-qchat'

/**
 * QChat 协议层纯函数：NIM 登录属性表（2/2，含终端类型）、发送属性表（24/10）、
 * 订阅 body（25/9 / 24/15）、推送解码（24/11）、应答与请求的匹配。
 * 双 TCP 拓扑与重连属会话层，不在这层断言。
 */

/** 从 offset 处读一个 varint（测试数据自造，越界即坏数据） */
function readVarintAt(buffer: Buffer, offset: number): { value: number, size: number } {
  let value = 0
  let scale = 1
  let cursor = offset
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    value += (byte & 0x7F) * scale
    cursor++
    if ((byte & 0x80) === 0)
      return { value, size: cursor - offset }
    scale *= 128
  }
  throw new Error('varint 越界（测试数据损坏）')
}

/** 从 offset 处解一个属性表，返回 props 与占用长度 */
function parsePropsAt(buffer: Buffer, offset: number): { props: Map<number, string>, size: number } {
  const count = readVarintAt(buffer, offset)
  let cursor = offset + count.size
  const props = new Map<number, string>()
  for (let index = 0; index < count.value; index++) {
    const key = readVarintAt(buffer, cursor)
    const length = readVarintAt(buffer, cursor + key.size)
    cursor += key.size + length.size
    props.set(key.value, buffer.subarray(cursor, cursor + length.value).toString('utf8'))
    cursor += length.value
  }
  return { props, size: cursor - offset }
}

describe('nim-qchat / sdkHumanVersion', () => {
  it('五位版本号转人读格式', () => {
    expect(sdkHumanVersion(92012)).toBe('9.20.12')
    expect(sdkHumanVersion(91701)).toBe('9.17.1')
  })

  it('非五位原样返回（不猜格式）', () => {
    expect(sdkHumanVersion(920)).toBe('920')
    expect(sdkHumanVersion(Number.NaN)).toBe('NaN')
  })
})

describe('nim-qchat / NIM 登录属性表（2/2）', () => {
  const nim = { sdkVersion: 92110, packageName: 'com.seine48.app' }
  const base = { appKey: 'app-key', account: 'acc-1', token: 'tok-1', deviceId: 'dev-1', nim }

  /** 登录包是完整帧，属性表在 body 里：解帧再解属性 */
  function loginProperties(): Map<number, Buffer> {
    const packet = decodePacket(buildNimLoginPacket(base))
    return decodeProperties(packet.body)
  }

  it('终端类型恒为 1（AOS）：与两个官方 App 的登录身份一致', () => {
    expect(loginProperties().get(3)?.toString()).toBe('1')
  })

  it('其余属性齐全：SDK 版本 / 包名 / 设备 ID / appKey / 账号 / token', () => {
    const props = loginProperties()

    expect(props.get(6)?.toString()).toBe('92110')
    expect(props.get(25)?.toString()).toBe('com.seine48.app')
    expect(props.get(13)?.toString()).toBe('dev-1')
    expect(props.get(18)?.toString()).toBe('app-key')
    expect(props.get(19)?.toString()).toBe('acc-1')
    expect(props.get(1000)?.toString()).toBe('tok-1')
    // 人读版本与 UA 由 SDK 版本换算（9.21.10）
    expect(props.get(40)?.toString()).toBe('9.21.10')
    expect(props.get(42)?.toString()).toBe('Native/9.21.10')
  })
})

describe('nim-qchat / 发送属性表（24/10）', () => {
  const base = {
    serverId: '123456',
    channelId: '789',
    ext: '{"module":"QCHAT"}',
    msgIdClient: 'abcdef0123456789abcdef0123456789',
  }

  it('文本消息：类型 0、正文进属性 10，不写附件', () => {
    const properties = buildQChatMessageProperties({ ...base, type: 'text', body: '大家晚安' }, 'acc-me')

    expect(properties[1]).toBe('123456')
    expect(properties[2]).toBe('789')
    expect(properties[3]).toBe('acc-me')
    expect(properties[9]).toBe(0)
    expect(properties[10]).toBe('大家晚安')
    expect(properties[11]).toBeUndefined()
    expect(properties[12]).toBe(base.ext)
    expect(properties[13]).toBe(base.msgIdClient)
    // 开关位恒开（镜像参考实现）
    expect(properties[20]).toBe(0)
    expect(properties[21]).toBe('QChat')
    expect(properties[100]).toBe(1)
    expect(properties[105]).toBe(1)
  })

  it('自定义消息（回复）：类型 100、正文在附件属性 11，不写 body', () => {
    const attachment = JSON.stringify({ replyInfo: { replyName: '甲', text: '不客气' }, messageType: 'REPLY' })
    const properties = buildQChatMessageProperties({ ...base, type: 'custom', attachment }, 'acc-me')

    expect(properties[9]).toBe(100)
    expect(properties[11]).toBe(attachment)
    expect(properties[10]).toBeUndefined()
  })

  it('body / attachment 皆空：两个正文属性都不写（编码时空值会被跳过）', () => {
    const properties = buildQChatMessageProperties({ ...base, type: 'text' }, 'acc-me')

    expect(properties[10]).toBeUndefined()
    expect(properties[11]).toBeUndefined()
    // 房间 / 发送者 / ext / 客户端 ID 仍在
    expect(Object.keys(properties).length).toBeGreaterThan(4)
  })
})

describe('nim-qchat / 订阅 body（25/9 访客 / 24/15 成员）', () => {
  /** 订阅 body = 操作属性表 + varint(1) + 房间属性表 */
  function parseSubscriptionBody(body: Buffer) {
    const operation = parsePropsAt(body, 0)
    const middle = readVarintAt(body, operation.size)
    const room = parsePropsAt(body, operation.size + middle.size)
    return { operation: operation.props, middle: middle.value, room: room.props }
  }

  it('访客订阅：操作属性 {1:6, 2:1}，房间属性带 serverId/channelId', () => {
    const parsed = parseSubscriptionBody(buildQChatSubscriptionBody('111', '222', true, true))

    expect(parsed.operation.get(1)).toBe('6')
    expect(parsed.operation.get(2)).toBe('1')
    expect(parsed.middle).toBe(1)
    expect(parsed.room.get(1)).toBe('111')
    expect(parsed.room.get(2)).toBe('222')
  })

  it('成员退订：操作属性 {1:1, 2:2}', () => {
    const parsed = parseSubscriptionBody(buildQChatSubscriptionBody('111', '222', false, false))

    expect(parsed.operation.get(1)).toBe('1')
    expect(parsed.operation.get(2)).toBe('2')
  })

  it('房间 ID 非纯数字即拒（协议只认数字 ID，拼错报文不如早失败）', () => {
    expect(() => buildQChatSubscriptionBody('', '222', true, true)).toThrow('缺少有效的云信订阅房间 ID')
    expect(() => buildQChatSubscriptionBody('srv-1', '222', true, true)).toThrow('缺少有效的云信订阅房间 ID')
    expect(() => buildQChatSubscriptionBody('111', 'ch-2', true, true)).toThrow('缺少有效的云信订阅房间 ID')
  })
})

describe('nim-qchat / 推送解码（24/11）', () => {
  it('属性表 → 传输层消息：字段号映射齐全', () => {
    const body = encodeProperties({
      1: 'srv-1',
      2: 'ch-1',
      3: 'acc-1',
      4: 2,
      6: '成员甲',
      7: 1728000009,
      9: 100,
      10: '',
      11: '{"messageType":"REPLY"}',
      12: '{"user":{}}',
      13: 'client-1',
      14: 'server-1',
    })

    expect(normalizeQChatMessage(body)).toEqual({
      serverId: 'srv-1',
      channelId: 'ch-1',
      fromAccount: 'acc-1',
      fromClientType: 2,
      fromNick: '成员甲',
      time: 1728000009,
      type: 100,
      body: '',
      attachment: '{"messageType":"REPLY"}',
      ext: '{"user":{}}',
      msgIdClient: 'client-1',
      msgIdServer: 'server-1',
    })
  })

  it('缺字段兜底：数值位归 0、字符串位空串（老回包 / 降级包不炸）', () => {
    const raw = normalizeQChatMessage(encodeProperties({ 1: 'srv-1', 2: 'ch-1', 3: 'acc-1' }))

    expect(raw.time).toBe(0)
    expect(raw.type).toBe(0)
    expect(raw.body).toBe('')
    expect(raw.msgIdClient).toBe('')
  })
})

describe('nim-qchat / 24/1 地址回包与订阅失败清单', () => {
  it('地址数组：varint(数量) + N × (varint(len) + bytes)，空串条目滤掉', () => {
    const body = Buffer.concat([
      encodeVarint(3),
      encodeVarint('hdl.ntes.im:8081'.length),
      Buffer.from('hdl.ntes.im:8081'),
      encodeVarint(0),
      Buffer.alloc(0),
      encodeVarint('bcdn.ntes.im:8082'.length),
      Buffer.from('bcdn.ntes.im:8082'),
    ])

    expect(decodeQChatStringArray(body)).toEqual(['hdl.ntes.im:8081', 'bcdn.ntes.im:8082'])
    // 空回包 / 超额数量：视为无地址，由调用方报错
    expect(decodeQChatStringArray(encodeVarint(0))).toEqual([])
    expect(decodeQChatStringArray(encodeVarint(200))).toEqual([])
  })

  it('订阅失败清单：外层属性表里找属性 2 = channelId 的嵌套条目', () => {
    const list = Buffer.concat([
      encodeVarint(2),
      encodeVarint(encodeProperties({ 2: 'ch-fail-1' }).length),
      encodeProperties({ 2: 'ch-fail-1' }),
      encodeVarint(encodeProperties({ 2: 'ch-fail-2' }).length),
      encodeProperties({ 2: 'ch-fail-2' }),
    ])
    const body = encodeProperties({ 1: list })

    expect(readSubscribeFailures(body)).toEqual(['ch-fail-1', 'ch-fail-2'])
    // 没有失败条目：空清单（访客被拒还有正式成员订阅兜底）
    expect(readSubscribeFailures(encodeProperties({ 3: 'x' }))).toEqual([])
  })
})

describe('nim-qchat / 应答匹配', () => {
  it('同 s/c 才是这条请求的应答（实测 24/10、25/9 的 ACK 均回填请求自己的 s/c）', () => {
    expect(isRequestResponse({ serviceId: 24, commandId: 10 }, { serviceId: 24, commandId: 10 })).toBe(true)
    expect(isRequestResponse({ serviceId: 25, commandId: 9 }, { serviceId: 25, commandId: 9 })).toBe(true)
  })

  it('serial 撞上但指令号不同：24/11 推送不得顶替 24/10 的应答', () => {
    // 串号时推送先到：若只看 serial，这次 resolve 会把推送当 ACK，真正的应答随后被丢弃
    expect(isRequestResponse({ serviceId: 24, commandId: 10 }, { serviceId: 24, commandId: 11 })).toBe(false)
  })

  it('服务号不同也不算（NIM 与 QChat 各自的 serial 都从 2 起）', () => {
    expect(isRequestResponse({ serviceId: 24, commandId: 1 }, { serviceId: 25, commandId: 1 })).toBe(false)
  })
})

describe('nim-qchat / 编解码互通', () => {
  it('buildQChatMessageProperties 编码后可被 decodeProperties 还原', () => {
    const properties = buildQChatMessageProperties({
      serverId: '999',
      channelId: '888',
      type: 'text',
      body: '互通验证',
      ext: '{"module":"QCHAT"}',
      msgIdClient: 'client-xyz',
    }, 'acc-me')
    const decoded = decodeProperties(encodeProperties(properties))

    expect(decoded.get(1)?.toString()).toBe('999')
    expect(decoded.get(10)?.toString()).toBe('互通验证')
    // 空值属性在编码时被跳过，与构造侧一致
    expect(decoded.has(11)).toBe(false)
  })
})

describe('nim-qchat / isFatalAuthError 认证致命错误判定', () => {
  it('状态码 302/403/422 判定为致命认证错误（重试无意义）', () => {
    expect(FATAL_AUTH_CODES.has(302)).toBe(true)
    expect(FATAL_AUTH_CODES.has(403)).toBe(true)
    expect(FATAL_AUTH_CODES.has(422)).toBe(true)

    const err302 = new Error('登录失败（302）')
    ;(err302 as Error & { code?: number }).code = 302
    expect(isFatalAuthError(err302)).toBe(true)

    const err403 = new Error('登录失败（403）')
    ;(err403 as Error & { code?: number }).code = 403
    expect(isFatalAuthError(err403)).toBe(true)

    const err422 = new Error('账号被封禁（422）')
    ;(err422 as Error & { code?: number }).code = 422
    expect(isFatalAuthError(err422)).toBe(true)
  })

  it('缺少 AppKey/Token 错误判定为致命认证错误', () => {
    expect(isFatalAuthError(new Error('缺少云信 AppKey、账号或令牌'))).toBe(true)
  })

  it('常规网络错误或可重试状态码（408 超时、500 服务端异常）不判定为致命错误', () => {
    expect(isFatalAuthError(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isFatalAuthError(new Error('网络请求超时'))).toBe(false)

    const err408 = new Error('请求超时（408）')
    ;(err408 as Error & { code?: number }).code = 408
    expect(isFatalAuthError(err408)).toBe(false)

    const err500 = new Error('服务器内部错误（500）')
    ;(err500 as Error & { code?: number }).code = 500
    expect(isFatalAuthError(err500)).toBe(false)

    expect(isFatalAuthError(null)).toBe(false)
    expect(isFatalAuthError(undefined)).toBe(false)
  })
})
