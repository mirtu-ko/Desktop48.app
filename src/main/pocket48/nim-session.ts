/**
 * 网易云信 commonlink 单 TCP 会话：握手（RSA 交换 RC4 密钥）→ 登录 → 请求/响应 + 心跳。
 * 聊天室（nim-chatroom.ts，服务号 13）与圈组 QChat（nim-qchat.ts，服务号 24/25）共用；
 * 差别只在调用方传入的登录包 / 服务号 / 帧语义（onPacket 分发）。
 * 帧 / 属性表 / RC4 / 握手原语见 nim-common.ts。
 */
import type { WirePacket } from './nim-common'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { debug } from '../logger'
import {
  decodeEmbeddedPacket,
  decodePacket,
  decodeProperties,
  makeHandshake,
  makePacket,
  Rc4Stream,
  readVarint,
} from './nim-common'

// ===== 协议常量 =====

const SERVICE_HANDSHAKE = 1
const CMD_HANDSHAKE = 1
const CMD_HEARTBEAT = 2

const CONNECT_TIMEOUT_MS = 20_000
export const LBS_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 45_000
const HEARTBEAT_INTERVAL_MS = 15_000
/** 单请求超时（参考实现同值）：超时即失败，不无限等 */
const REQUEST_TIMEOUT_MS = 12_000
export const RECONNECT_MAX_DELAY_MS = 30_000

// ===== 内部工具 =====

export interface TcpAddress {
  host: string
  port: number
}

export function protocolError(message: string, code: number): Error {
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

export function parseTcpAddress(address: string): TcpAddress {
  const separator = address.lastIndexOf(':')
  const host = separator > 0 ? address.slice(0, separator).replace(/^\[|\]$/g, '') : ''
  const port = Number(address.slice(separator + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('云信未返回有效的连接地址')
  return { host, port }
}

// ===== 单条 commonlink 会话（一条 TCP：握手 → 登录 → 请求/响应 + 心跳） =====

export interface SessionOptions {
  address: TcpAddress
  loginPacket: Buffer
  loginServiceId: number
  loginCommandId: number
  /** 登录名（诊断用）：NIM / QChat，拒绝时报「哪次登录」被拒 */
  loginLabel: string
  onPacket?: (packet: WirePacket) => void
  /** 已登录过的会话断开；带上会话自身，供上层识别「是不是当前这条」（非当前会话的关闭要忽略） */
  onClose: (session: NimSession) => void
  /** 会话内部异常（socket 错误 / 空闲超时 / 帧解析失败）：缺省只 debug 日志 */
  onError?: (error: Error) => void
}

export type SessionFactory = (options: SessionOptions) => NimSession

/** 一条 commonlink 会话的最小契约：真实实现是 CommonlinkSession，测试可注入假会话 */
export interface NimSession {
  connected: boolean
  connect: () => Promise<void>
  request: (serviceId: number, commandId: number, body: Buffer, failureMessage: string) => Promise<WirePacket>
  /** fire-and-forget 发送（聊天室回执 13/35 用）：未连接时静默丢弃 */
  send: (serviceId: number, commandId: number, body: Buffer) => void
  destroy: () => void
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

export class CommonlinkSession implements NimSession {
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
                  debug(`[nim-session] ${this.options.loginLabel} 登录被拒（${packet.resultCode}）：${detail}`)
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
              debug(`[nim-session] 应答 s=${packet.serviceId} c=${packet.commandId} serial=${packet.serial} code=${packet.resultCode}`)
              if (packet.resultCode === 200)
                pending.resolve(packet)
              else
                pending.reject(protocolError('云信请求失败', packet.resultCode))
              return
            }
            if (pending) {
              // 这行日志是「服务端应答的 s/c 是否与请求一致」的实测依据：
              // 若发送一直超时，先看这里打出的实收 s/c
              debug(`[nim-session] serial ${packet.serial} 命中在途请求但 s/c 不符`
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

  send(serviceId: number, commandId: number, body: Buffer): void {
    if (!this.connected || !this.socket || this.socket.destroyed || !this.encryptor)
      return
    this.socket.write(this.encryptor.apply(makePacket(serviceId, commandId, this.nextSerial(), body)))
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
    debug(`[nim-session] 会话异常: ${error.message}`)
    this.options.onError?.(error)
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
