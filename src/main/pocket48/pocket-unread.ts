import type { PocketUnreadBatch } from '../../preload/ipc-contract'
/**
 * 房间未读检测服务（主进程唯一真相）。
 *
 * 设计原则：检测与未读状态都归主进程 —— 页面没开、窗口最小化时未读照样积累
 * （定时器在主进程，不受 Chromium 对失焦窗口的节流影响）；
 * 渲染层（stores/pocket-unread.ts）只做镜像与展示，经 pocketUnreadBatch 全量广播保持一致，
 * 与任务列表（task-registry → stores/tasks）是同一套「主进程真相 + 各窗镜像」的模式。
 *
 * 检测链路：60s 低频轮询 im/team/classic/last/message/get 批量预览接口
 * （一次请求覆盖全部关注的房间，登录态复用 pocket-auth），与每个房间的「已读水位」比对：
 * - 首次见到某频道：水位直接锚定当前最新消息，历史不算未读；
 * - 最新消息时刻超过水位且未被计入过：未读 +1（该接口每频道只回最新一条，
 *   一轮只按「有新消息」粗算 +1，进入房间后 markRead 整体清零）；
 * - counted 记录已计入未读的消息时刻：水位不动（用户没读）时防止每轮重复累加。
 * 水位只由 markRead（用户真的读到）推进，轮询检测不推进。
 *
 * 持久化（userData/pocket48-unread.json，原子写 + 坏档回退复用 SafeJSONFileSync）：
 * 频道解析结果（server/jump，开销最大的一段）随水位/未读快照一并落盘，重启不重解析、不丢未读。
 * token 失效 / 网络异常：本轮静默跳过、registry 冻结（未读不丢），恢复后下一轮续跑；
 * 未登录（凭证文件不存在）：清空未读与账号相关水位/计数并广播，重登按首见重新锚定。
 */
import path from 'node:path'
import { app } from 'electron'
import { broadcastIpc } from '../ipc/send'
import { log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import { getFollowedIds, getRoomChannel, getRoomLastMessages, getToken } from './pocket-auth'

/** 轮询间隔：低频检测（每轮一次批量请求），又不至于让角标迟滞超过一分钟 */
const POLL_MS = 60_000
/** 频道解析并发上限：关注几十人时首轮不打爆 server/jump */
const RESOLVE_CONCURRENCY = 4
/** 无房间占位的重解析间隔：占位成员日后可能开通房间，过期后重试一次 */
const EMPTY_CHANNEL_TTL = 30 * 60 * 1000

/** 单个房间的未读快照 */
interface UnreadRoomState {
  /** 未读条数（粗算，见文件头） */
  count: number
  /** 最新一条未读消息时刻（ms） */
  latestTime: number
}

/** 房间频道缓存条目：server/jump 解析结果 + 解析时刻（空频道占位按 TTL 重试） */
interface StoredChannel {
  serverId: string
  channelId: string
  resolvedAt: number
}

/** pocket48-unread.json 持久化结构（userId 十进制字符串键，与接口返回一致） */
interface StoredUnread {
  /** 已读水位：该房间最后一次被读到的消息 msgTime；只由 markRead 推进 */
  watermarks: Record<string, number>
  /** 已计入未读的消息 msgTime：水位不动时防止每轮重复累加 */
  counted: Record<string, number>
  /** 房间频道缓存；channelId 为空串 = 解析过但无房间（或解析失败）的占位 */
  channels: Record<string, StoredChannel>
  /** 未读快照（只有 count>0 的条目），重启不丢 */
  unread: Record<string, UnreadRoomState>
}

let storeFile: SafeJSONFileSync<StoredUnread> | null = null
let stored: StoredUnread | null = null
let timer: NodeJS.Timeout | null = null
/** 轮询重入护栏：上一轮请求还没回来时直接跳过本轮 */
let ticking = false

/** 惰性加载持久化状态（app.getPath 在应用 ready 前不可用，与 pocket-auth 同款时机） */
function store(): StoredUnread {
  if (!stored) {
    if (!storeFile)
      storeFile = new SafeJSONFileSync<StoredUnread>(path.join(app.getPath('userData'), 'pocket48-unread.json'))
    const loaded = storeFile.read()
    stored = {
      watermarks: loaded?.watermarks ?? {},
      counted: loaded?.counted ?? {},
      channels: loaded?.channels ?? {},
      unread: loaded?.unread ?? {},
    }
  }
  return stored
}

function persist(): void {
  try {
    storeFile?.write(store())
  }
  catch (error) {
    log('[pocket-unread] 未读状态落盘失败（内存中不受影响）', error)
  }
}

/** 对外暴露的全量快照：只有 count>0 的房间会出现（userId 字符串键） */
function snapshot(): PocketUnreadBatch {
  const rooms: PocketUnreadBatch['rooms'] = {}
  let total = 0
  for (const [userId, entry] of Object.entries(store().unread)) {
    if (entry.count > 0) {
      rooms[userId] = entry
      total += entry.count
    }
  }
  return { rooms, total }
}

/** 未读变化统一出口：全量广播（多窗镜像）+ 任务栏/Dock 角标（Windows overlay 图标留给 M2） */
function publish(): void {
  const state = snapshot()
  broadcastIpc('pocketUnreadBatch', state)
  try {
    app.setBadgeCount(state.total)
  }
  catch (error) {
    log('[pocket-unread] 应用角标设置失败', error)
  }
}

/**
 * 确保关注成员的房间频道都已解析（server/jump，需登录）。
 * 只解析缺失 / 无房间占位过期的条目，正常频道一次解析终身复用；
 * 返回是否有结构变化（调用方据此决定是否落盘）。
 */

async function ensureChannels(followedIds: number[]): Promise<{ dirty: boolean, unreadChanged: boolean }> {
  const data = store()
  const known = new Set(Object.keys(data.channels))
  let dirty = false
  let unreadChanged = false

  // 已取关的成员：频道缓存与未读/水位一并清掉——房间已不在列表，markRead 无从触发，
  // 残留的未读会永远计入 Dock 总数（广播后左列与角标同步消失）
  for (const key of known) {
    if (!followedIds.includes(Number(key))) {
      const hadUnread = !!data.unread[key]
      delete data.channels[key]
      delete data.unread[key]
      delete data.watermarks[key]
      delete data.counted[key]
      dirty = true
      if (hadUnread)
        unreadChanged = true
    }
  }

  const now = Date.now()
  const missing = followedIds.filter((id) => {
    const entry = data.channels[String(id)]
    if (!entry)
      return true
    // 空占位（无房间 / 上次解析失败）按 TTL 重试，正常频道不重解析
    return !entry.channelId && now - entry.resolvedAt > EMPTY_CHANNEL_TTL
  })

  if (!missing.length)
    return { dirty, unreadChanged }

  let cursor = 0
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, missing.length) }, async () => {
    while (cursor < missing.length) {
      const userId = missing[cursor++]
      const key = String(userId)
      // 并发窗口内可能已被同批解析填上，回包后按 key 复核，不覆盖新结果
      if (data.channels[key] && data.channels[key].channelId)
        continue
      try {
        const channel = await getRoomChannel(userId)
        data.channels[key] = { ...channel, resolvedAt: Date.now() }
        dirty = true
      }
      catch (error) {
        // token 失效上抛：整轮放弃、registry 冻结；其余失败记空占位，按 TTL 下轮再试
        if (error instanceof Error && error.message.includes('登录已过期'))
          throw error
        log('[pocket-unread] 房间频道解析失败，按无房间占位', userId, error)
        data.channels[key] = { serverId: '', channelId: '', resolvedAt: Date.now() }
        dirty = true
      }
    }
  })

  await Promise.all(workers)
  return { dirty, unreadChanged }
}

/** 单轮检测：登录态 → 关注名单 → 频道补齐 → 批量最新消息 → 水位比对计数 */
async function tick(): Promise<void> {
  if (ticking)
    return
  ticking = true
  try {
    const data = store()

    // 未登录：未读与水位/计数都是账号相关状态，一并清空；频道缓存与账号无关可保留。
    // 重登后没有旧水位，最新消息会走「首见锚定」，不会把登出前的消息补成未读
    if (!getToken()) {
      const hadUnread = Object.keys(data.unread).length > 0
      const hadAccountState = hadUnread
        || Object.keys(data.watermarks).length > 0
        || Object.keys(data.counted).length > 0
      data.unread = {}
      data.watermarks = {}
      data.counted = {}
      if (hadAccountState) {
        persist()
        if (hadUnread)
          publish()
      }
      return
    }
    const followedIds = await getFollowedIds()
    const { dirty: channelDirty, unreadChanged: unfollowChanged } = await ensureChannels(followedIds)
    let dirty = channelDirty

    // serverId 去重（同一 team server 下多个成员频道）；channelId → userId 反查
    const serverIds = new Set<string>()
    const channelOwner = new Map<string, string>()
    for (const [userId, channel] of Object.entries(data.channels)) {
      if (!channel.channelId)
        continue
      serverIds.add(channel.serverId)
      channelOwner.set(channel.channelId, userId)
    }

    if (!serverIds.size) {
      if (dirty || unfollowChanged)
        persist()
      if (unfollowChanged)
        publish()
      return
    }

    let unreadChanged = false
    for (const item of await getRoomLastMessages([...serverIds])) {
      const userId = channelOwner.get(item.channelId)
      if (!userId || !item.msgTime)
        continue
      const watermark = data.watermarks[userId]
      if (watermark === undefined) {
        // 首次见到该频道：水位锚定当前最新消息，历史不算未读
        data.watermarks[userId] = item.msgTime
        data.counted[userId] = item.msgTime
        dirty = true
        continue
      }
      // 超过水位且还没计入过：+1（接口每频道只回最新一条，无法数出真实增量）
      if (item.msgTime > watermark && item.msgTime > (data.counted[userId] ?? 0)) {
        const entry = data.unread[userId] ?? { count: 0, latestTime: 0 }
        entry.count += 1
        entry.latestTime = item.msgTime
        data.unread[userId] = entry
        data.counted[userId] = item.msgTime
        unreadChanged = true
      }
    }

    // 未读累加也必须落盘：dirty 只覆盖频道解析/首见锚定，不含计数路径，漏了会「重启丢未读」；
    // 取关清理（unfollowChanged）同属「registry 结构变化」，一并落盘并广播
    if (dirty || unreadChanged || unfollowChanged)
      persist()
    if (unreadChanged || unfollowChanged)
      publish()
  }
  catch (error) {
    // token 失效 / 网络异常：registry 冻结等下一轮，未读不丢
    log('[pocket-unread] 未读检测本轮跳过', error)
  }
  finally {
    ticking = false
  }
}

// ===== 对渲染层暴露（对端：register-pocket-ipc.ts） =====

/** 全量未读快照（启动时回取一次；后续变化走 pocketUnreadBatch 事件） */
export function getState(): PocketUnreadBatch {
  return snapshot()
}

/**
 * 标记房间已读：水位上移、未读清零并广播。
 * msgTime 传该房间最新已见消息时刻（渲染层消息流末条）；缺省按 registry 内最新一条未读计。
 */
export function markRead(userId: number, msgTime?: number): void {
  const data = store()
  const key = String(userId)
  const entry = data.unread[key]
  const watermark = data.watermarks[key] ?? 0
  const target = Math.max(msgTime ?? 0, entry?.latestTime ?? 0)
  // 没有未读、时刻也不比水位新：无事可做，不产生落盘与广播
  if (!entry && target <= watermark)
    return
  delete data.unread[key]
  if (target > watermark) {
    data.watermarks[key] = target
    // counted 随水位一并消化：防止刚清零的房间被旧的 counted 顶住、后续新消息计不进来
    data.counted[key] = Math.max(data.counted[key] ?? 0, target)
  }
  persist()
  publish()
}

// ===== 生命周期（对端：app.ts） =====

/** 启动未读检测：立即跑一轮，之后按 POLL_MS 低频轮询；幂等 */
export function startPocketUnread(): void {
  if (timer)
    return
  timer = setInterval(() => void tick(), POLL_MS)
  // 启动先发布一次持久化快照，重启后角标不用等第一轮网络轮询才恢复
  publish()
  void tick()
  log('[pocket-unread] 未读检测已启动')
}

export function stopPocketUnread(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
