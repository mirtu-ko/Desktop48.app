import type { PocketUnreadBatch } from '@preload/ipc-contract'
import type { PocketRoomLastMessage, PocketRoomMessage } from './pocket-auth'
/**
 * 房间未读检测服务（主进程唯一真相）。
 *
 * 设计原则：检测与未读状态都归主进程 —— 页面没开、窗口最小化时未读照样积累
 * （定时器在主进程，不受 Chromium 对失焦窗口的节流影响）；
 * 渲染层（stores/pocket-unread.ts）只做镜像与展示，经 pocketUnreadBatch 全量广播保持一致，
 * 与任务列表（task-registry → stores/tasks）是同一套「主进程真相 + 各窗镜像」的模式。
 *
 * 成员范围 = 账号关注名单（friends/id）**减去本地屏蔽名单**：屏蔽是本地可见性偏好，
 * 与关注正交（接线见 renderer 的 use-member-actions），被屏蔽的成员既不计未读，
 * 也不占频道解析名额；剔除后其频道缓存与未读按「取关清理」同一条路径一并清掉。
 *
 * 计数链路分两步（60s 一轮）：
 * 1. **触发**：批量预览接口 im/team/classic/last/message/get 一次覆盖全部关注房间，
 *    回包只有「每个频道的最新一条消息」。它的身份键（msgKey）与上一轮不同即视为
 *    「该频道有新消息」——注意它只作触发判据，不参与计数；
 * 2. **计数**：对触发的频道拉一页消息列表（im/team/message/list/homeowner，取
 *    ROOM_MESSAGE_LIMIT 条），数出「比已读水位更新」的条数。口径与渲染层成员视图一致
 *    （只看房主/成员发言 + 剔除官方系统账号），与服务端角标同源。
 *
 * 为什么不用预览接口的 unreadCount 字段：实测拿不到。该字段要求服务端回完整档，
 * 而 15 组 A/B 探测（pa 三态 × 平台特征头 × 参考实现的真实客户端 profile）全部只回
 * 4 个字段，`unreadCount` 恒为 null；预览接口也没有 msgTime。详见 pocket-auth 的注解。
 *
 * 上限与代价：每轮最多探测 MAX_MESSAGE_PROBES 个房间（一轮页几十 KB），超出的留到
 * 下一轮（按上次探测时刻轮转，不会饿死）；单频道最多数到 ROOM_MESSAGE_LIMIT 条，
 * 触顶即「至少这么多」，渲染层的角标按同一条数收敛为 50+。
 *
 * 水位（readMarks）只在两处推进：**首见锚定**（历史不算未读）与 **markRead**（读到此刻）；
 * 检测轮里绝不推进——否则未读会退化成「本轮增量」，无人阅读时角标自己消失（踩过）。
 *
 * 持久化（userData/pocket48-unread.json，原子写 + 坏档回退复用 SafeJSONFileSync）：
 * 频道解析结果（server/jump，开销最大的一段）随水位/未读快照一并落盘，重启不重解析、不丢未读。
 * token 失效 / 网络异常：本轮静默跳过、registry 冻结（未读不丢），恢复后下一轮续跑；
 * 未登录（凭证文件不存在）：清空未读与账号相关水位/计数并广播，重登按首见重新锚定。
 */
import path from 'node:path'
import { OFFICIAL_POCKET_USER_ID, ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'
import { app } from 'electron'
import { Database } from '../database'
import { broadcastIpc } from '../ipc/send'
import { debug, log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import {
  getFollowedIds,
  getRoomChannel,
  getRoomChannelOwner,
  getRoomLastMessages,
  getRoomMessages,
  getToken,
} from './pocket-auth'

/** 轮询间隔：低频检测（每轮一次批量预览），又不至于让角标迟滞超过一分钟 */
const POLL_MS = 60_000
/** 频道解析并发上限：关注几十人时首轮不打爆 server/jump */
const RESOLVE_CONCURRENCY = 4
/** 无房间占位 / 归属反查失败的默认重试间隔：占位成员日后可能开通房间，过期后重试一次 */
const EMPTY_CHANNEL_TTL = 30 * 60 * 1000
/** 每轮最多拉取的房间消息列表数：一页几十 KB，关注多时按轮转摊平（见 pickProbes） */
const MAX_MESSAGE_PROBES = 9
/** 消息列表并发上限：一轮最多 9 个房间，分 3 路拉完 */
const PROBE_CONCURRENCY = 3

/** 单个房间的未读快照 */
interface UnreadRoomState {
  /** 未读条数（大房间 + 小房间合计；单频道上限 ROOM_MESSAGE_LIMIT） */
  count: number
  /** 大房间频道的未读贡献（房间 tab 的点点） */
  bigCount: number
  /** 小房间（暗号频道）的未读贡献（小房间 tab 的点点） */
  smallCount: number
  /** 最新一条未读消息时刻（ms） */
  latestTime: number
}

/** 房间频道缓存条目：server/jump 解析结果 + 解析时刻（空频道占位按 TTL 重试） */
interface StoredChannel {
  serverId: string
  channelId: string
  resolvedAt: number
}

/** 单个频道的未读（channelId 为键）：由消息列表数出，markRead 时归零 */
interface ChannelUnread {
  /** 已数出的条数（列表接口一页封顶） */
  count: number
  /** 该频道最新一条计数消息的时刻（ms），聚合到房间快照用 */
  latestTime: number
}

/**
 * 已读水位（channelId 为键，消息列表空间）：未读 = 列表中比它更新的条数。
 * 记录消息 id 与时刻两者：优先按 id 定位水位那条（同一毫秒多条也不会错位），
 * id 缺失（老消息）时退回时刻比较。
 */
interface ReadMark {
  msgTime: number
  msgIdServer: string
}

/** pocket48-unread.json 持久化结构（userId 十进制字符串键，与接口返回一致） */
interface StoredUnread {
  /**
   * 预览接口的消息身份键锚（**channelId 为键**——一个成员有大房间和小房间两个频道）：
   * 只作「该频道有新消息」的触发判据，**探测成功后才推进**——本轮被名额挤掉的频道
   * 下一轮仍是「有更新」，不会被漏掉。键值一律来自 lastMsgList 检测侧，渲染层不写此字段。
   */
  seenKeys: Record<string, string>
  /** 各频道的未读数（由消息列表数出，markRead 归零） */
  unreadChannels: Record<string, ChannelUnread>
  /** 各频道的已读水位；只有首见锚定与 markRead 会推进它 */
  readMarks: Record<string, ReadMark>
  /** 大房间频道缓存（userId 为键）；channelId 为空串 = 解析过但无房间（或解析失败）的占位 */
  channels: Record<string, StoredChannel>
  /**
   * 小房间（暗号频道，room/info 回 questionId 问答信封）缓存（userId 为键），
   * 与大房间同 server，按「同 server 唯一关注成员」归属；大房间不存在时无从归属。
   */
  smallChannels: Record<string, StoredChannel>
  /**
   * 未归属频道的房主反查缓存（channelId 为键）：ownerId = 0 表示非成员房间
   * （翻牌/礼物回复等），按 TTL 重试；> 0 的归属终身复用。
   */
  roomOwners: Record<string, { ownerId: number, resolvedAt: number }>
  /** 未读快照（只有 count>0 的条目），重启不丢 */
  unread: Record<string, UnreadRoomState>
}

let storeFile: SafeJSONFileSync<StoredUnread> | null = null
let stored: StoredUnread | null = null
let timer: NodeJS.Timeout | null = null
/** 轮询重入护栏：上一轮请求还没回来时直接跳过本轮 */
let ticking = false
/** start 时上一轮还没结束：等它释放护栏后立即补跑，而不是落到下一个 60s 定时器 */
let startRequested = false
/**
 * 各频道上一次探测时刻（仅本进程内）：房间数超过每轮名额时按它轮转，先挑最久没查的。
 * 重启后为空 = 全部视为最久没查，先来先服务。
 */
const lastProbeAt = new Map<string, number>()
/**
 * 待对齐水位的频道（仅本进程内）：markRead 拉列表对齐失败时挂起，下一轮检测先对齐再计数，
 * 免得刚读过的消息被当成未读复活。挂起期间该频道不计数。
 */
const alignPending = new Set<string>()

/** 惰性加载持久化状态（app.getPath 在应用 ready 前不可用，与 pocket-auth 同款时机） */
function store(): StoredUnread {
  if (!stored) {
    if (!storeFile)
      storeFile = new SafeJSONFileSync<StoredUnread>(path.join(app.getPath('userData'), 'pocket48-unread.json'))
    const loaded = storeFile.read()
    stored = {
      seenKeys: loaded?.seenKeys ?? {},
      unreadChannels: loaded?.unreadChannels ?? {},
      readMarks: loaded?.readMarks ?? {},
      channels: loaded?.channels ?? {},
      smallChannels: loaded?.smallChannels ?? {},
      roomOwners: loaded?.roomOwners ?? {},
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
  debug('[pocket-unread] 广播未读快照 total:', state.total, 'rooms:', JSON.stringify(state.rooms))
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

  // 已取关的成员：频道缓存与未读/水位状态一并清掉——房间已不在列表，markRead 无从触发，
  // 残留的未读会永远计入 Dock 总数（广播后左列与角标同步消失）。
  // 注意 seenKeys/unreadChannels/readMarks 都以 channelId 为键，须按频道 id 逐个删
  for (const key of known) {
    if (!followedIds.includes(Number(key))) {
      debug('[pocket-unread] 成员已取关，清理频道缓存与未读状态', key)
      const hadUnread = !!data.unread[key]
      const channelIds = [data.channels[key]?.channelId, data.smallChannels[key]?.channelId]
        .filter((cid): cid is string => !!cid)
      delete data.channels[key]
      delete data.smallChannels[key]
      delete data.unread[key]
      for (const channelId of channelIds) {
        delete data.seenKeys[channelId]
        delete data.unreadChannels[channelId]
        delete data.readMarks[channelId]
        lastProbeAt.delete(channelId)
        alignPending.delete(channelId)
      }
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
  debug(
    '[pocket-unread] 频道解析：待解析',
    missing.length,
    '个 / 关注',
    followedIds.length,
    '个；无房间占位成员：',
    Object.entries(data.channels)
      .filter(([, c]) => !c.channelId)
      .map(([k]) => k)
      .join(',') || '无',
  )

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
        debug('[pocket-unread] 频道解析成功', userId, '->', channel.serverId, channel.channelId)
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

/**
 * 未归属频道自愈：lastMsgList 回包里会出现同 server 下未登记的频道
 * （可能是「频道解析失败的关注成员」的房间，也可能是互动频道/未关注成员房间）。
 * 用 room/info 反查房主：ownerId 命中关注名单就把频道补进归属表（下一轮生效）；
 * 未命中/无房主记负缓存按 TTL 重试。返回是否有结构变化。
 */
async function healChannelOwners(
  lastMessages: PocketRoomLastMessage[],
  attributedChannelIds: Set<string>,
  followedIds: number[],
): Promise<boolean> {
  const data = store()
  const now = Date.now()
  const unknown = [...new Set(lastMessages.map(item => item.channelId).filter(cid => cid && !attributedChannelIds.has(cid)))]
  const toResolve = unknown.filter((channelId) => {
    const cached = data.roomOwners[channelId]
    if (!cached)
      return true
    // 正向归属终身复用；负缓存（非房间频道）按 TTL 重试
    return cached.ownerId === 0 && now - cached.resolvedAt > EMPTY_CHANNEL_TTL
  })
  if (!toResolve.length)
    return false
  debug('[pocket-unread] 未归属频道自愈：', toResolve.join(','))
  let dirty = false
  let cursor = 0
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, toResolve.length) }, async () => {
    while (cursor < toResolve.length) {
      const channelId = toResolve[cursor++]
      try {
        const info = await getRoomChannelOwner(channelId)
        data.roomOwners[channelId] = { ownerId: info.ownerId, resolvedAt: Date.now() }
        dirty = true
        const ownerKey = String(info.ownerId)
        if (info.ownerId && followedIds.includes(info.ownerId)) {
          // 这里必须也允许补空占位：owner 解析失败时 channels 里已存在 channelId=''，
          // 若只补「不存在」的 key，自愈会被旧占位永久挡住
          if (!data.channels[ownerKey] || !data.channels[ownerKey].channelId) {
            // serverId 优先用 room/info 的，缺了从回包条目里拿（两者都有就无需再跳转解析）
            const fromResponse = lastMessages.find(item => item.channelId === channelId)?.serverId || ''
            debug('[pocket-unread] 频道归属补全', ownerKey, '->', info.serverId || fromResponse, channelId)
            data.channels[ownerKey] = { serverId: info.serverId || fromResponse, channelId, resolvedAt: Date.now() }
          }
          else {
            debug('[pocket-unread] 归属反查命中已登记成员，忽略', channelId, '->', ownerKey)
          }
        }
        else if (info.ownerId) {
          debug('[pocket-unread] 未归属频道属于未关注成员', channelId, '->', info.ownerId)
        }
        else {
          debug('[pocket-unread] 未归属频道无房主（非房间频道），记负缓存', channelId)
        }
      }
      catch (error) {
        // token 失效上抛：整轮放弃
        if (error instanceof Error && error.message.includes('登录已过期'))
          throw error
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('"questionId"')) {
          // 暗号频道 = 成员的小房间（room/info 被暗号拦下，拿不到 ownerId）：
          // 小房间与成员大房间同 server，按「同 server 的唯一关注成员」归属
          const fromResponse = lastMessages.find(item => item.channelId === channelId)?.serverId || ''
          const owners = Object.entries(data.channels)
            .filter(([, channel]) => channel.channelId && channel.serverId === fromResponse)
            .map(([userId]) => userId)
          if (owners.length === 1 && !data.smallChannels[owners[0]]) {
            debug('[pocket-unread] 小房间（暗号频道）归属补全', owners[0], '->', channelId)
            data.smallChannels[owners[0]] = { serverId: fromResponse, channelId, resolvedAt: Date.now() }
          }
          else {
            debug('[pocket-unread] 小房间归属不唯一或已登记，记负缓存', channelId, owners.join(',') || '无同 server 成员')
            data.roomOwners[channelId] = { ownerId: 0, resolvedAt: Date.now() }
          }
          dirty = true
        }
        else if (message.includes('频道不存在')) {
          // 翻牌/礼物回复等非成员房间：记负缓存按 TTL 重试，避免每轮重打必失败请求
          data.roomOwners[channelId] = { ownerId: 0, resolvedAt: Date.now() }
          dirty = true
          debug('[pocket-unread] 非成员房间，记负缓存', channelId, message.slice(0, 60))
        }
        else {
          // 网络类失败不记缓存，下轮重试
          log('[pocket-unread] 频道归属反查失败（下轮重试）', channelId, error)
        }
      }
    }
  })
  await Promise.all(workers)
  return dirty
}

/**
 * 计数口径与渲染层成员视图一致：homeowner 接口会混入官方系统账号的发言，
 * 渲染层把它剔除，这里也不计入——否则角标会多出用户在房间里看不到的未读。
 */
function countableMessages(messages: PocketRoomMessage[]): PocketRoomMessage[] {
  return messages.filter(message => message.userId !== OFFICIAL_POCKET_USER_ID)
}

/**
 * 数出比已读水位更新的条数（列表按 msgTime 倒序，最新在前）。
 * 优先按消息 id 定位水位那条：找到了它，它前面的就是未读；找不到说明水位那条
 * 已经沉到本页之外，整页都比它新——条数封顶在 ROOM_MESSAGE_LIMIT（渲染层据此显示 50+）。
 */
function countNewer(messages: PocketRoomMessage[], mark: ReadMark): number {
  if (!messages.length)
    return 0
  // 按 id 定位水位那条：找到了它，它前面的就是未读；找不到说明水位那条已经沉到本页之外，
  // 整页都比它新——条数封顶在 ROOM_MESSAGE_LIMIT（渲染层据此显示 50+）。
  // 回包不带 msgIdServer 时退回时刻比较（首条没有 id 即视为整页无 id）
  if (mark.msgIdServer && messages[0].msgIdServer) {
    const index = messages.findIndex(message => message.msgIdServer === mark.msgIdServer)
    return index >= 0 ? index : Math.min(messages.length, ROOM_MESSAGE_LIMIT)
  }
  const newer = messages.filter(message => message.msgTime > mark.msgTime).length
  return Math.min(newer, ROOM_MESSAGE_LIMIT)
}

/** 待探测的房间：channelId + serverId + 本轮预览里的身份键（探测成功后用它推进触发锚） */
interface ProbeCandidate {
  channelId: string
  serverId: string
  previewKey: string
}

/**
 * 挑出本轮要探测的房间并拉取消息列表计数。返回是否有状态变化。
 * 名额（MAX_MESSAGE_PROBES）按「上次探测时刻」排序轮转，最久没查的先查，
 * 被挤掉的频道本轮不推进触发锚，下一轮仍是「有更新」，不会漏。
 */
async function probeChannels(candidates: ProbeCandidate[]): Promise<boolean> {
  const data = store()
  let dirty = false
  let cursor = 0
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const { channelId, serverId, previewKey } = candidates[cursor++]
      lastProbeAt.set(channelId, Date.now())
      try {
        const { messages } = await getRoomMessages(channelId, serverId, 0, 'member')
        const list = countableMessages(messages)
        const newest = list[0]
        const mark = data.readMarks[channelId]
        if (!mark || alignPending.has(channelId)) {
          // 首见锚定 / 上一轮 markRead 对齐失败：把水位推到当下，本轮不计未读
          if (newest)
            data.readMarks[channelId] = { msgTime: newest.msgTime, msgIdServer: newest.msgIdServer }
          data.unreadChannels[channelId] = { count: 0, latestTime: newest?.msgTime ?? 0 }
          alignPending.delete(channelId)
          debug('[pocket-unread] 锚定已读水位', channelId, '=', mark?.msgTime ?? '-', '->', newest?.msgTime ?? '-')
        }
        else {
          const count = countNewer(list, mark)
          data.unreadChannels[channelId] = { count, latestTime: newest?.msgTime ?? mark.msgTime }
          if (count > 0)
            debug('[pocket-unread] 计未读（消息列表数条数）', channelId, '=', count)
        }
        // 触发锚只在探测成功后推进（预览缺条时保留旧锚，下一轮再触发）
        if (previewKey)
          data.seenKeys[channelId] = previewKey
        dirty = true
      }
      catch (error) {
        // token 失效上抛：整轮放弃；其余失败不推进触发锚，下一轮重试同一频道
        if (error instanceof Error && error.message.includes('登录已过期'))
          throw error
        log('[pocket-unread] 拉取房间消息失败（下一轮重试）', channelId, error)
      }
    }
  })
  await Promise.all(workers)
  return dirty
}

/** 由「按频道的未读」聚合出「按成员的房间快照」（markRead 局部清零后也复用它） */
function aggregate(): Record<string, UnreadRoomState> {
  const data = store()
  const smallChannelIds = new Set(Object.values(data.smallChannels).map(channel => channel.channelId))
  const ownerByChannel = new Map<string, string>()
  for (const [userId, channel] of Object.entries(data.channels)) {
    if (channel.channelId)
      ownerByChannel.set(channel.channelId, userId)
  }
  for (const [userId, channel] of Object.entries(data.smallChannels)) {
    if (channel.channelId)
      ownerByChannel.set(channel.channelId, userId)
  }
  const aggregated: Record<string, UnreadRoomState> = {}
  for (const [channelId, channel] of Object.entries(data.unreadChannels)) {
    if (channel.count <= 0)
      continue
    const ownerId = ownerByChannel.get(channelId)
    if (!ownerId)
      continue
    const entry = aggregated[ownerId] ?? { count: 0, bigCount: 0, smallCount: 0, latestTime: 0 }
    entry.count += channel.count
    if (smallChannelIds.has(channelId))
      entry.smallCount += channel.count
    else
      entry.bigCount += channel.count
    entry.latestTime = Math.max(entry.latestTime, channel.latestTime)
    aggregated[ownerId] = entry
  }
  return aggregated
}

/** 两份房间快照是否等价（决定是否需要广播 / 落盘） */
function sameSnapshot(a: Record<string, UnreadRoomState>, b: Record<string, UnreadRoomState>): boolean {
  const ids = Object.keys(a)
  if (ids.length !== Object.keys(b).length)
    return false
  return ids.every((id) => {
    const before = b[id]
    const after = a[id]
    return !!before && before.count === after.count && before.latestTime === after.latestTime
  })
}

/**
 * 清空账号相关未读（未读/水位/触发锚），有变化则落盘 + 广播归零。
 * 登出与 token 失效即刻调用 —— 原先等轮询发现未登录才清（最长 60s，期间角标误导）。
 * 频道缓存与账号无关，保留；重登后无旧锚，走首见锚定不补登出前消息。
 */
export function clearAccountUnread(): void {
  const data = store()
  const hadUnread = Object.keys(data.unread).length > 0
  const hadAccountState = hadUnread
    || Object.keys(data.seenKeys).length > 0
    || Object.keys(data.unreadChannels).length > 0
    || Object.keys(data.readMarks).length > 0
  data.unread = {}
  data.seenKeys = {}
  data.unreadChannels = {}
  data.readMarks = {}
  alignPending.clear()
  lastProbeAt.clear()
  if (hadAccountState) {
    persist()
    if (hadUnread)
      publish()
  }
}

/** 单轮检测：登录态 → 关注名单 → 频道补齐 → 批量预览（触发）→ 拉列表计数 → 未归属频道自愈 */
async function tick(): Promise<void> {
  if (ticking)
    return
  ticking = true
  try {
    const data = store()

    // 未登录：未读与水位/触发锚都是账号相关状态，一并清空（与登出同一条路径）
    if (!getToken()) {
      debug('[pocket-unread] 未登录，跳过本轮检测并清空账号状态')
      clearAccountUnread()
      return
    }
    // 屏蔽优先：屏蔽是本地可见性偏好（与关注正交，接线见 renderer 的 use-member-actions），
    // 未读检测按同一条口径把被屏蔽成员从关注名单里剔除 —— 它们既不该计数，也不该占频道解析名额。
    // 剔除后 ensureChannels 会顺带清掉它们的频道缓存与未读，走的正是「取关清理」那条路径。
    const blockedIds = new Set(Database.instance().getMemberFlagIds('blocked'))
    const followedIds = (await getFollowedIds()).filter(id => !blockedIds.has(id))
    debug('[pocket-unread] 本轮关注名单', followedIds.length, '人（已剔除屏蔽', blockedIds.size, '人）：', followedIds.join(','))
    const { dirty: channelDirty, unreadChanged: unfollowChanged } = await ensureChannels(followedIds)
    let dirty = channelDirty

    // serverId 去重（同一 team server 下多个成员频道）；channelId → userId 反查
    // 大房间与小房间（暗号频道）都挂在成员名下，小房间新消息同样计入该成员未读
    const serverIds = new Set<string>()
    const channelOwner = new Map<string, string>()
    const channelServer = new Map<string, string>()
    for (const [userId, channel] of Object.entries(data.channels)) {
      if (!channel.channelId)
        continue
      serverIds.add(channel.serverId)
      channelOwner.set(channel.channelId, userId)
      channelServer.set(channel.channelId, channel.serverId)
    }
    for (const [userId, channel] of Object.entries(data.smallChannels)) {
      if (!channel.channelId)
        continue
      serverIds.add(channel.serverId)
      channelOwner.set(channel.channelId, userId)
      channelServer.set(channel.channelId, channel.serverId)
    }
    debug(
      '[pocket-unread] 本轮查询',
      serverIds.size,
      '个 server；频道归属：',
      [...channelOwner.entries()].map(([cid, uid]) => `${cid}=${uid}`).join(' ') || '空',
    )

    if (!serverIds.size) {
      if (dirty || unfollowChanged)
        persist()
      if (unfollowChanged)
        publish()
      return
    }

    // 批量预览：一次请求覆盖全部关注房间，只为判断「哪个频道有新消息」。
    // 首见（还没有触发锚）/ 身份键变化 / 上次 markRead 对齐失败 → 进本轮探测队列
    const lastMessages = await getRoomLastMessages([...serverIds])
    debug('[pocket-unread] lastMsgList 回包', lastMessages.length, '条')
    const pending = new Map<string, ProbeCandidate>()
    for (const item of lastMessages) {
      if (!channelOwner.has(item.channelId)) {
        // 回包里的频道不在归属表（缓存缺失/已取关竞态）：记下来方便对线
        debug('[pocket-unread] 回包频道无法归属，跳过', item.channelId)
        continue
      }
      const msgKey = item.msgKey || `${item.msgTime}:${item.msgContent}`
      const serverId = item.serverId || channelServer.get(item.channelId) || ''
      // serverId 缺失（jump 回包没给全）时拉不了列表，跳过以免每轮打一次注定失败的请求
      if (!serverId)
        continue
      const seenKey = data.seenKeys[item.channelId]
      if (seenKey === undefined || seenKey !== msgKey) {
        pending.set(item.channelId, { channelId: item.channelId, serverId, previewKey: msgKey })
      }
    }
    // 对齐挂起的频道即使预览没回条也要探测（水位还欠着）
    for (const channelId of alignPending) {
      if (pending.has(channelId))
        continue
      const serverId = channelServer.get(channelId)
      if (serverId)
        pending.set(channelId, { channelId, serverId, previewKey: '' })
    }

    const probes = [...pending.values()]
      .sort((a, b) => (lastProbeAt.get(a.channelId) ?? 0) - (lastProbeAt.get(b.channelId) ?? 0))
      .slice(0, MAX_MESSAGE_PROBES)
    if (pending.size > probes.length)
      debug('[pocket-unread] 本轮房间超出名额，顺延下一轮：', pending.size, '->', probes.length)
    if (probes.length && await probeChannels(probes))
      dirty = true

    // 按成员聚合（大房间 + 小房间都记在成员头上）并与旧快照比对
    let unreadChanged = false
    const aggregated = aggregate()
    if (!sameSnapshot(aggregated, data.unread)) {
      data.unread = aggregated
      unreadChanged = true
    }

    // 未归属频道自愈：反查房主、补全归属表（新归属下一轮生效）；结构变化随本轮一并落盘
    if (await healChannelOwners(lastMessages, new Set(channelOwner.keys()), followedIds))
      dirty = true

    // 未读累加也必须落盘：dirty 只覆盖频道解析/触发锚，不含计数路径，漏了会「重启丢未读」；
    // 取关清理（unfollowChanged）同属「registry 结构变化」，一并落盘并广播
    if (dirty || unreadChanged || unfollowChanged)
      persist()
    if (unreadChanged || unfollowChanged)
      publish()
    debug(
      '[pocket-unread] 本轮结束 dirty:',
      dirty,
      'unreadChanged:',
      unreadChanged,
      'unfollowChanged:',
      unfollowChanged,
      '当前未读总数:',
      snapshot().total,
    )
  }
  catch (error) {
    // token 失效 / 网络异常：registry 冻结等下一轮，未读不丢
    log('[pocket-unread] 未读检测本轮跳过', error)
  }
  finally {
    ticking = false
    if (timer && startRequested) {
      startRequested = false
      void tick()
    }
  }
}

// ===== 对渲染层暴露（对端：register-pocket-ipc.ts） =====

/** 全量未读快照（启动时回取一次；后续变化走 pocketUnreadBatch 事件） */
export function getState(): PocketUnreadBatch {
  return snapshot()
}

/**
 * 把某频道的已读水位推到「当下」：拉一页最新消息，取其中最新一条为水位。
 * 失败不回滚已清零的结果，改为挂起——下一轮检测先对齐水位再计数，
 * 免得刚读过的消息被当成未读复活（挂起期间该频道不计数，最多损失一论的消息）。
 */
async function alignReadMark(channel: StoredChannel): Promise<void> {
  const data = store()
  try {
    const { messages } = await getRoomMessages(channel.channelId, channel.serverId, 0, 'member')
    const newest = countableMessages(messages)[0]
    if (newest) {
      data.readMarks[channel.channelId] = { msgTime: newest.msgTime, msgIdServer: newest.msgIdServer }
      alignPending.delete(channel.channelId)
    }
    else {
      alignPending.add(channel.channelId)
    }
    lastProbeAt.set(channel.channelId, Date.now())
    persist()
    debug('[pocket-unread] 已读水位对齐完成', channel.channelId, '=', newest?.msgTime ?? '-')
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('登录已过期'))
      throw error
    alignPending.add(channel.channelId)
    log('[pocket-unread] 已读水位对齐失败（下一轮检测对齐）', channel.channelId, error)
  }
}

/**
 * 标记房间已读（target 指定大房间或小房间）：该频道未读清零并广播，随后把它的
 * 已读水位推到「此刻」——下一轮检测数出的就是「读了之后又来的新消息」。
 * 大房间与小房间是两个独立频道、各有查看入口，进哪个清哪个；
 * 另一路的未读按频道记着，直接沿用（不必为此再拉一轮接口）。
 *
 * 不接收渲染层的消息键——渲染层拿到的那套 id 来自它自己的分页列表，与检测侧
 * 对齐用的水位不是同一次取数，混写会让已读复活（踩过）。
 */
export async function markRead(userId: number, target: 'room' | 'small' = 'room'): Promise<void> {
  const data = store()
  const key = String(userId)
  const entry = data.unread[key]
  debug('[pocket-unread] markRead', key, target, '未读条数:', entry?.count ?? 0)
  // 目标频道不存在（如小房间还没被归属自愈发现）：无从对齐，无事可做
  const clearChannel = (target === 'small' ? data.smallChannels[key] : data.channels[key]) ?? null
  if (!entry || !clearChannel?.channelId)
    return
  const channelId = clearChannel.channelId
  // 清零只抹掉目标通道的计数，另一路原样保留；清完立即重建快照并广播，
  // 与渲染层的乐观清零值一致，避免「角标整块消失、对齐后小房间未读又冒回来」的闪烁
  const hadUnread = (data.unreadChannels[channelId]?.count ?? 0) > 0
  delete data.unreadChannels[channelId]
  data.unread = aggregate()
  persist()
  publish()
  // 本就没未读的频道不必再拉一页列表：水位还在原处，新消息照常由检测轮数出来
  if (hadUnread)
    await alignReadMark(clearChannel)
}

/**
 * 成员的小房间（暗号频道）频道，给渲染层查看入口用；null = 尚未发现。
 * 小房间频道只能经归属自愈被动发现（lastMsgList 回包出现 + room/info 被暗号
 * questionId 信封拦下 + 同 server 唯一关注成员归属），没有主动探测接口。
 */
export function getSmallChannel(userId: number): { serverId: string, channelId: string } | null {
  const channel = store().smallChannels[String(userId)]
  return channel?.channelId ? { serverId: channel.serverId, channelId: channel.channelId } : null
}

// ===== 生命周期（对端：app.ts） =====

/** 启动未读检测：立即跑一轮，之后按 POLL_MS 低频轮询；幂等 */
export function startPocketUnread(): void {
  if (timer)
    return
  timer = setInterval(() => void tick(), POLL_MS)
  // 启动先发布一次持久化快照，重启后角标不用等第一轮网络轮询才恢复
  publish()
  if (ticking)
    startRequested = true
  else
    void tick()
  log('[pocket-unread] 未读检测已启动')
}

export function stopPocketUnread(): void {
  startRequested = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
