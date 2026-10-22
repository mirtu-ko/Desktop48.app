/**
 * 网易云信聊天室 TCP 协议客户端（只收弹幕的最小实现）。
 *
 * 按云信移动端 TCP 协议直连（云信应用只允许移动端登录，Web SDK 会被服务端拒）：
 * LBS 取地址 → RSA 握手交换 RC4 密钥
 * → 以安卓客户端身份登录进入聊天室 → 接收消息流。
 * 其中的包名与 SDK 版本由调用方按当前档位传入（`NimClientIdentity`，见 client-profile.ts），
 * 设备 ID 取自 `client-profile.ts`（与口袋 HTTP 同一台设备；由 UUID 抽 16 位小写 hex，
 * 仅作登录属性，不参与签名）。
 *
 * 协议要点：
 * - 帧：varint(总长) + header{serviceId, commandId, serial:i16LE, tag} + body；
 *   tag bit0 = body 已 zlib 压缩（前 4 字节 i32LE 为解压后长度），bit1 = 帧头带 i16LE 结果码
 * - 属性表：varint(数量) + N × (varint(key) + varint(len) + bytes)
 * - 握手（1_1）：i32LE(密钥版本) + RSA 分块加密的 [varint(len)+RC4密钥 + 登录包]
 * - 登录（13_2）：[0x02] + 房间属性表 + 认证属性表（SDK 版本/包名等移动端身份，
 *   token 放属性 1000）；握手应答后需再以 RC4 发一次登录包
 * - 心跳（1_2，15s）；消息（13_7）；属性 38='1' 的消息需回执（13_35）
 *
 * 帧 / 属性表 / RC4 / 握手等共用原语见 nim-common.ts（圈组 QChat 客户端共用）。
 */
import type { PocketRawChatMessage } from '@preload/ipc-contract'
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
  makeHandshake,
  makePacket,
  Rc4Stream,
  readVarint,
  text,
} from './nim-common'

const LBS_URL = 'https://lbs.netease.im/lbs/chat.jsp'

// 服务号 / 指令号（本客户端只用到这几个）
const SERVICE_HANDSHAKE = 1
const CMD_HANDSHAKE = 1
const CMD_HEARTBEAT = 2
const SERVICE_CHATROOM = 13
const CMD_CHATROOM_LOGIN = 2
const CMD_CHATROOM_MESSAGE = 7
const CMD_CHATROOM_ACK = 35

const CONNECT_TIMEOUT_MS = 20_000
const LBS_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 45_000
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_MAX_DELAY_MS = 30_000
/** 消息去重容量：环形丢弃最老的 uuid，防长直播内存增长 */
const SEEN_MESSAGE_LIMIT = 2048

// ===== 登录包构造 =====

/**
 * 构造聊天室登录包体：`[0x02] + 房间属性表 + 认证属性表`。
 * 认证属性里的 **6 = SDK 版本、25 = 包名**就是「以哪个客户端身份进房」，
 * 取自档位的云信身份（`NimClientIdentity`）。独立成纯函数便于直接断言这两个字段，
 * 也避免身份来源在类内部再次隐式取用。
 */
export function buildChatroomLoginBody(input: {
  appKey: string
  account: string
  token: string
  roomId: string
  deviceId: string
  nim: NimClientIdentity
}): Buffer {
  const roomProperties = encodeProperties({
    1: input.appKey,
    2: input.account,
    3: input.deviceId,
    5: input.roomId,
    8: 1,
  })
  const authProperties = encodeProperties({
    3: 1,
    4: '8.0.0',
    6: input.nim.sdkVersion,
    9: 1,
    13: input.deviceId,
    18: input.appKey,
    19: input.account,
    25: input.nim.packageName,
    1000: input.token,
  })
  return Buffer.concat([Buffer.from([2]), roomProperties, authProperties])
}

// ===== 客户端 =====

export interface NimChatroomClientOptions {
  appKey: string
  account: string
  token: string
  roomId: string
  /**
   * 以哪个客户端的身份进聊天室（SDK 版本 + 包名）。由调用方按当前档位取值，
   * 与 HTTP 请求同档——见 `client-profile.ts` 的 `nimIdentityFor`。
   */
  nim: NimClientIdentity
  onConnected?: () => void
  /** 断线后开始第 N 次重连 */
  onReconnecting?: (attempt: number) => void
  onDisconnected?: () => void
  onMessage?: (message: PocketRawChatMessage) => void
  onError?: (error: Error) => void
}

export class NimChatroomClient {
  connected = false

  private options: NimChatroomClientOptions
  private socket: net.Socket | null = null
  private encryptor: Rc4Stream | null = null
  private decryptor: Rc4Stream | null = null
  private receiveBuffer = Buffer.alloc(0)
  private serial = 1
  private stopped = true
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private seenMessageIds = new Set<string>()

  constructor(options: NimChatroomClientOptions) {
    this.options = options
  }

  /** 建立连接并进入聊天室；resolve 即登录成功，reject 为终态（不内部重试初连） */
  connect(): Promise<void> {
    const { appKey, account, token, roomId } = this.options
    if (!appKey || !account || !token || !/^\d{1,32}$/.test(roomId))
      return Promise.reject(new Error('聊天室连接参数无效（appKey/账号/凭据/房间 ID）'))
    this.stopped = false
    return this.openConnection()
  }

  destroy(): void {
    this.stopped = true
    this.connected = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.destroy()
    this.socket = null
  }

  private nextSerial(): number {
    const value = this.serial
    this.serial = value >= 32767 ? 1 : value + 1
    return value
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    }
    catch {
      // 回调异常不影响连接生命周期
    }
  }

  /** LBS 取聊天室 TCP 接入地址 */
  private async requestAddress(): Promise<{ host: string, port: number }> {
    const url = new URL(LBS_URL)
    url.search = new URLSearchParams({
      k: this.options.appKey,
      id: this.options.account,
      rid: this.options.roomId,
      v: String(this.options.nim.sdkVersion),
      tp: '1',
      dt: '0',
      nt: '2',
    }).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(LBS_TIMEOUT_MS) })
    if (!response.ok)
      throw new Error(`获取聊天室地址失败（HTTP ${response.status}）`)
    const result = await response.json() as { link?: unknown }
    const address = String(Array.isArray(result.link) ? result.link[0] : '').trim()
    const separator = address.lastIndexOf(':')
    const host = separator > 0 ? address.slice(0, separator).replace(/^\[|\]$/g, '') : ''
    const port = Number(address.slice(separator + 1))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('云信未返回有效的聊天室 TCP 地址')
    return { host, port }
  }

  /** 登录包：帧头 + `buildChatroomLoginBody`（身份取自 options.nim） */
  private makeEnterPacket(deviceId: string): Buffer {
    const { appKey, account, token, roomId, nim } = this.options
    return makePacket(
      SERVICE_CHATROOM,
      CMD_CHATROOM_LOGIN,
      this.nextSerial(),
      buildChatroomLoginBody({ appKey, account, token, roomId, deviceId, nim }),
    )
  }

  private async openConnection(): Promise<void> {
    const { account, roomId, nim } = this.options
    debug(`[nim-chatroom] 连接聊天室：房间=${roomId} 账号=${account} 身份=${nim.packageName}@${nim.sdkVersion}`)
    const address = await this.requestAddress()
    const key = randomBytes(16)
    const enterPacket = this.makeEnterPacket(pocketDeviceId())
    const handshake = makeHandshake(key, enterPacket)
    this.encryptor = new Rc4Stream(key)
    this.decryptor = new Rc4Stream(key)
    this.receiveBuffer = Buffer.alloc(0)
    this.connected = false

    return new Promise<void>((resolve, reject) => {
      let enterSent = false
      let settled = false
      let connectTimer: ReturnType<typeof setTimeout> | null = null
      const settle = (error?: Error) => {
        if (settled)
          return
        settled = true
        if (connectTimer)
          clearTimeout(connectTimer)
        if (error)
          reject(error)
        else
          resolve()
      }
      connectTimer = setTimeout(() => {
        this.socket?.destroy()
        settle(new Error('连接直播聊天室超时'))
      }, CONNECT_TIMEOUT_MS)

      const socket = net.createConnection(address)
      this.socket = socket
      socket.setKeepAlive(true, 15_000)
      socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        this.reportError(new Error('聊天室连接空闲超时'))
        socket.destroy()
      })

      socket.on('connect', () => {
        socket.write(handshake)
      })

      socket.on('data', (chunk: Buffer) => {
        try {
          this.handleChunk(chunk, (packet) => {
            // 握手应答：成功后把登录包再以 RC4 发一次
            if (packet.serviceId === SERVICE_HANDSHAKE && packet.commandId === CMD_HANDSHAKE) {
              if (packet.resultCode !== 200)
                throw new Error(`聊天室握手失败（${packet.resultCode}）`)
              if (!enterSent) {
                enterSent = true
                socket.write(this.encryptor!.apply(enterPacket))
              }
              return
            }
            if (packet.serviceId === SERVICE_CHATROOM && packet.commandId === CMD_CHATROOM_LOGIN) {
              if (packet.resultCode !== 200)
                throw new Error(`进入聊天室被拒（${packet.resultCode}），可能是登录已过期`)
              this.connected = true
              this.reconnectAttempt = 0
              this.startHeartbeat()
              this.options.onConnected?.()
              settle()
              return
            }
            if (packet.serviceId === SERVICE_CHATROOM && packet.commandId === CMD_CHATROOM_MESSAGE) {
              this.handleMessage(packet.body)
              return
            }
            // 诊断：记录所有未在上方分支处理的帧（心跳应答 / 服务端推送 / 未知指令）
            debug(`[nim-chatroom] 帧 s=${packet.serviceId} c=${packet.commandId} code=${packet.resultCode} bodyLen=${packet.body.length}`)
          })
        }
        catch (error) {
          this.reportError(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      })

      socket.on('error', (error: Error) => {
        this.reportError(error)
        settle(error)
      })

      socket.on('close', () => {
        const wasConnected = this.connected
        this.connected = false
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        if (!settled) {
          settle(new Error('聊天室连接已关闭'))
          return
        }
        // 已进入过聊天室的断开：自动重连（初连失败不重试，由调用方决定）
        if (wasConnected && !this.stopped) {
          this.options.onDisconnected?.()
          this.scheduleReconnect()
        }
      })
    })
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

  private handleMessage(body: Buffer): void {
    let properties: Map<number, Buffer>
    try {
      properties = decodeProperties(body)
    }
    catch (error) {
      // 属性表解析失败不能静默：会表现为「已进入但永远收不到消息」
      debug(`[nim-chatroom] 消息属性表解析失败（body ${body.length}B）:`, error instanceof Error ? error.message : error)
      return
    }
    const uuid = text(properties.get(1))
    const msgType = Number(text(properties.get(2)) || -1)
    const isText = msgType === 0
    const attach = text(properties.get(3))
    const message: PocketRawChatMessage = {
      uuid,
      type: isText ? 'text' : 'custom',
      msgType,
      attach,
      custom: text(properties.get(4)),
      text: isText ? attach : text(properties.get(13)),
      fromNick: text(properties.get(7)),
      fromAvatar: text(properties.get(8)),
      from: text(properties.get(21)),
      time: Number(text(properties.get(20)) || Date.now()),
    }
    debug(
      `[nim-chatroom] 收到消息: uuid=${message.uuid || '∅'} type=${message.type}(${message.msgType})`
      + ` nick=${message.fromNick || '∅'} attach=${message.attach.slice(0, 100) || '∅'}`
      + ` custom=${message.custom.slice(0, 160) || '∅'}`,
    )
    // 用户信息字段摸底：完整打印扩展里的 user 对象（含头像/等级/徽章等候选展示字段）
    if (message.custom) {
      try {
        const extension = JSON.parse(message.custom) as { user?: unknown, messageType?: string, liveUpdateInfo?: { topList?: unknown[] } }
        debug(`[nim-chatroom] 消息 ${extension.messageType || '?'} 的 user 对象:`, JSON.stringify(extension.user ?? null))
        // 榜单消息的用户在 liveUpdateInfo.topList[].user 里，单独完整打印首条
        const firstTop = extension.liveUpdateInfo?.topList?.[0]
        if (firstTop !== undefined)
          debug(`[nim-chatroom] 榜单 topList[0] 完整条目:`, JSON.stringify(firstTop))
      }
      catch {
        // custom 不是 JSON（纯文本弹幕等）：忽略
      }
    }

    if (message.uuid) {
      if (this.seenMessageIds.has(message.uuid))
        return
      this.seenMessageIds.add(message.uuid)
      if (this.seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
        const oldest = this.seenMessageIds.values().next().value
        if (oldest !== undefined)
          this.seenMessageIds.delete(oldest)
      }
    }
    this.options.onMessage?.(message)

    // 服务端要求回执的消息（属性 38='1'）
    if (text(properties.get(38)) === '1' && message.uuid && this.socket && !this.socket.destroyed) {
      const ack = makePacket(
        SERVICE_CHATROOM,
        CMD_CHATROOM_ACK,
        this.nextSerial(),
        encodeProperties({ 1: message.uuid, 2: this.options.roomId }),
      )
      this.socket.write(this.encryptor!.apply(ack))
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
      this.openConnection().catch((error: Error) => {
        this.reportError(error)
        if (!this.stopped)
          this.scheduleReconnect()
      })
    }, delay)
  }
}
