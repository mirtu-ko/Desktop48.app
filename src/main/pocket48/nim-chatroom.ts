/**
 * 网易云信聊天室 TCP 协议客户端（弹幕收发的最小实现）。
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
 * - 发弹幕（13_6）：属性表 1=消息 ID、2=100（自定义）、3=附件、4=业务扩展 JSON、
 *   10/11=反垃圾；见 buildChatroomMessageBody
 *
 * 帧 / 属性表 / RC4 / 握手等共用原语见 nim-common.ts（圈组 QChat 客户端共用）；
 * TCP/握手/心跳骨架见 nim-session.ts。
 */
import type { PocketRawChatMessage } from '@preload/ipc-contract'
import type { NimClientIdentity } from './client-profile'
import type { NimSession, SessionFactory, SessionOptions, TcpAddress } from './nim-session'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { POCKET_DANMAKU_MAX_LENGTH } from '@common/live-danmaku'
import { debug } from '../logger'
import { pocketDeviceId } from './client-profile'
import { decodeProperties, encodeProperties, makePacket, text } from './nim-common'
import { CommonlinkSession, LBS_TIMEOUT_MS, parseTcpAddress, RECONNECT_MAX_DELAY_MS } from './nim-session'

const LBS_URL = 'https://lbs.netease.im/lbs/chat.jsp'

// 服务号 / 指令号（本客户端只用到这几个）
const SERVICE_CHATROOM = 13
const CMD_CHATROOM_LOGIN = 2
/** 发送消息（上行）：帧体是属性表，官方 SDK `ChatRoomMessageSender` 同构 */
const CMD_CHATROOM_SEND = 6
const CMD_CHATROOM_MESSAGE = 7
const CMD_CHATROOM_ACK = 35

/** 云信消息类型：0=文本，100=自定义（口袋的业务扩展都挂在这一类上） */
const MSG_TYPE_CUSTOM = 100

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

// ===== 弹幕发送包构造 =====

/**
 * 发送弹幕时的发送者特征：对应官方 `AppIMMessage` 的 `user` 与 `config` 两块展示字段。
 * 由调用方按「当前账号资料 + 当前档位」拼好传入（客户端不自己去取 HTTP 资料），
 * 保证与聊天室登录身份、HTTP 请求头来自同一次档位判定。
 */
export interface ChatroomSender {
  user: {
    userId: string
    nickName: string
    avatar: string
    level: number
    roleId: number
    vip: boolean
    pfUrl: string
    teamLogo: string
    badge: string[]
  }
  /** 客户端名（官方 `fromApp` / `config.appName`）：pocket48 / seine48 */
  appName: string
  appVersion: string
  /** 机型（官方 `config.model`） */
  deviceModel: string
  /** 系统版本（官方 `config.release`） */
  osVersion: string
}

export interface ChatroomSendInput {
  /** 客户端消息 ID（自己生成，服务端沿用后作为消息标识） */
  uuid: string
  /** 聊天室 ID */
  roomId: string
  /** 直播 ID：进业务扩展的 `sourceId`，接收端据此过滤跨场串扰 */
  liveId: string
  text: string
  sender: ChatroomSender
}

/**
 * 构造 13/6（聊天室发消息）帧体属性表，字段与官方 `createNimChatRoomMsg` 逐项对齐：
 * - 1 = 消息 ID、2 = 100（自定义）、3 = 附件（自定义消息无附件，官方恒写空串）
 * - 4 = remoteExtension（`AppIMMessage` 的 JSON，业务类型 / 正文 / 发送者都在这里）
 * - 10 + 11 = 反垃圾开关与待检测正文（官方 `NIMAntiSpamOption` 同构）
 *
 * 正文只进扩展的 `text`，不进属性 3：接收端（含本客户端）都按扩展取正文，
 * 放进附件反而会被当成另一种消息形态。
 */
export function buildChatroomMessageBody(input: ChatroomSendInput): Buffer {
  const { uuid, roomId, liveId, text: content, sender } = input
  const extension = {
    messageType: 'BARRAGE_NORMAL',
    module: 'live',
    text: content,
    roomId,
    sourceId: liveId,
    fromApp: sender.appName,
    config: {
      model: sender.deviceModel,
      release: sender.osVersion,
      appName: sender.appName,
      versionName: sender.appVersion,
    },
    user: {
      userId: sender.user.userId,
      nickName: sender.user.nickName,
      // 头像两种读取口径都带上：本客户端与部分官方版本读 userAvatar，另一些读 avatar
      userAvatar: sender.user.avatar,
      avatar: sender.user.avatar,
      level: sender.user.level,
      roleId: sender.user.roleId,
      vip: sender.user.vip,
      pfUrl: sender.user.pfUrl,
      teamLogo: sender.user.teamLogo,
      badge: sender.user.badge,
    },
  }
  return encodeProperties({
    1: uuid,
    2: MSG_TYPE_CUSTOM,
    // 零长 Buffer 而非空串：encodeProperties 会跳过空串，缺键与官方的「有键、值为空」不一致
    3: Buffer.alloc(0),
    4: JSON.stringify(extension),
    10: 1,
    11: JSON.stringify({ type: '1', data: content }),
  })
}

/** 发送结果：服务端回执的消息 ID 与时刻（缺省回落本地生成值） */
export interface ChatroomSendResult {
  uuid: string
  time: number
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
  /** 仅供测试：替换 TCP 会话实现，缺省走 CommonlinkSession（生产不传） */
  sessionFactory?: SessionFactory
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
  private session: NimSession | null = null
  private stopped = true
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.session?.destroy()
    this.session = null
  }

  /**
   * 发送一条弹幕（13/6），等服务端回执后返回消息 ID 与时刻。
   * 只在**已建立**的会话上发送：未连接直接拒绝，不在这里新建连接
   * （会话生命周期归 pocket-danmaku，发送方不能擅自拉起第二条 TCP）。
   */
  async sendMessage(input: { text: string, liveId: string, sender: ChatroomSender }): Promise<ChatroomSendResult> {
    const content = String(input.text || '').trim()
    if (!content)
      throw new Error('请输入弹幕内容')
    if (content.length > POCKET_DANMAKU_MAX_LENGTH)
      throw new Error(`弹幕不能超过 ${POCKET_DANMAKU_MAX_LENGTH} 个字`)
    const liveId = String(input.liveId || '').trim()
    if (!liveId)
      throw new Error('直播信息未就绪，无法发送弹幕')
    const session = this.session
    if (!this.connected || !session?.connected)
      throw new Error('互动消息未连接，请稍后再试')

    const uuid = randomUUID()
    const body = buildChatroomMessageBody({
      uuid,
      roomId: this.options.roomId,
      liveId,
      text: content,
      sender: input.sender,
    })
    const response = await session.request(SERVICE_CHATROOM, CMD_CHATROOM_SEND, body, '发送弹幕失败')
    // 回执是属性表；解析失败不影响「已发出」这个结论，按本地值兜底
    let ackUuid = ''
    let ackTime = 0
    try {
      const properties = decodeProperties(response.body)
      ackUuid = text(properties.get(1))
      ackTime = Number(text(properties.get(20)) || 0)
    }
    catch {
      // 空回执：服务端只回结果码，消息仍可能已投递
    }
    debug(`[nim-chatroom] 弹幕已发送：房间=${this.options.roomId} uuid=${ackUuid || uuid}`)
    return { uuid: ackUuid || uuid, time: ackTime || Date.now() }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    }
    catch {
      // 回调异常不影响连接生命周期
    }
  }

  /** LBS 取聊天室 TCP 接入地址（chat.jsp 带 rid；解析与会话层共用 parseTcpAddress） */
  private async requestAddress(): Promise<TcpAddress> {
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
    return parseTcpAddress(String(Array.isArray(result.link) ? result.link[0] : '').trim())
  }

  /** 建会话：生产走真实 TCP（CommonlinkSession），测试可经 options.sessionFactory 注入假会话 */
  private createSession(options: SessionOptions): NimSession {
    return this.options.sessionFactory ? this.options.sessionFactory(options) : new CommonlinkSession(options)
  }

  private async openConnection(): Promise<void> {
    const { appKey, account, token, roomId, nim } = this.options
    debug(`[nim-chatroom] 连接聊天室：房间=${roomId} 账号=${account} 身份=${nim.packageName}@${nim.sdkVersion}`)
    const address = await this.requestAddress()
    const session = this.createSession({
      address,
      // 登录包 serial 硬编码 1（与 QChat 的 buildNimLoginPacket 同款）；会话 serial 从 2 起，
      // 与旧实现的「enter 消耗 1、ACK/心跳从 2 起」线上序列一致
      loginPacket: makePacket(
        SERVICE_CHATROOM,
        CMD_CHATROOM_LOGIN,
        1,
        buildChatroomLoginBody({ appKey, account, token, roomId, deviceId: pocketDeviceId(), nim }),
      ),
      loginServiceId: SERVICE_CHATROOM,
      loginCommandId: CMD_CHATROOM_LOGIN,
      loginLabel: '聊天室',
      onPacket: (packet) => {
        if (packet.serviceId === SERVICE_CHATROOM && packet.commandId === CMD_CHATROOM_MESSAGE) {
          this.handleMessage(packet.body)
          return
        }
        // 诊断：记录所有未在上方分支处理的帧（心跳应答 / 服务端推送 / 未知指令）
        debug(`[nim-chatroom] 帧 s=${packet.serviceId} c=${packet.commandId} code=${packet.resultCode} bodyLen=${packet.body.length}`)
      },
      // 会话层保证只在「已登录过且非主动销毁」时回调；只认当前会话，防旧会话迟到事件误杀新连接
      onClose: (closed) => {
        if (closed !== this.session || this.stopped)
          return
        this.connected = false
        this.session?.destroy()
        this.options.onDisconnected?.()
        this.scheduleReconnect()
      },
      onError: error => this.reportError(error),
    })
    this.session = session
    await session.connect()
    this.connected = true
    this.reconnectAttempt = 0
    this.options.onConnected?.()
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

    // 服务端要求回执的消息（属性 38='1'）：fire-and-forget，未连接时 send 内部静默丢弃
    if (text(properties.get(38)) === '1' && message.uuid)
      this.session?.send(SERVICE_CHATROOM, CMD_CHATROOM_ACK, encodeProperties({ 1: message.uuid, 2: this.options.roomId }))
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
