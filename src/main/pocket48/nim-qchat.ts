/**
 * 网易云信圈组（QChat）TCP 协议客户端：成员房间消息的收发（参考实现 yaya_msg 同款）。
 *
 * 与聊天室（nim-chatroom.ts，直播弹幕）是同源不同族的两套协议：帧 / 属性表 / RC4 /
 * RSA 握手共用 nim-common.ts，但服务号体系不同，且 **QChat 需要两条 TCP**：
 * 1. NIM 会话：LBS `conf.jsp` 取地址 → 握手（包内带 2/2 NIM 登录包）→ NIM 登录
 *    → 在其上发 24/1 索取 QChat 接入地址；
 * 2. QChat 会话：以拿到的地址另建连接 → 握手（包内带 24/2 QChat 登录包）→ QChat 登录
 *    → 订阅频道（25/9 访客优先，被拒 403/404 退 24/15 正式成员）→ 收发消息。
 *
 * 协议要点：
 * - 发送消息 24/10；实时推送 24/11（属性表消息体，字段见 normalizeQChatMessage）；
 * - 请求/响应靠 serial + 服务号/指令号匹配（serial 从 2 起，32767 回绕），单请求 12s 超时；
 * - 心跳 1/2（15s，两条连接各自发）；任一条异常断开即整体重连（QChat 地址需重新索取）。
 *
 * 登录身份（SDK 版本 + 包名）取当前档位（client-profile.ts 的 nimIdentityFor），
 * 与聊天室、HTTP 同档——参考实现的 QChat 文件报的是旧版 seine SDK，档位口径以本项目为准。
 *
 * 终端类型（属性 3）恒为 AOS：两个官方 App 都是 Android 客户端，忠实模拟即报 AOS。
 * 注意 `2/2` 是账号级登录，建连会顶掉同账号的其他在线设备，故房间页默认不连、确认后才连。
 */
import type { NimClientIdentity } from './client-profile'

import type { WirePacket } from './nim-common'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { debug } from '../logger'
import { pocketDeviceId } from './client-profile'
import {
  decodeEmbeddedPacket,
  decodePacket,
  decodeProperties,
  encodeProperties,
  encodeVarint,
  makeHandshake,
  makePacket,
  Rc4Stream,
  readVarint,
  text,
} from './nim-common'

// ===== 协议常量 =====

/** NIM LBS（与聊天室的 lbs/chat.jsp 是两个端点；回包取 common.link[0]） */
const NIM_LBS_URL = 'https://lbs.netease.im/lbs/conf.jsp'

const SERVICE_HANDSHAKE = 1
const CMD_HANDSHAKE = 1
const CMD_HEARTBEAT = 2
const SERVICE_NIM = 2
const CMD_NIM_LOGIN = 2
const SERVICE_QCHAT = 24
const CMD_QCHAT_ADDRESS = 1
const CMD_QCHAT_LOGIN = 2
const CMD_QCHAT_SEND = 10
const CMD_QCHAT_MESSAGE = 11
/** 访客订阅走 25/9，正式成员订阅走 24/15（同一指令号 9/15，服务号不同） */
const SERVICE_QCHAT_VISITOR = 25
const CMD_SUBSCRIBE_VISITOR = 9
const CMD_SUBSCRIBE_MEMBER = 15

const CONNECT_TIMEOUT_MS = 20_000
const LBS_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 45_000
const HEARTBEAT_INTERVAL_MS = 15_000
/** 单请求超时（参考实现同值）：超时即失败，不无限等 */
const REQUEST_TIMEOUT_MS = 12_000
const RECONNECT_MAX_DELAY_MS = 30_000
/** 单连接订阅频道数上限（参考实现同值） */
const CHANNEL_SUBSCRIBE_LIMIT = 100

// ===== 传输层形状 =====

/** QChat 消息（推送 24/11 与发送 ACK 共用同一解码；业务归一在渲染层） */
export interface QChatRawMessage {
  serverId: string
  channelId: string
  fromAccount: string
  fromClientType: number
  fromNick: string
  time: number
  /** 0 = 文本，100 = 自定义（回复等，正文在 attachment） */
  type: number
  body: string
  attachment: string
  ext: string
  msgIdClient: string
  msgIdServer: string
}

/** 发送入参：文本走 body（属性 10），自定义（回复）走 attachment（属性 11） */
export interface QChatSendInput {
  serverId: string
  channelId: string
  type: 'text' | 'custom'
  body?: string
  attachment?: string
  ext: string
  msgIdClient: string
}

export interface QChatSendResult {
  msgIdClient: string
  msgIdServer: string
  time: number
}

export interface NimQChatClientOptions {
  appKey: string
  account: string
  token: string
  /** 登录身份（SDK 版本 + 包名），与聊天室同档口径 */
  nim: NimClientIdentity
  onConnected?: () => void
  /** 已进入过的连接断开：开始重连 */
  onDisconnected?: () => void
  onReconnecting?: (attempt: number) => void
  onError?: (error: Error) => void
  /** 致命凭证/认证错误（如 302 Token失效、403 禁止访问、422 账号封禁），自动重连已停止 */
  onFatalAuthError?: (error: Error) => void
  onMessage?: (message: QChatRawMessage) => void
}

interface TcpAddress {
  host: string
  port: number
}

// ===== 纯函数：报文构造与解码（单测直接断言） =====

/** SDK 版本号 → 人读版本：92012 → 9.20.12，91701 → 9.17.1 */
export function sdkHumanVersion(sdkVersion: number): string {
  const raw = String(sdkVersion)
  if (!/^\d{5}$/.test(raw))
    return raw
  return `${raw[0]}.${Number(raw.slice(1, 3))}.${Number(raw.slice(3))}`
}

/**
 * NIM 登录包（2/2）：属性 3=终端类型、6=SDK 版本、25=包名即「以哪个客户端身份登录」。
 *
 * 终端类型恒为 1（AOS）：两个官方 App 都是 Android 客户端，忠实模拟即报 AOS。
 */
export function buildNimLoginPacket(input: {
  appKey: string
  account: string
  token: string
  deviceId: string
  nim: NimClientIdentity
}): Buffer {
  const human = sdkHumanVersion(input.nim.sdkVersion)
  return makePacket(SERVICE_NIM, CMD_NIM_LOGIN, 1, encodeProperties({
    3: 1,
    4: '8.0.0',
    6: input.nim.sdkVersion,
    8: 1,
    9: 1,
    13: input.deviceId,
    18: input.appKey,
    19: input.account,
    25: input.nim.packageName,
    40: human,
    42: `Native/${human}`,
    1000: input.token,
  }))
}

/** QChat 登录包（24/2） */
export function buildQChatLoginPacket(input: {
  appKey: string
  account: string
  token: string
  deviceId: string
  nim: NimClientIdentity
}): Buffer {
  const human = sdkHumanVersion(input.nim.sdkVersion)
  return makePacket(SERVICE_QCHAT, CMD_QCHAT_LOGIN, 1, encodeProperties({
    1: input.appKey,
    2: input.account,
    3: 0,
    4: input.token,
    6: 1,
    8: input.deviceId,
    9: input.nim.sdkVersion,
    10: 1,
    11: `Native/${human}`,
    14: human,
  }))
}

/**
 * 发送消息属性表：1/2=房间、3=发送者、9=类型（0 文本 / 100 自定义）、10=正文、
 * 11=附件、12=ext、13=客户端消息 ID；20/100-105 为开关位（恒开，镜像参考实现）。
 */
export function buildQChatMessageProperties(input: QChatSendInput, fromAccount: string): Record<number, string | number> {
  const properties: Record<number, string | number> = {
    1: input.serverId,
    2: input.channelId,
    3: fromAccount,
    9: input.type === 'custom' ? 100 : 0,
    12: input.ext,
    13: input.msgIdClient,
    20: 0,
    21: 'QChat',
    100: 1,
    101: 1,
    102: 1,
    103: 1,
    105: 1,
  }
  if (input.body)
    properties[10] = input.body
  if (input.attachment)
    properties[11] = input.attachment
  return properties
}

/**
 * 订阅 / 退订 body：操作属性 {1: 访客?6:1, 2: 订阅?1:2} + varint(1) + 房间属性 {1: serverId, 2: channelId}。
 */
export function buildQChatSubscriptionBody(serverId: string, channelId: string, visitor: boolean, subscribe: boolean): Buffer {
  if (!/^\d{1,32}$/.test(String(serverId || '')) || !/^\d{1,32}$/.test(String(channelId || '')))
    throw new Error('缺少有效的云信订阅房间 ID')
  return Buffer.concat([
    encodeProperties({ 1: visitor ? 6 : 1, 2: subscribe ? 1 : 2 }),
    encodeVarint(1),
    encodeProperties({ 1: String(serverId), 2: String(channelId) }),
  ])
}

/** 24/1 回包解析：varint(数量) + N × (varint(len) + bytes) 的字符串数组 */
export function decodeQChatStringArray(body: Buffer): string[] {
  const count = readVarint(body)
  if (!count || count.value > 100)
    return []
  const list: string[] = []
  let offset = count.size
  for (let index = 0; index < count.value; index++) {
    const length = readVarint(body, offset)
    if (!length)
      break
    offset += length.size
    if (offset + length.value > body.length)
      break
    list.push(body.subarray(offset, offset + length.value).toString('utf8'))
    offset += length.value
  }
  return list.filter(item => item.trim())
}

/** 消息属性表 → 传输层消息（推送 24/11 与发送 ACK 共用） */
export function normalizeQChatMessage(body: Buffer): QChatRawMessage {
  const properties = decodeProperties(body)
  return {
    serverId: text(properties.get(1)),
    channelId: text(properties.get(2)),
    fromAccount: text(properties.get(3)),
    fromClientType: Number(text(properties.get(4)) || 0),
    fromNick: text(properties.get(6)),
    time: Number(text(properties.get(7)) || 0),
    type: Number(text(properties.get(9)) || 0),
    body: text(properties.get(10)),
    attachment: text(properties.get(11)),
    ext: text(properties.get(12)),
    msgIdClient: text(properties.get(13)),
    msgIdServer: text(properties.get(14)),
  }
}

/**
 * 订阅回包里的失败频道：嵌套属性表清单中找属性 2 = channelId 的条目。
 * 回包结构未公开，外层属性表包清单 / 直接是清单两种形态都试；解不出视为无失败，
 * 由后续收发流程暴露问题（访客被拒时还有正式成员订阅兜底）。
 */
export function readSubscribeFailures(body: Buffer): string[] {
  const failed: string[] = []
  const visitList = (buffer: Buffer) => {
    const count = readVarint(buffer)
    if (!count || count.value === 0 || count.value > 100)
      return
    let offset = count.size
    for (let index = 0; index < count.value; index++) {
      const length = readVarint(buffer, offset)
      if (!length)
        return
      offset += length.size
      if (offset + length.value > buffer.length)
        return
      const entry = buffer.subarray(offset, offset + length.value)
      offset += length.value
      try {
        const channelId = text(decodeProperties(entry).get(2))
        if (channelId)
          failed.push(channelId)
      }
      catch {
        // 条目不是属性表：跳过
      }
    }
  }
  try {
    for (const value of decodeProperties(body).values())
      visitList(value)
  }
  catch {
    visitList(body)
  }
  return failed
}

// ===== 内部工具 =====

function protocolError(message: string, code: number): Error {
  const error = new Error(code ? `${message}（${code}）` : message)
  ;(error as Error & { code?: number }).code = code
  return error
}

/**
 * 登录被拒（服务端回了非 200 结果码）。label 区分是哪次登录（NIM 2/2 还是
 * QChat 24/2）；响应体是属性表，带上摘要便于定位拒绝原因（如 417=禁止多端登录）。
 */
function loginRejectedError(label: string, code: number, body?: Buffer): Error {
  const detail = describeLoginBody(body)
  const error = new Error(detail ? `${label} 登录失败（${code}，${detail}）` : `${label} 登录失败（${code}）`)
  ;(error as Error & { code?: number }).code = code
  return error
}

/** 登录响应 body 解密后是属性表；解不出（空 / 非属性表）返回空串，摘要截断防刷屏 */
function describeLoginBody(body?: Buffer): string {
  if (!body?.length)
    return ''
  try {
    const parts: string[] = []
    for (const [key, value] of decodeProperties(body)) {
      if (parts.length >= 6)
        break
      const text = value.toString()
      parts.push(`${key}=${text.length > 24 ? `${text.slice(0, 24)}…` : text}`)
    }
    return parts.join(' ')
  }
  catch {
    return ''
  }
}

function parseTcpAddress(address: string): TcpAddress {
  const separator = address.lastIndexOf(':')
  const host = separator > 0 ? address.slice(0, separator).replace(/^\[|\]$/g, '') : ''
  const port = Number(address.slice(separator + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('云信未返回有效的连接地址')
  return { host, port }
}

/** NIM LBS 取接入地址（回包 common.link[0]，旧形态 link[0] 兼容） */
async function requestNimAddress(appKey: string, account: string, sdkVersion: number): Promise<TcpAddress> {
  const url = new URL(NIM_LBS_URL)
  url.search = new URLSearchParams({
    k: appKey,
    id: account,
    v: String(sdkVersion),
    tp: '1',
    dt: '0',
  }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(LBS_TIMEOUT_MS) })
  if (!response.ok)
    throw new Error(`获取云信地址失败（HTTP ${response.status}）`)
  const result = await response.json() as { common?: { link?: unknown }, link?: unknown }
  const raw = Array.isArray(result.common?.link) ? result.common.link[0] : (Array.isArray(result.link) ? result.link[0] : '')
  return parseTcpAddress(String(raw || '').trim())
}

// ===== 单条 commonlink 会话（一条 TCP：握手 → 登录 → 请求/响应 + 心跳） =====

interface SessionOptions {
  address: TcpAddress
  loginPacket: Buffer
  loginServiceId: number
  loginCommandId: number
  /** 登录名（诊断用）：NIM / QChat，拒绝时报「哪次登录」被拒 */
  loginLabel: string
  onPacket?: (packet: WirePacket) => void
  /** 已登录过的会话断开；带上会话自身，供上层识别「是不是当前这条」（非当前会话的关闭要忽略） */
  onClose: (session: CommonlinkSession) => void
}

interface PendingRequest {
  /** 登记时的服务号 / 指令号：命中 serial 只是必要条件，s/c 对得上才是这条请求的应答 */
  serviceId: number
  commandId: number
  resolve: (packet: WirePacket) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 应答与请求是否对应：serial 命中只是必要条件，服务号/指令号一致才算这条请求的应答。
 * 实测服务端应答回填请求自己的 s/c（24/10 发送、25/9 订阅均如此），据此可把同 serial 的 24/11 推送排除在外。
 */
export function isRequestResponse(
  request: { serviceId: number, commandId: number },
  frame: { serviceId: number, commandId: number },
): boolean {
  return request.serviceId === frame.serviceId && request.commandId === frame.commandId
}

class CommonlinkSession {
  connected = false

  private socket: net.Socket | null = null
  private encryptor: Rc4Stream | null = null
  private decryptor: Rc4Stream | null = null
  private receiveBuffer = Buffer.alloc(0)
  private serial = 2
  private stopped = true
  private loginSent = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pending = new Map<number, PendingRequest>()

  constructor(private options: SessionOptions) {}

  /** resolve 即登录成功；reject 为终态（握手失败 / 登录被拒 / 连接关闭），由调用方决定重试 */
  connect(): Promise<void> {
    const { address } = this.options
    this.stopped = false
    this.loginSent = false
    this.receiveBuffer = Buffer.alloc(0)
    this.connected = false
    const key = randomBytes(16)
    const handshake = makeHandshake(key, this.options.loginPacket)
    this.encryptor = new Rc4Stream(key)
    this.decryptor = new Rc4Stream(key)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error) => {
        if (settled)
          return
        settled = true
        if (error)
          reject(error)
        else
          resolve()
      }
      const timer = setTimeout(() => {
        this.socket?.destroy()
        settle(new Error('连接云信超时'))
      }, CONNECT_TIMEOUT_MS)

      const socket = net.createConnection(address)
      this.socket = socket
      socket.setKeepAlive(true, 15_000)
      socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        this.reportError(new Error('云信连接空闲超时'))
        socket.destroy()
      })

      socket.on('connect', () => {
        socket.write(handshake)
      })

      socket.on('data', (chunk: Buffer) => {
        try {
          this.handleChunk(chunk, (packet) => {
            if (timer)
              clearTimeout(timer)
            // 握手应答：成功后把登录包再以 RC4 发一次
            if (packet.serviceId === SERVICE_HANDSHAKE && packet.commandId === CMD_HANDSHAKE) {
              if (packet.resultCode !== 200) {
                settle(protocolError('云信握手失败', packet.resultCode))
                socket.destroy()
                return
              }
              if (!this.loginSent && this.encryptor) {
                this.loginSent = true
                socket.write(this.encryptor.apply(this.options.loginPacket))
              }
              return
            }
            if (packet.serviceId === this.options.loginServiceId && packet.commandId === this.options.loginCommandId) {
              if (packet.resultCode !== 200) {
                const detail = describeLoginBody(packet.body)
                if (detail)
                  debug(`[nim-qchat] ${this.options.loginLabel} 登录被拒（${packet.resultCode}）：${detail}`)
                settle(loginRejectedError(this.options.loginLabel, packet.resultCode, packet.body))
                socket.destroy()
                return
              }
              this.connected = true
              this.startHeartbeat()
              settle()
              return
            }
            // 请求/响应按 serial + 服务号/指令号匹配（心跳应答也会落这里，无匹配即忽略）：
            // 只比 serial 的话，服务端主动推送（24/11）撞上在途请求的 serial 会被当成应答，
            // 真正的 ACK 到达时 pending 已摘而被静默丢弃
            const pending = this.pending.get(packet.serial)
            if (pending && isRequestResponse(pending, packet)) {
              this.pending.delete(packet.serial)
              clearTimeout(pending.timer)
              // 正常路径也留一条：一次成功发送就能看到 ACK 的 s/c，用来确认「应答与请求同 s/c」这个前提
              debug(`[nim-qchat] 应答 s=${packet.serviceId} c=${packet.commandId} serial=${packet.serial} code=${packet.resultCode}`)
              if (packet.resultCode === 200)
                pending.resolve(packet)
              else
                pending.reject(protocolError('云信请求失败', packet.resultCode))
              return
            }
            if (pending) {
              // 这行日志是「服务端应答的 s/c 是否与请求一致」的实测依据：
              // 若发送一直超时，先看这里打出的实收 s/c
              debug(`[nim-qchat] serial ${packet.serial} 命中在途请求但 s/c 不符`
                + `（期望 ${pending.serviceId}/${pending.commandId}，实收 ${packet.serviceId}/${packet.commandId}），按推送处理`)
            }
            this.options.onPacket?.(packet)
          })
        }
        catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          this.reportError(err)
          socket.destroy()
          settle(err)
        }
      })

      socket.on('error', (error: Error) => {
        this.reportError(error)
        settle(error)
      })

      socket.on('close', () => {
        if (timer)
          clearTimeout(timer)
        this.failPending(new Error('云信连接已关闭'))
        const wasConnected = this.connected
        this.connected = false
        this.stopHeartbeat()
        settle(new Error('云信连接已关闭'))
        // 已登录过的会话断开：通知外层决定重连（初连失败不通知，由 connect 的 reject 表达）
        if (wasConnected && !this.stopped)
          this.options.onClose(this)
      })
    })
  }

  /** 发一个请求并按 serial 等响应；resultCode 非 200 即拒绝（错误带 code） */
  request(serviceId: number, commandId: number, body: Buffer, failureMessage: string): Promise<WirePacket> {
    if (!this.connected || !this.socket || !this.encryptor)
      return Promise.reject(new Error('云信会话未连接'))
    const serial = this.nextSerial()
    const encryptor = this.encryptor
    const socket = this.socket
    return new Promise<WirePacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(protocolError(`${failureMessage}：请求超时`, 0))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(serial, { serviceId, commandId, resolve, reject, timer })
      try {
        socket.write(encryptor.apply(makePacket(serviceId, commandId, serial, body)))
      }
      catch (error) {
        this.pending.delete(serial)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  destroy(): void {
    this.stopped = true
    this.connected = false
    this.failPending(new Error('云信会话已销毁'))
    this.stopHeartbeat()
    this.socket?.destroy()
    this.socket = null
  }

  private nextSerial(): number {
    const value = this.serial
    this.serial = value >= 32767 ? 2 : value + 1
    return value
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private reportError(error: Error): void {
    debug(`[nim-qchat] 会话异常: ${error.message}`)
  }

  /** 追加解密收到的字节并尽量吐出完整帧；每帧交给 onFrame 处理 */
  private handleChunk(chunk: Buffer, onFrame: (packet: WirePacket) => void): void {
    if (!this.decryptor)
      return
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, this.decryptor.apply(chunk)])
    while (this.receiveBuffer.length) {
      const length = readVarint(this.receiveBuffer)
      if (!length)
        break
      const packetLength = length.size + length.value
      if (this.receiveBuffer.length < packetLength)
        break
      const raw = this.receiveBuffer.subarray(0, packetLength)
      this.receiveBuffer = this.receiveBuffer.subarray(packetLength)
      let packet = decodePacket(raw)

      // 上行合并帧（serviceId 4）内嵌真实数据包
      if (packet.serviceId === 4 && [1, 2, 10, 11].includes(packet.commandId) && packet.body.length > 8) {
        const embedded = decodeEmbeddedPacket(packet.body.subarray(8))
        if (!embedded)
          continue
        packet = embedded
      }
      onFrame(packet)
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer)
      clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket || this.socket.destroyed || !this.encryptor)
        return
      this.socket.write(this.encryptor.apply(makePacket(SERVICE_HANDSHAKE, CMD_HEARTBEAT, this.nextSerial())))
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

// ===== 客户端：两条会话 + 订阅表 + 断线整体重连 =====

interface ChannelSubscription {
  serverId: string
  channelId: string
  visitor: boolean
}

export class NimQChatClient {
  connected = false

  private options: NimQChatClientOptions
  private nimSession: CommonlinkSession | null = null
  private qchatSession: CommonlinkSession | null = null
  /** 已订阅频道：断线重连后按此表恢复 */
  private subscriptions = new Map<string, ChannelSubscription>()
  private stopped = true
  private everConnected = false
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(options: NimQChatClientOptions) {
    this.options = options
  }

  /** 建立双会话并恢复订阅；已在连/已连则复用在途 Promise */
  connect(): Promise<void> {
    if (!this.stopped && this.connected)
      return Promise.resolve()
    if (this.connectPromise)
      return this.connectPromise
    this.stopped = false
    this.connectPromise = this.establish().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  /** 订阅频道：访客（25/9）优先，被拒（403/404）退正式成员（24/15） */
  async subscribeChannel(serverId: string, channelId: string): Promise<void> {
    if (!this.connected || !this.qchatSession)
      throw new Error('房间连接已断开')
    const key = channelKey(serverId, channelId)
    if (this.subscriptions.size >= CHANNEL_SUBSCRIBE_LIMIT && !this.subscriptions.has(key))
      throw new Error('云信频道订阅数已达上限')
    try {
      await this.requestSubscribe(serverId, channelId, true)
      this.subscriptions.set(key, { serverId, channelId, visitor: true })
      debug(`[nim-qchat] 订阅成功：${key}（访客）`)
      return
    }
    catch (error) {
      if (!isSubscribeRejected(error))
        throw error
      debug(`[nim-qchat] 访客订阅被拒，退正式成员订阅：${key}`)
    }
    await this.requestSubscribe(serverId, channelId, false)
    this.subscriptions.set(key, { serverId, channelId, visitor: false })
    debug(`[nim-qchat] 订阅成功：${key}（成员）`)
  }

  /** 退订频道：失败不抛（连接断开时退订本无意义），仅从订阅表摘除 */
  async unsubscribeChannel(serverId: string, channelId: string): Promise<void> {
    const key = channelKey(serverId, channelId)
    const subscription = this.subscriptions.get(key)
    this.subscriptions.delete(key)
    if (!subscription || !this.connected || !this.qchatSession)
      return
    try {
      await this.qchatSession.request(
        subscription.visitor ? SERVICE_QCHAT_VISITOR : SERVICE_QCHAT,
        subscription.visitor ? CMD_SUBSCRIBE_VISITOR : CMD_SUBSCRIBE_MEMBER,
        buildQChatSubscriptionBody(serverId, channelId, subscription.visitor, false),
        '退订房间频道失败',
      )
    }
    catch (error) {
      debug(`[nim-qchat] 退订失败（忽略）：${key} ${error instanceof Error ? error.message : error}`)
    }
  }

  /** 发送消息（24/10）；ACK 里带回服务端消息 ID 与时刻 */
  async sendMessage(input: QChatSendInput): Promise<QChatSendResult> {
    if (!this.connected || !this.qchatSession)
      throw new Error('房间连接已断开')
    const response = await this.qchatSession.request(
      SERVICE_QCHAT,
      CMD_QCHAT_SEND,
      encodeProperties(buildQChatMessageProperties(input, this.options.account)),
      '发送房间消息失败',
    )
    const acknowledged = response.body.length ? normalizeQChatMessage(response.body) : null
    return {
      msgIdClient: acknowledged?.msgIdClient || input.msgIdClient,
      msgIdServer: acknowledged?.msgIdServer || '',
      time: acknowledged?.time || Date.now(),
    }
  }

  destroy(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.subscriptions.clear()
    this.destroySessions()
  }

  /**
   * 双会话建立 + 订阅恢复；任一步失败即整体作废（静默清理，不触发重连）。
   * 登录身份恒为 AOS（属性 3 = 1，见 buildNimLoginPacket）；这一步会顶掉同账号的其他在线设备。
   */
  private async establish(): Promise<void> {
    const { appKey, account, token, nim } = this.options
    if (!appKey || !account || !token)
      throw new Error('缺少云信 AppKey、账号或令牌')
    this.destroySessions()
    try {
      const address = await requestNimAddress(appKey, account, nim.sdkVersion)
      const deviceId = pocketDeviceId()

      const nimSession = new CommonlinkSession({
        address,
        loginPacket: buildNimLoginPacket({ appKey, account, token, deviceId, nim }),
        loginServiceId: SERVICE_NIM,
        loginCommandId: CMD_NIM_LOGIN,
        loginLabel: 'NIM',
        onPacket: packet => debug(`[nim-qchat] NIM 帧 s=${packet.serviceId} c=${packet.commandId} code=${packet.resultCode}`),
        onClose: session => this.handleSessionClose(session),
      })
      this.nimSession = nimSession
      await nimSession.connect()

      // NIM 会话上索取 QChat 接入地址，再建第二条连接
      const addressResponse = await nimSession.request(
        SERVICE_QCHAT,
        CMD_QCHAT_ADDRESS,
        encodeProperties({ 1: 0 }),
        '获取 QChat 地址失败',
      )
      const qchatAddresses = decodeQChatStringArray(addressResponse.body)
      if (!qchatAddresses.length)
        throw new Error('云信没有返回 QChat 连接地址')

      const qchatSession = new CommonlinkSession({
        address: parseTcpAddress(qchatAddresses[0]),
        loginPacket: buildQChatLoginPacket({ appKey, account, token, deviceId, nim }),
        loginServiceId: SERVICE_QCHAT,
        loginCommandId: CMD_QCHAT_LOGIN,
        loginLabel: 'QChat',
        onPacket: (packet) => {
          if (packet.serviceId !== SERVICE_QCHAT || packet.commandId !== CMD_QCHAT_MESSAGE || !packet.body.length)
            return
          // 推送帧的 serial 是「会不会撞上在途请求」的唯一实测证据（正常应为 0 或独立序列）
          debug(`[nim-qchat] 推送 24/11 serial=${packet.serial}`)
          try {
            this.options.onMessage?.(normalizeQChatMessage(packet.body))
          }
          catch (error) {
            this.reportError(error instanceof Error ? error : new Error(String(error)))
          }
        },
        onClose: session => this.handleSessionClose(session),
      })
      this.qchatSession = qchatSession
      await qchatSession.connect()

      // 重连后恢复订阅（访客/成员身份重判，subscribeChannel 内部会更新订阅表）
      const restoring = [...this.subscriptions.values()]
      for (const subscription of restoring) {
        try {
          await this.subscribeChannel(subscription.serverId, subscription.channelId)
        }
        catch (error) {
          this.reportError(error instanceof Error ? error : new Error(String(error)))
        }
      }

      this.connected = true
      this.everConnected = true
      this.reconnectAttempt = 0
      debug(`[nim-qchat] QChat 已连接：账号=${account} 订阅=${this.subscriptions.size}`)
      this.options.onConnected?.()
    }
    catch (error) {
      this.destroySessions()
      throw error
    }
  }

  /** 静默作废两条会话：不走 onClose，因此不会触发重连（建立失败与显式销毁共用） */
  private destroySessions(): void {
    this.connected = false
    this.nimSession?.destroy()
    this.qchatSession?.destroy()
    this.nimSession = null
    this.qchatSession = null
  }

  /**
   * 任一会话异常断开：整体作废并按退避重连（QChat 地址需重新索取，无法单条续）。
   * 只认当前两条会话的关闭——上一次建立尝试残留的 socket 会在事件循环的任意时刻补到，
   * 放行会连「新会话」一起误杀。
   */
  private handleSessionClose(session: CommonlinkSession): void {
    if (session !== this.nimSession && session !== this.qchatSession)
      return
    if (this.stopped)
      return
    this.connected = false
    this.nimSession?.destroy()
    this.qchatSession?.destroy()
    if (!this.everConnected)
      return
    this.options.onDisconnected?.()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer)
    const attempt = this.reconnectAttempt + 1
    this.reconnectAttempt = attempt
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** Math.min(attempt, 5))
    this.options.onReconnecting?.(attempt)
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped)
        return
      // 走 connect 而非直接 establish：进房时的 connect 与此处共用同一 Promise，
      // 不会出现两条 establish 并发互毁会话
      this.connect().catch((error: Error) => {
        this.reportError(error)
        if (isFatalAuthError(error)) {
          this.destroy()
          this.options.onFatalAuthError?.(error)
          return
        }
        if (!this.stopped)
          this.scheduleReconnect()
      })
    }, delay)
  }

  private async requestSubscribe(serverId: string, channelId: string, visitor: boolean): Promise<void> {
    const session = this.qchatSession
    if (!session)
      throw new Error('房间连接已断开')
    const response = await session.request(
      visitor ? SERVICE_QCHAT_VISITOR : SERVICE_QCHAT,
      visitor ? CMD_SUBSCRIBE_VISITOR : CMD_SUBSCRIBE_MEMBER,
      buildQChatSubscriptionBody(serverId, channelId, visitor, true),
      '订阅房间频道失败',
    )
    if (readSubscribeFailures(response.body).includes(String(channelId)))
      throw protocolError('订阅房间频道被拒', 403)
  }

  private reportError(error: Error): void {
    this.options.onError?.(error)
    debug(`[nim-qchat] ${error.message}`)
  }
}

function channelKey(serverId: string, channelId: string): string {
  return `${serverId}:${channelId}`
}

function isSubscribeRejected(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code
  return code === 403 || code === 404
}

/** 云信不可恢复的认证类致命错误码（302 凭证失效、403 禁止访问、422 账号封禁） */
export const FATAL_AUTH_CODES = new Set([302, 403, 422])

/** 判定是否为凭证失效或不可恢复的账号认证错误（重试无意义，必须立即停止重连） */
export function isFatalAuthError(error: unknown): boolean {
  if (!error)
    return false
  if (error instanceof Error && error.message.includes('缺少云信'))
    return true
  const code = (error as { code?: number } | null)?.code
  return typeof code === 'number' && FATAL_AUTH_CODES.has(code)
}
