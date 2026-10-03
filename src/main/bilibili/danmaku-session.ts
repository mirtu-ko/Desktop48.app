/**
 * B 站直播弹幕会话：一个房间一条长连接，按订阅者（播放窗）批量下发。
 * 协议解析在 danmaku-protocol.ts、签名在 wbi.ts，这里只管连接生命周期。
 *
 * 必须放主进程：渲染层建 WS 会绕过 allowed-hosts 白名单，且没有 brotli 解不了 protover 3。
 * 失败一律静默降级 —— 弹幕拿不到不能影响播放，除首次握手外不向渲染层抛错。
 */
import type { WebContents } from 'electron'
import type { Buffer } from 'node:buffer'
import type { LiveDanmaku } from '../../common/live-danmaku'
import WebSocket from 'ws'
import { isAllowedBilibiliApiUrl, isAllowedBilibiliSocketUrl } from '../allowed-hosts'
import { sendIpc } from '../ipc/send'
import { debug, error } from '../logger'
import { BUVID_SPI_URL, createFallbackBuvid, pickBuvid } from './buvid'
import {
  buildDanmakuAuthBody,
  DANMAKU_HEARTBEAT_BODY,
  DANMAKU_OP_AUTH,
  DANMAKU_OP_HEARTBEAT,
  extractDanmakuList,
  listMessageCommands,
  packDanmakuPacket,
  unpackDanmakuPackets,
} from './danmaku-protocol'
import { buildWbiKey, buildWbiQuery } from './wbi'

/** B 站对非浏览器 UA 有风控，握手与长连接都用桌面浏览器标识 */
const BILIBILI_USER_AGENT
  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BILIBILI_REFERER = 'https://live.bilibili.com/'

/** 鉴权包里的设备标识，握手时填好（见 resolveBuvid） */
let cachedBuvid = ''

const ROOM_INFO_URL = 'https://api.live.bilibili.com/room/v1/Room/get_info'
const WBI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const DANMU_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'

/** 单次接口请求超时：握手失败要尽快回给渲染层，不能让弹幕开关长时间悬着 */
const API_TIMEOUT_MS = 10_000
/** 心跳间隔：服务端要求 30 秒内至少一次，否则主动断开 */
const HEARTBEAT_INTERVAL_MS = 30_000
/** 攒批下发间隔：逐条 IPC 在热门房间会打爆渲染层 */
const BATCH_INTERVAL_MS = 150
/** 待发队列上限：渲染层异常慢时丢最旧的，弹幕过期即无意义 */
const MAX_PENDING_DANMAKU = 200
/** 重连退避 1s → 2s → 4s … 上限 30s */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 连续失败到这个次数就重新握手一次（token 与服务器列表可能已失效） */
const REINIT_AFTER_ATTEMPTS = 5

interface DanmakuHost {
  host: string
  wss_port: number
}

interface DanmakuSession {
  /** 渲染层传入的房间号（可以是短号），同时作为会话键 */
  roomId: number
  /** get_info 解析出的真实房间号，鉴权包用这个 */
  realRoomId: number
  token: string
  hosts: DanmakuHost[]
  subscribers: Set<WebContents>
  socket: WebSocket | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  flushTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pending: LiveDanmaku[]
  /** 累计收到的弹幕条数：与渲染层的计数对照，能定位「少了」发生在哪一段链路 */
  receivedDanmaku: number
  /** 置位后一切在途回包与定时器都不再生效 */
  closed: boolean
}

const sessions = new Map<number, DanmakuSession>()

async function fetchBilibiliJson(url: string): Promise<any> {
  if (!isAllowedBilibiliApiUrl(url))
    throw new Error(`B 站接口不在允许范围内: ${url}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': BILIBILI_USER_AGENT, 'Referer': BILIBILI_REFERER },
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(`B 站接口 HTTP ${response.status}: ${url}`)
    return await response.json()
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * 取设备标识，取一次就够（接口每次返回值都不同）。失败回落本地随机值 ——
 * 留空会被降级到稀疏通道，宁可用假值也不能空着。
 */
async function resolveBuvid(): Promise<string> {
  if (cachedBuvid)
    return cachedBuvid

  let source = '指纹接口'
  try {
    cachedBuvid = pickBuvid(await fetchBilibiliJson(BUVID_SPI_URL)) ?? ''
  }
  catch (err) {
    debug('[danmaku-session] 取 buvid 失败:', err)
  }

  if (!cachedBuvid) {
    cachedBuvid = createFallbackBuvid()
    source = '本地随机值'
  }
  debug(`[danmaku-session] buvid 取自${source}: ${cachedBuvid}`)
  return cachedBuvid
}

/**
 * 握手：房间号 → 真实房间号 → WBI 口令 → 弹幕服务器列表与 token。
 * 短号（如 48）在这一步被换成真实房间号，后续鉴权与 getDanmuInfo 都用真实号。
 */
async function initSession(session: DanmakuSession): Promise<void> {
  // 设备标识与其余握手无依赖，并起来省一次往返；它自身不抛（失败已在内部回落）
  const [roomInfo] = await Promise.all([
    fetchBilibiliJson(`${ROOM_INFO_URL}?room_id=${session.roomId}`),
    resolveBuvid(),
  ])
  const realRoomId = roomInfo?.data?.room_id
  if (typeof realRoomId !== 'number' || !Number.isFinite(realRoomId))
    throw new Error(`未取到 B 站房间号（room_id=${session.roomId}, code=${roomInfo?.code}）`)

  const nav = await fetchBilibiliJson(WBI_NAV_URL)
  const imgUrl = nav?.data?.wbi_img?.img_url
  const subUrl = nav?.data?.wbi_img?.sub_url
  if (typeof imgUrl !== 'string' || typeof subUrl !== 'string')
    throw new Error('未取到 WBI 签名口令')

  const query = buildWbiQuery(
    { id: realRoomId, type: 0 },
    buildWbiKey(imgUrl, subUrl),
    Math.floor(Date.now() / 1000),
  )
  const danmuInfo = await fetchBilibiliJson(`${DANMU_INFO_URL}?${query}`)
  if (danmuInfo?.code !== 0)
    throw new Error(`getDanmuInfo 失败：code=${danmuInfo?.code} ${danmuInfo?.message ?? ''}`)

  const hosts = danmuInfo?.data?.host_list
  const token = danmuInfo?.data?.token
  if (!Array.isArray(hosts) || hosts.length === 0 || typeof token !== 'string')
    throw new Error('弹幕服务器列表为空')

  session.realRoomId = realRoomId
  session.token = token
  session.hosts = hosts.filter(
    (item: any) => typeof item?.host === 'string' && Number.isFinite(item?.wss_port),
  )
}

function connectSocket(session: DanmakuSession): void {
  if (session.closed || session.hosts.length === 0)
    return

  // 服务器列表按序轮换，重连一次换一台，避免持续撞同一台故障机
  const host = session.hosts[session.reconnectAttempt % session.hosts.length]
  const url = `wss://${host.host}:${host.wss_port}/sub`
  if (!isAllowedBilibiliSocketUrl(url)) {
    error(`[danmaku-session] 弹幕服务器地址不在允许范围内: ${url}`)
    return
  }

  const socket = new WebSocket(url, { headers: { 'User-Agent': BILIBILI_USER_AGENT } })
  session.socket = socket

  socket.on('open', () => {
    if (session.closed)
      return
    debug(`[danmaku-session] 房间 ${session.roomId} 已连接 ${url}`)
    // 连上即清零：退避计数语义是「连续失败次数」，否则跨天累积会误触发重新握手
    session.reconnectAttempt = 0
    socket.send(
      packDanmakuPacket(
        buildDanmakuAuthBody(session.realRoomId, session.token, cachedBuvid),
        DANMAKU_OP_AUTH,
      ),
    )
    startHeartbeat(session, socket)
  })

  socket.on('message', (data) => {
    if (!session.closed)
      handleSocketMessage(session, data as Buffer)
  })

  // 重连只挂在 close 上：error 之后必然跟一次 close，两处都排会排两次
  socket.on('close', (code) => {
    stopHeartbeat(session)
    session.socket = null
    if (session.closed)
      return
    scheduleReconnect(session)
    debug(`[danmaku-session] 房间 ${session.roomId} 连接关闭 code=${code}，已排入重连`)
  })

  socket.on('error', (err) => {
    error(`[danmaku-session] 房间 ${session.roomId} 连接错误:`, err)
  })
}

function startHeartbeat(session: DanmakuSession, socket: WebSocket): void {
  stopHeartbeat(session)
  session.heartbeatTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(packDanmakuPacket(DANMAKU_HEARTBEAT_BODY, DANMAKU_OP_HEARTBEAT))
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(session: DanmakuSession): void {
  if (!session.heartbeatTimer)
    return
  clearInterval(session.heartbeatTimer)
  session.heartbeatTimer = null
}

function handleSocketMessage(session: DanmakuSession, data: Buffer): void {
  const items: LiveDanmaku[] = []
  const ignored = new Map<string, number>()

  for (const packet of unpackDanmakuPackets(data)) {
    // 只有 op=Message 的正文会被解析成 JSON，其余（心跳应答 / 进房应答）恒为 null
    if (packet.body === null)
      continue
    const extracted = extractDanmakuList(packet.body)
    if (extracted.length > 0) {
      items.push(...extracted)
      continue
    }
    for (const cmd of listMessageCommands(packet.body))
      ignored.set(cmd, (ignored.get(cmd) ?? 0) + 1)
  }

  if (items.length > 0) {
    session.receivedDanmaku += items.length
    queueDanmaku(session, items)
    // 逐条打印内容：弹幕密度对不上网页时，靠这行判断服务端到底发了多少
    debug(
      `[danmaku-session] 房间 ${session.roomId} 收到 ${items.length} 条弹幕（累计 ${session.receivedDanmaku}）:`,
      items.map(item => `${item.username}: ${item.text}`).join(' | '),
    )
  }

  if (ignored.size > 0) {
    const summary = [...ignored].map(([cmd, count]) => `${cmd}×${count}`).join(', ')
    debug(`[danmaku-session] 房间 ${session.roomId} 丢弃非弹幕指令: ${summary}`)
  }
}

function queueDanmaku(session: DanmakuSession, items: LiveDanmaku[]): void {
  session.pending.push(...items)
  if (session.pending.length > MAX_PENDING_DANMAKU) {
    const dropped = session.pending.length - MAX_PENDING_DANMAKU
    session.pending.splice(0, dropped)
    // 溢出即说明渲染层收得比服务端慢，弹幕数会被这个上限削平
    debug(`[danmaku-session] 房间 ${session.roomId} 待发队列溢出，丢弃最旧 ${dropped} 条`)
  }
  if (!session.flushTimer)
    session.flushTimer = setTimeout(flushDanmaku, BATCH_INTERVAL_MS, session)
}

function flushDanmaku(session: DanmakuSession): void {
  session.flushTimer = null
  if (session.closed || session.pending.length === 0)
    return

  const items = session.pending.splice(0, session.pending.length)
  for (const subscriber of session.subscribers)
    sendIpc(subscriber, 'danmakuBatch', { roomId: session.roomId, items })
}

function scheduleReconnect(session: DanmakuSession): void {
  if (session.closed || session.reconnectTimer)
    return

  session.reconnectAttempt += 1
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (session.reconnectAttempt - 1), RECONNECT_MAX_MS)
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null
    void reconnect(session)
  }, delay)
}

async function reconnect(session: DanmakuSession): Promise<void> {
  if (session.closed)
    return

  // 连续失败多次说明 token / 服务器列表可能已失效，重新握手后再连
  if (session.reconnectAttempt % REINIT_AFTER_ATTEMPTS === 0) {
    try {
      await initSession(session)
    }
    catch (err) {
      error(`[danmaku-session] 房间 ${session.roomId} 重新握手失败:`, err)
    }
  }

  if (!session.closed)
    connectSocket(session)
}

function disposeSession(session: DanmakuSession): void {
  session.closed = true
  stopHeartbeat(session)

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = null
  }
  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }
  session.pending = []

  const socket = session.socket
  session.socket = null
  // 主动 close 也会走 close 回调，靠 closed 标记让重连分支提前返回
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
    socket.close()

  session.subscribers.clear()
}

function subscribe(session: DanmakuSession, sender: WebContents): void {
  if (session.subscribers.has(sender))
    return

  session.subscribers.add(sender)
  // 播放窗关闭走的是 destroy()，不触发渲染层 unload：退订必须在主进程随 webContents 兜底
  sender.once('destroyed', () => handleDanmakuStop(session.roomId, sender))
}

/**
 * 开启（或复用）某房间的弹幕会话。只等握手不等建连 —— 建连与重连都在后台静默进行，
 * 避免网络抖动拖住播放器 UI；握手失败返回 false 让渲染层提示一次。
 */
export async function handleDanmakuStart(roomId: number, sender: WebContents): Promise<boolean> {
  const existing = sessions.get(roomId)
  // 已登记的会话可能正被销毁（最后一个订阅者退出 → disposeSession 置 closed，但条目还在表里）。
  // 复用这种会话会让新窗口拿到一个再也不会推送弹幕的死会话，且本函数还返回 true 报成功。
  if (existing && !existing.closed) {
    subscribe(existing, sender)
    return true
  }
  if (existing) {
    debug('[danmaku-session] 复用到已关闭的会话，重建:', roomId)
    sessions.delete(roomId)
  }

  const session: DanmakuSession = {
    roomId,
    realRoomId: roomId,
    token: '',
    hosts: [],
    subscribers: new Set(),
    socket: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    flushTimer: null,
    reconnectAttempt: 0,
    pending: [],
    receivedDanmaku: 0,
    closed: false,
  }

  try {
    await initSession(session)
  }
  catch (err) {
    error(`[danmaku-session] 房间 ${roomId} 握手失败:`, err)
    return false
  }

  // 握手期间窗口可能已被关闭，此时不再登记会话
  if (sender.isDestroyed())
    return false

  sessions.set(roomId, session)
  subscribe(session, sender)
  connectSocket(session)
  debug(
    `[danmaku-session] 房间 ${roomId} → ${session.realRoomId} 会话已启动（${session.hosts.length} 台服务器可选）`,
  )
  return true
}

/** 退订某房间的弹幕；最后一个订阅者离开时断开连接 */
export function handleDanmakuStop(roomId: number, sender: WebContents): void {
  const session = sessions.get(roomId)
  if (!session)
    return

  session.subscribers.delete(sender)
  if (session.subscribers.size > 0)
    return

  sessions.delete(roomId)
  disposeSession(session)
  debug(`[danmaku-session] 房间 ${roomId} 会话已停止`)
}

/** 应用退出前清理全部弹幕会话；由 app.ts 的 before-quit 显式调用 */
export function cleanupDanmakuSessions(): void {
  for (const session of sessions.values())
    disposeSession(session)
  sessions.clear()
}
