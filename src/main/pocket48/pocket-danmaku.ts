/**
 * 口袋48直播聊天室弹幕会话（主进程持有 TCP 长连接，协议见 nim-chatroom.ts）。
 *
 * 与 B 站弹幕（bilibili/danmaku-session.ts）同一套「会话 + 订阅者」模式：
 * 同一聊天室多个窗口共用一条连接，渲染层按 chatroomId 过滤事件批次。
 * 凭据（accid + imToken）与常量 appKey 由主进程内部取用，渲染层接触不到。
 *
 * 进房身份恒为塞纳河48 客户端（`nimIdentity()`，与 HTTP 同源）：会话建立时取一次并写入
 * 客户端，此后该连接不再变。登录态变更（登出 / 换号）时由 `resetPocketDanmakuSessions`
 * 断开旧会话，避免已删 token 的连接残留。
 */
import type { PocketDanmakuStatus, PocketRawChatMessage } from '@preload/ipc-contract'
import type { WebContents } from 'electron'
import type { ChatroomSender, ChatroomSendResult } from './nim-chatroom'
import { sendIpc } from '../ipc/send'
import { debug, error } from '../logger'
import { nimIdentity, POCKET_CLIENT, pocketDeviceId } from './client-profile'
import { NimChatroomClient } from './nim-chatroom'
import { getImCredentials, getRoomSenderProfile, IM_APP_KEY } from './pocket-auth'

interface PocketDanmakuSession {
  chatroomId: string
  liveId: string
  client: NimChatroomClient
  /** 订阅窗口 → destroyed 兜底钩子（显式退订时须同步摘除，避免监听累积） */
  subscribers: Map<WebContents, () => void>
}

const sessions = new Map<string, PocketDanmakuSession>()

function pushStatus(session: PocketDanmakuSession, status: PocketDanmakuStatus, message?: string): void {
  for (const subscriber of session.subscribers.keys()) {
    if (!subscriber.isDestroyed())
      sendIpc(subscriber, 'pocketDanmakuBatch', { chatroomId: session.chatroomId, kind: 'status', status, message })
  }
}

function pushMessage(session: PocketDanmakuSession, message: PocketRawChatMessage): void {
  for (const subscriber of session.subscribers.keys()) {
    if (!subscriber.isDestroyed())
      sendIpc(subscriber, 'pocketDanmakuBatch', { chatroomId: session.chatroomId, kind: 'messages', items: [message] })
  }
}

function detachSubscriber(session: PocketDanmakuSession, sender: WebContents): boolean {
  const hook = session.subscribers.get(sender)
  if (!hook)
    return false
  session.subscribers.delete(sender)
  if (!sender.isDestroyed())
    sender.removeListener('destroyed', hook)
  return true
}

function subscribe(session: PocketDanmakuSession, sender: WebContents): void {
  if (session.subscribers.has(sender))
    return
  const hook = () => handlePocketDanmakuStop(session.chatroomId, sender)
  session.subscribers.set(sender, hook)
  // 播放窗关闭走 destroy()，不触发渲染层退订：随 webContents 销毁兜底清理
  sender.once('destroyed', hook)
}

function disposeSession(session: PocketDanmakuSession): void {
  for (const [subscriber, hook] of session.subscribers) {
    if (!subscriber.isDestroyed())
      subscriber.removeListener('destroyed', hook)
  }
  session.subscribers.clear()
  session.client.destroy()
}

/**
 * 起一个聊天室会话并登记订阅者。会话已存在时只追加订阅。
 * 返回 false 表示无法起会话（未登录 / 凭据失效 / 参数无效），渲染层据此报终态。
 */
export async function handlePocketDanmakuStart(chatroomId: string, liveId: string, sender: WebContents): Promise<boolean> {
  const roomKey = String(chatroomId || '').trim()
  if (!/^\d{1,32}$/.test(roomKey)) {
    error(`[pocket-danmaku] 无效的聊天室 ID: ${roomKey}`)
    return false
  }
  const existing = sessions.get(roomKey)
  if (existing) {
    subscribe(existing, sender)
    return true
  }

  let credentials
  try {
    credentials = await getImCredentials()
  }
  catch (err) {
    error('[pocket-danmaku] 获取 IM 凭据失败:', err)
    return false
  }
  // 等待凭据期间窗口可能已被关闭
  if (sender.isDestroyed())
    return false
  // 等待凭据期间同一聊天室可能已被并发 start 建好会话（两个窗口同时打开同一直播）：
  // 直接订阅已有会话。不拦这一下的话两条连接都会建起来，后写的覆盖前一条，
  // 前一条会话永驻泄漏（没人再能引用它来停）
  const racing = sessions.get(roomKey)
  if (racing) {
    subscribe(racing, sender)
    return true
  }

  const session: PocketDanmakuSession = {
    chatroomId: roomKey,
    liveId: String(liveId || ''),
    client: null as unknown as NimChatroomClient,
    subscribers: new Map(),
  }
  sessions.set(roomKey, session)
  subscribe(session, sender)

  const client = new NimChatroomClient({
    appKey: IM_APP_KEY,
    account: credentials.accid,
    token: credentials.token,
    roomId: roomKey,
    // 云信身份与 HTTP 请求同源（塞纳河48 APK），建会话时取一次
    nim: nimIdentity(),
    onConnected: () => {
      debug(`[pocket-danmaku] 聊天室 ${roomKey} 已进入`)
      pushStatus(session, 'connected')
    },
    onReconnecting: attempt => pushStatus(session, 'reconnecting', `第 ${attempt} 次重连`),
    onDisconnected: () => pushStatus(session, 'reconnecting'),
    onMessage: message => pushMessage(session, message),
    onError: err => debug(`[pocket-danmaku] 聊天室 ${roomKey} 异常: ${err.message}`),
  })
  session.client = client
  pushStatus(session, 'connecting')

  // 初连失败不自动重连（断线重连在客户端内部）；渲染层重开浮窗会再起新会话
  void client.connect().catch((err: Error) => {
    error(`[pocket-danmaku] 聊天室 ${roomKey} 连接失败: ${err.message}`)
    pushStatus(session, 'disconnected', err.message)
    if (sessions.get(roomKey) === session)
      sessions.delete(roomKey)
    // 失败会话同样要走完整清理：摘掉订阅者的 destroyed 监听再销毁 client，
    // 否则同窗口重试会重复挂 hook，且旧 hook 在窗口销毁时会按 chatroomId 命中新会话
    disposeSession(session)
  })
  return true
}

/**
 * 拼发送弹幕用的发送者特征：账号资料（user/info/reload 快照，含等级 / 徽章）
 * + 客户端事实（fromApp / 版本 / 机型，与 HTTP 头同源）。
 * 放在发送时取而非建会话时取：资料接口是 HTTP，不能拖慢进房；
 * `getRoomSenderProfile` 自己会缓存，连续发送不会重复请求。
 */
async function buildChatroomSender(): Promise<ChatroomSender> {
  const info = POCKET_CLIENT.appInfo(pocketDeviceId())
  const sender = await getRoomSenderProfile()
  return {
    user: {
      userId: sender.userId,
      nickName: sender.nickname,
      avatar: sender.avatar,
      level: sender.level,
      roleId: sender.roleId,
      vip: sender.vip,
      pfUrl: sender.pfUrl,
      teamLogo: sender.teamLogo,
      badge: sender.badge,
    },
    appName: String(info.appName ?? ''),
    appVersion: String(info.appVersion ?? ''),
    deviceModel: String(info.deviceName ?? ''),
    osVersion: String(info.osVersion ?? ''),
  }
}

/**
 * 在**已存在**的聊天室会话上发送一条弹幕。
 * 找不到会话即拒绝：发送不负责建连（会话由播放器打开时的 pocketDanmakuStart 建立），
 * 否则关闭弹幕 / 未登录时点发送会偷偷拉起一条没人订阅的连接。
 */
export async function handlePocketDanmakuSend(chatroomId: string, liveId: string, content: string): Promise<ChatroomSendResult> {
  const roomKey = String(chatroomId || '').trim()
  if (!/^\d{1,32}$/.test(roomKey))
    throw new Error('聊天室信息无效，无法发送弹幕')
  const session = sessions.get(roomKey)
  if (!session)
    throw new Error('互动消息未连接，请稍后再试')
  const sender = await buildChatroomSender()
  return session.client.sendMessage({ text: content, liveId, sender })
}

/** 退订某聊天室；最后一个订阅者离开时断开连接 */
export function handlePocketDanmakuStop(chatroomId: string, sender: WebContents): void {
  // 键归一与 handlePocketDanmakuStart 一致：不 trim 会键不对称，永远退订不掉
  const roomKey = String(chatroomId || '').trim()
  const session = sessions.get(roomKey)
  if (!session || !detachSubscriber(session, sender))
    return
  if (session.subscribers.size > 0)
    return
  sessions.delete(roomKey)
  disposeSession(session)
  debug(`[pocket-danmaku] 聊天室 ${roomKey} 会话已停止`)
}

/**
 * 登录态变更（登出 / 换号）时断开全部会话并告知订阅者：旧连接用的是已作废的 token，
 * 继续挂着只会收到「已过期」，不该沿用。渲染层收到 disconnected 后重开浮窗即会以新凭证重新参会。
 * 与 `cleanupPocketDanmakuSessions` 的分工：那个用于应用退出——窗口即将销毁，
 * 既不该也没必要再发 IPC。
 */
export function resetPocketDanmakuSessions(): void {
  for (const session of sessions.values()) {
    pushStatus(session, 'disconnected', '登录状态已变更，请重新打开弹幕')
    disposeSession(session)
  }
  sessions.clear()
}

/** 应用退出前清理全部会话；由 app.ts 的 before-quit 显式调用 */
export function cleanupPocketDanmakuSessions(): void {
  for (const session of sessions.values())
    disposeSession(session)
  sessions.clear()
}
