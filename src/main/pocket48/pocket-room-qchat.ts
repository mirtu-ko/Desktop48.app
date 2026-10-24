/**
 * 成员房间消息发送会话（主进程持有 QChat 长连接，协议见 nim-qchat.ts）。
 *
 * 与 pocket-danmaku.ts 同一「会话 + 订阅者」模式：同一账号复用一条 QChat 连接，
 * 按频道订阅 / 退订（引用计数）；渲染层房间页确认后订阅、离房退订，切房时
 * **先订新房再退旧房**——旧频道若是最后一条订阅，退了会整条连接销毁，切房体验断裂。
 * 凭据（accid + imToken）由主进程内部取用（getImCredentials），渲染层接触不到。
 *
 * 登录态变更（登出 / token 失效）时 resetRoomQChatSessions 断掉全部会话：
 * 旧连接用的是旧档进房身份与已作废 token，继续挂着只会收到「已过期」，不该沿用。
 *
 * 建连会顶掉同账号的其他在线设备（手机端），故默认不连——由房间页确认后才调用 enter。
 */
import type {
  PocketRoomBatch,
  PocketRoomQChatEnterResult,
  PocketRoomQChatMessage,
  PocketRoomReplyTarget,
  PocketRoomSendResult,
} from '@preload/ipc-contract'
import type { WebContents } from 'electron'
import { sendIpc } from '../ipc/send'
import { debug } from '../logger'
import { nimIdentityFor } from './client-profile'
import { isFatalAuthError, NimQChatClient } from './nim-qchat'
import { currentClientProfile, expireStoredAuth, getImCredentials, getRoomPermissions, getRoomSenderProfile, IM_APP_KEY } from './pocket-auth'
import { buildRoomSendInput } from './room-message-payload'

/**
 * 发送冷却下限（与服务端常规房间的 cdTime 同为 10s 之下的保守起点）。
 * 实际冷却取 max(本值, 服务端房间级 cdTime)——cdTime 才是真正的限流窗口，
 * 只按 1.5s 放行会让第二条起全被服务端拒绝。
 */
const SEND_INTERVAL_MS = 1500

interface ChannelState {
  serverId: string
  channelId: string
  /**
   * 订阅该频道事件的窗口（进房的房间页；多窗口各存一份）→ 该窗口的 destroyed 钩子。
   * 钩子必须随订阅一起摘：切房 A→B→A 会重新登记订阅，只删订阅者不摘钩子会逐次累积。
   */
  subscribers: Map<WebContents, () => void>
  /** 本频道上次发送时刻：冷却按房间算（服务端 cdTime 是房间级） */
  lastSentAt: number
  /** 服务端房间级发言冷却（毫秒），进房预热写入；0 = 未知，按本地下限 */
  cooldownMs: number
}

interface RoomSession {
  client: NimQChatClient
  accid: string
  channels: Map<string, ChannelState>
  /** 首次连接 / 重连进行中：此间的 onError 不代表「已断开」，别推 disconnected 翻转指示 */
  establishing: boolean
}

/** 账号维度会话表：切换账号（登出 → 换号登录）时整体重置 */
const sessions = new Map<string, RoomSession>()

function channelKey(serverId: string, channelId: string): string {
  return `${serverId}:${channelId}`
}

function pushBatch(session: RoomSession, batch: PocketRoomBatch): void {
  for (const channel of session.channels.values()) {
    for (const subscriber of channel.subscribers.keys()) {
      if (!subscriber.isDestroyed())
        sendIpc(subscriber, 'pocketRoomBatch', batch)
    }
  }
}

/** 摘掉窗口在该频道的订阅与 destroyed 钩子；不在订阅表返回 false（钩子与显式退订可能先后到达） */
function detachSubscriber(channel: ChannelState, sender: WebContents): boolean {
  const hook = channel.subscribers.get(sender)
  if (!hook)
    return false
  channel.subscribers.delete(sender)
  sender.removeListener('destroyed', hook)
  return true
}

/** 摘除某窗口对某频道的订阅（含 destroyed 钩子）；无剩余订阅者即退订，连接上无剩余频道即销毁 */
async function leaveChannel(session: RoomSession, key: string, sender: WebContents): Promise<void> {
  const channel = session.channels.get(key)
  if (!channel || !detachSubscriber(channel, sender))
    return
  if (channel.subscribers.size > 0)
    return
  session.channels.delete(key)
  await session.client.unsubscribeChannel(channel.serverId, channel.channelId)
  if (session.channels.size === 0) {
    session.client.destroy()
    // 身份守卫：登出重登后旧会话的钩子可能晚到，不能顺手删掉同账号的新会话
    if (sessions.get(session.accid) === session)
      sessions.delete(session.accid)
    debug(`[pocket-room-qchat] 账号 ${session.accid} 无剩余订阅，连接已断开`)
  }
}

/**
 * 进房时预热本频道的服务端冷却（cdTime）。
 *
 * 不阻塞进房：权限回包晚到只影响「下一条消息的冷却长度」，不影响订阅与首屏。
 * 失败静默——拉不到就按本地下限走，真发快了服务端仍会拒绝兜底。
 */
function primeChannelCooldown(channel: ChannelState): void {
  void getRoomPermissions(channel.channelId).then((permission) => {
    const cdMs = (permission?.cdTime ?? 0) * 1000
    if (cdMs > channel.cooldownMs)
      channel.cooldownMs = cdMs
  }).catch((error) => {
    debug(`[pocket-room-qchat] 拉取发言冷却失败，按本地下限处理：${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * 进入房间频道：确保当前账号的 QChat 会话存在、连接就绪、频道已订阅。
 * 连接过程的状态（connecting / connected / reconnecting）经 pocketRoomBatch 送达；
 * 失败返回 !ok 与原因，由调用方决定提示（不抛到渲染层栈外）。
 */
export async function handleRoomQChatEnter(
  serverId: string,
  channelId: string,
  sender: WebContents,
): Promise<PocketRoomQChatEnterResult> {
  // 本次登记（新建的频道条目 / 订阅者）：失败时原样摘除，别把幽灵订阅留在会话表里
  let createdChannel: ChannelState | null = null
  let enteredChannel: ChannelState | null = null
  let addedSubscriber = false
  let connectAuthExpired = false
  let session: RoomSession | null = null
  try {
    const credentials = await getImCredentials()
    // 等凭据期间窗口可能已关闭
    if (sender.isDestroyed())
      return { ok: false, message: '窗口已关闭' }
    // appKey 是常量（两个 APK 硬编码同值，后端不下发），不参与会话复用判定
    const appKey = IM_APP_KEY
    let activeSession = sessions.get(credentials.accid)
    if (!activeSession) {
      const client = new NimQChatClient({
        appKey,
        account: credentials.accid,
        token: credentials.token,
        // 会话建立时定档：与本次凭据、HTTP 请求同源（云信登录身份恒为 AOS，同官方 App）
        nim: nimIdentityFor(currentClientProfile()),
        onConnected: () => pushBatch(session!, { kind: 'status', status: 'connected' }),
        onReconnecting: attempt => pushBatch(session!, { kind: 'status', status: 'reconnecting', message: `第 ${attempt} 次重连` }),
        onDisconnected: () => pushBatch(session!, { kind: 'status', status: 'disconnected' }),
        onFatalAuthError: () => {
          pushBatch(session!, {
            kind: 'status',
            status: 'disconnected',
            message: '登录已过期，请重新登录口袋48账号',
          })
          if (sessions.get(session!.accid) === session)
            sessions.delete(session!.accid)
          expireStoredAuth()
        },
        // 建连途中的错误不是「已断开」：状态该留在 connecting，失败由 enter 的返回值表达。
        // 此时推 disconnected 会让指示先闪一下再跳回，且与随后 ok=false 的提示自相矛盾
        onError: (err) => {
          if (session!.establishing)
            return
          pushBatch(session!, {
            kind: 'status',
            status: client.connected ? 'connected' : 'disconnected',
            message: err.message,
          })
        },
        onMessage: (message: PocketRoomQChatMessage) => pushBatch(session!, { kind: 'message', message }),
      })
      activeSession = { client, accid: credentials.accid, channels: new Map(), establishing: false }
      sessions.set(credentials.accid, activeSession)
    }
    session = activeSession
    const key = channelKey(serverId, channelId)
    const client = session.client
    let channel = session.channels.get(key)
    if (!channel) {
      channel = { serverId, channelId, subscribers: new Map(), lastSentAt: 0, cooldownMs: 0 }
      session.channels.set(key, channel)
      createdChannel = channel
    }
    enteredChannel = channel
    // 先登记订阅者再连接：连接过程的状态事件才能送到这个窗口。
    // 钩子随订阅一起存：切房 A→B→A 会重新登记，不存就无处摘除（逐次累积到监听上限）
    if (!channel.subscribers.has(sender)) {
      const hook = () => {
        void leaveChannel(session!, key, sender)
      }
      channel.subscribers.set(sender, hook)
      addedSubscriber = true
      sender.once('destroyed', hook)
    }

    if (!client.connected) {
      pushBatch(session, { kind: 'status', status: 'connecting' })
      session.establishing = true
      try {
        await client.connect()
      }
      catch (error) {
        connectAuthExpired = isFatalAuthError(error)
        throw error
      }
      finally {
        session.establishing = false
      }
    }
    // 新房频道才需要显式订阅；重连后的订阅恢复由客户端内部订阅表完成
    if (createdChannel)
      await client.subscribeChannel(serverId, channelId)
    primeChannelCooldown(channel)
    return { ok: true }
  }
  catch (error) {
    // 摘除本次登记：订阅者撤掉（连同 destroyed 钩子）、空频道条目删掉、
    // 刚建且已无频道的会话连同连接一并销毁
    if (session && addedSubscriber && enteredChannel) {
      detachSubscriber(enteredChannel, sender)
      const key = channelKey(serverId, channelId)
      if (enteredChannel.subscribers.size === 0 && session.channels.get(key) === enteredChannel)
        session.channels.delete(key)
    }
    // 空频道会话一律销毁，不看 client.connected：连接成功但订阅失败时登录态已建立，
    // 留着就是一条占着账号在线态、把手机端顶下线的空转连接（用户看到的是「进入失败」）
    if (session && session.channels.size === 0) {
      session.client.destroy()
      if (sessions.get(session.accid) === session)
        sessions.delete(session.accid)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (connectAuthExpired) {
      expireStoredAuth()
      return { ok: false, message: '登录已过期，请重新登录口袋48账号' }
    }
    debug(`[pocket-room-qchat] 进入房间连接失败：${message}`)
    return { ok: false, message }
  }
}

/** 离开房间频道：退订；无剩余订阅者时断开连接（切房先订新房再退旧房，见文件头） */
export async function handleRoomQChatLeave(serverId: string, channelId: string, sender: WebContents): Promise<void> {
  const key = channelKey(serverId, channelId)
  for (const session of sessions.values()) {
    const channel = session.channels.get(key)
    if (!channel || !channel.subscribers.has(sender))
      continue
    await leaveChannel(session, key, sender)
    return
  }
}

/** 按频道找会话：发送 / 删除都要求目标频道在当前订阅表内（防切房后发到旧频道） */
function findSessionByChannel(serverId: string, channelId: string): RoomSession | null {
  const key = channelKey(serverId, channelId)
  for (const session of sessions.values()) {
    if (session.channels.has(key))
      return session
  }
  return null
}

/**
 * 在房间频道发言。冷却 = max(1.5s, 服务端房间级 cdTime)；目标频道必须是当前订阅表内的频道；
 * 发言资料（ext.user）首次发送时拉取并缓存（level / roleId 等字段 reload 才给）。
 * 返回值带一条**发送回显**（ACK 只回 ID 与时刻，正文与资料由发送入参补全，
 * 思路同参考实现）：渲染层按 24/11 同一形状归一插入，与推送回显、HTTP 回包
 * 按 msgIdClient 三源去重——不管哪条先到都只显示一次。
 */
export async function sendRoomMessage(
  serverId: string,
  channelId: string,
  text: string,
  reply?: PocketRoomReplyTarget,
): Promise<PocketRoomSendResult> {
  const session = findSessionByChannel(serverId, channelId)
  const channel = session?.channels.get(channelKey(serverId, channelId))
  if (!session || !channel)
    throw new Error('房间连接已失效，请重新进入房间')
  const now = Date.now()
  // cdTime 是服务端真正的限流窗口（常规房间 10s），只按本地下限放行等于把拒绝留给服务端
  const cooldownMs = Math.max(SEND_INTERVAL_MS, channel.cooldownMs)
  const waitMs = channel.lastSentAt + cooldownMs - now
  if (channel.lastSentAt > 0 && waitMs > 0)
    throw new Error(`发送太快，请 ${Math.ceil(waitMs / 1000)} 秒后再试`)
  const profile = await getRoomSenderProfile()
  const input = buildRoomSendInput({ serverId, channelId, text, reply, profile })
  channel.lastSentAt = now
  try {
    const result = await session.client.sendMessage(input)
    debug(`[pocket-room-qchat] 已发送：${channelKey(serverId, channelId)} msgIdClient=${result.msgIdClient}`)
    return {
      msgIdClient: result.msgIdClient,
      msgIdServer: result.msgIdServer,
      time: result.time,
      message: {
        serverId,
        channelId,
        fromAccount: session.accid,
        fromClientType: 0,
        fromNick: profile.nickname,
        type: input.type === 'custom' ? 100 : 0,
        body: input.body || '',
        attachment: input.attachment || '',
        ext: input.ext,
        msgIdClient: result.msgIdClient,
        msgIdServer: result.msgIdServer,
        time: result.time,
      },
    }
  }
  catch (error) {
    // 失败清零冷却：网络抖动不该让用户干等一整个 cdTime
    channel.lastSentAt = 0
    throw error
  }
}

/**
 * 登录态变更（登出 / token 失效）时断开全部会话并告知订阅者。
 * 与 cleanupRoomQChatSessions 的分工：那个用于应用退出——窗口即将销毁，
 * 既不该也没必要再发 IPC。
 */
export function resetRoomQChatSessions(): void {
  for (const session of sessions.values()) {
    pushBatch(session, { kind: 'status', status: 'disconnected', message: '登录状态已变更，请重新进入房间' })
    session.client.destroy()
  }
  sessions.clear()
}

/** 应用退出前清理全部会话；由 app.ts 的 before-quit 显式调用 */
export function cleanupRoomQChatSessions(): void {
  for (const session of sessions.values())
    session.client.destroy()
  sessions.clear()
}
