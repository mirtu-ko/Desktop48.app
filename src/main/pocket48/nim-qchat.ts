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
 * 登录身份（SDK 版本 + 包名）取 client-profile.ts 的 `nimIdentity()`（塞纳河48 APK），
 * 与聊天室、HTTP 同源——参考实现的 QChat 文件报的是旧版 seine SDK，本项目口径以 client-profile 为准。
 *
 * 终端类型（属性 3）恒为 AOS：两个官方 App 都是 Android 客户端，忠实模拟即报 AOS。
 * 注意 `2/2` 是账号级登录，登录即在线，会顶掉同账号的其他在线设备。
 *
 * 会话骨架（握手 → 登录 → 请求/响应 + 心跳）见 nim-session.ts，本文件只保留 QChat 协议族。
 */
import type { NimClientIdentity } from './client-profile'

import type { NimSession, SessionFactory, SessionOptions, TcpAddress } from './nim-session'
import { Buffer } from 'node:buffer'
import { debug } from '../logger'
import { pocketDeviceId } from './client-profile'
import {
  decodeProperties,
  encodeProperties,
  encodeVarint,
  makePacket,
  readVarint,
  text,
} from './nim-common'
import { CommonlinkSession, LBS_TIMEOUT_MS, parseTcpAddress, protocolError, RECONNECT_MAX_DELAY_MS } from './nim-session'

// ===== 协议常量 =====

/** NIM LBS（与聊天室的 lbs/chat.jsp 是两个端点；回包取 common.link[0]） */
const NIM_LBS_URL = 'https://lbs.netease.im/lbs/conf.jsp'

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
  /** 仅供测试：替换 TCP 会话实现，缺省走 CommonlinkSession（生产不传） */
  sessionFactory?: SessionFactory
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

// ===== 客户端：两条会话 + 订阅表 + 断线整体重连 =====

interface ChannelSubscription {
  serverId: string
  channelId: string
  visitor: boolean
}

export class NimQChatClient {
  connected = false

  private options: NimQChatClientOptions
  private nimSession: NimSession | null = null
  private qchatSession: NimSession | null = null
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

  /** 建会话：生产走真实 TCP（CommonlinkSession），测试可经 options.sessionFactory 注入假会话 */
  private createSession(options: SessionOptions): NimSession {
    return this.options.sessionFactory ? this.options.sessionFactory(options) : new CommonlinkSession(options)
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

      const nimSession = this.createSession({
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

      const qchatSession = this.createSession({
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

      // 置位必须在恢复订阅之前：subscribeChannel 以 connected 为守卫，晚于循环会让
      // 每条恢复都抛「房间连接已断开」——订阅表条目还在、线上零订阅，随后照样广播
      // connected（HTTP 轮询还能跑，界面上看不出异常）
      this.connected = true
      this.everConnected = true
      this.reconnectAttempt = 0

      // 重连后恢复订阅（访客/成员身份重判，subscribeChannel 内部会更新订阅表）
      const restoring = [...this.subscriptions.values()]
      let restored = 0
      for (const subscription of restoring) {
        try {
          await this.subscribeChannel(subscription.serverId, subscription.channelId)
          restored++
        }
        catch (error) {
          this.reportError(error instanceof Error ? error : new Error(String(error)))
        }
      }

      // 「已连接」的语义是「订阅可用」，所以这句必须晚于恢复：先报已连接再恢复，
      // 渲染层就会在收不到推送的状态下显示正常。恢复期间若连接又断了，不再补报
      debug(`[nim-qchat] QChat 已连接：账号=${account} 订阅恢复=${restored}/${restoring.length}`)
      if (this.connected)
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
  private handleSessionClose(session: NimSession): void {
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
