import type { PocketUnreadBatch } from '../../preload/ipc-contract'
import type { PocketRoomLastMessage } from './pocket-auth'
/**
 * 房间未读检测服务（主进程唯一真相）。
 *
 * 设计原则：检测与未读状态都归主进程 —— 页面没开、窗口最小化时未读照样积累
 * （定时器在主进程，不受 Chromium 对失焦窗口的节流影响）；
 * 渲染层（stores/pocket-unread.ts）只做镜像与展示，经 pocketUnreadBatch 全量广播保持一致，
 * 与任务列表（task-registry → stores/tasks）是同一套「主进程真相 + 各窗镜像」的模式。
 *
 * 检测链路：60s 低频轮询 im/team/classic/last/message/get 批量预览接口
 * （一次请求覆盖全部关注的房间，登录态复用 pocket-auth），与每个房间的「已读回执键」比对：
 * - 该接口回包的 msgTime 实测恒为 0，无法当时间轴；「有新消息」只能靠消息身份键
 *   （msgidClient 优先，见 getRoomLastMessages 的 msgKey）变化来判断；
 * - 首次见到某频道：回执键直接锚定当前最新消息，历史不算未读；
 * - 最新消息的身份键 ≠ 已计入的键：未读 +1（该接口每频道只回最新一条，
 *   一轮只按「有新消息」粗算 +1，进入房间后 markRead 整体清零）；
 * - seenKeys 记录已计入/已锚定的消息身份键：同一条消息不会被每轮重复累加；
 *   markRead 不写此字段（渲染层键与检测键不同空间，混写会导致已读复活），
 *   而是删除对应频道的键，下一轮检测重新锚定到用户刚读到的最新消息。
 *
 * 持久化（userData/pocket48-unread.json，原子写 + 坏档回退复用 SafeJSONFileSync）：
 * 频道解析结果（server/jump，开销最大的一段）随水位/未读快照一并落盘，重启不重解析、不丢未读。
 * token 失效 / 网络异常：本轮静默跳过、registry 冻结（未读不丢），恢复后下一轮续跑；
 * 未登录（凭证文件不存在）：清空未读与账号相关水位/计数并广播，重登按首见重新锚定。
 */
import path from 'node:path'
import { app } from 'electron'
import { broadcastIpc } from '../ipc/send'
import { debug, log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import { getFollowedIds, getRoomChannel, getRoomChannelOwner, getRoomLastMessages, getToken } from './pocket-auth'

/** 轮询间隔：低频检测（每轮一次批量请求），又不至于让角标迟滞超过一分钟 */
const POLL_MS = 60_000
/** 频道解析并发上限：关注几十人时首轮不打爆 server/jump */
const RESOLVE_CONCURRENCY = 4
/** 无房间占位 / 归属反查失败的默认重试间隔：占位成员日后可能开通房间，过期后重试一次 */
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
  /**
   * 已计入/已锚定的消息身份键（**channelId 为键**——一个成员有大房间和小房间两个频道，
   * 按 userId 存会互相顶掉）：既做「首轮锚定」（历史不算未读），又做「防重复计数」
   * （同一条最新消息不反复 +1）。键值一律来自 lastMsgList 检测侧，渲染层不写此字段——
   * 渲染层消息 id 与检测键不同空间（文本消息检测键是 `0:正文`，渲染层是 msgIdServer/msgTime），
   * 混写会让已读房间被误判成有新消息（踩过）。
   * 历史版本：v1 按 userId 存 msgTime 水位（接口 msgTime 恒为 0，废）、
   * v2 叫 countedKeys 且被 markRead 混写过渲染层键（废）——读档直接忽略旧字段，全员重新锚定。
   */
  seenKeys: Record<string, string>
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

/** 惰性加载持久化状态（app.getPath 在应用 ready 前不可用，与 pocket-auth 同款时机） */
function store(): StoredUnread {
  if (!stored) {
    if (!storeFile)
      storeFile = new SafeJSONFileSync<StoredUnread>(path.join(app.getPath('userData'), 'pocket48-unread.json'))
    const loaded = storeFile.read()
    stored = {
      seenKeys: loaded?.seenKeys ?? {},
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

  // 已取关的成员：频道缓存与未读/回执键一并清掉——房间已不在列表，markRead 无从触发，
  // 残留的未读会永远计入 Dock 总数（广播后左列与角标同步消失）
  for (const key of known) {
    if (!followedIds.includes(Number(key))) {
      debug('[pocket-unread] 成员已取关，清理频道缓存与未读状态', key)
      const hadUnread = !!data.unread[key]
      delete data.channels[key]
      delete data.smallChannels[key]
      delete data.unread[key]
      delete data.seenKeys[key]
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

/** 单轮检测：登录态 → 关注名单 → 频道补齐 → 批量最新消息 → 水位比对计数 → 未归属频道自愈 */
async function tick(): Promise<void> {
  if (ticking)
    return
  ticking = true
  try {
    const data = store()

    // 未登录：未读与回执键都是账号相关状态，一并清空；频道缓存与账号无关可保留。
    // 重登后没有旧回执键，最新消息会走「首见锚定」，不会把登出前的消息补成未读
    if (!getToken()) {
      debug('[pocket-unread] 未登录，跳过本轮检测并清空账号状态')
      const hadUnread = Object.keys(data.unread).length > 0
      const hadAccountState = hadUnread || Object.keys(data.seenKeys).length > 0
      data.unread = {}
      data.seenKeys = {}
      if (hadAccountState) {
        persist()
        if (hadUnread)
          publish()
      }
      return
    }
    const followedIds = await getFollowedIds()
    debug('[pocket-unread] 本轮关注名单', followedIds.length, '人：', followedIds.join(','))
    const { dirty: channelDirty, unreadChanged: unfollowChanged } = await ensureChannels(followedIds)
    let dirty = channelDirty

    // serverId 去重（同一 team server 下多个成员频道）；channelId → userId 反查
    // 大房间与小房间（暗号频道）都挂在成员名下，小房间新消息同样计入该成员未读
    const serverIds = new Set<string>()
    const channelOwner = new Map<string, string>()
    for (const [userId, channel] of Object.entries(data.channels)) {
      if (!channel.channelId)
        continue
      serverIds.add(channel.serverId)
      channelOwner.set(channel.channelId, userId)
    }
    for (const [userId, channel] of Object.entries(data.smallChannels)) {
      if (!channel.channelId)
        continue
      serverIds.add(channel.serverId)
      channelOwner.set(channel.channelId, userId)
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

    let unreadChanged = false
    const lastMessages = await getRoomLastMessages([...serverIds])
    debug('[pocket-unread] lastMsgList 回包', lastMessages.length, '条：', JSON.stringify(lastMessages))
    for (const item of lastMessages) {
      const userId = channelOwner.get(item.channelId)
      if (!userId) {
        // 回包里的频道不在归属表（缓存缺失/已取关竞态）：记下来方便对线
        debug('[pocket-unread] 回包频道无法归属，跳过', item.channelId)
        continue
      }
      // msgTime 实测恒为 0，身份键才是唯一的「新消息」判据；回执键按 channelId 存
      // （大/小房间各自独立锚定与防重复，未读都记到成员头上）
      const msgKey = item.msgKey || `${item.msgTime}:${item.msgContent}`
      const seenKey = data.seenKeys[item.channelId]
      if (seenKey === undefined) {
        // 首次见到该频道（或 markRead 刚清掉回执键）：锚定当前最新消息，历史不算未读
        debug('[pocket-unread] 锚定回执键', item.channelId, '=', msgKey.slice(0, 40))
        data.seenKeys[item.channelId] = msgKey
        dirty = true
        continue
      }
      // 最新消息换了身份：有新消息，+1（接口每频道只回最新一条，无法数出真实增量）
      if (msgKey !== seenKey) {
        debug(
          '[pocket-unread] 新消息计未读',
          userId,
          ': key',
          msgKey.slice(0, 40),
          '≠ 已计',
          seenKey.slice(0, 40),
        )
        const entry = data.unread[userId] ?? { count: 0, latestTime: 0 }
        entry.count += 1
        entry.latestTime = item.msgTime
        data.unread[userId] = entry
        data.seenKeys[item.channelId] = msgKey
        unreadChanged = true
      }
      else {
        debug('[pocket-unread] 无新消息', userId, ': key 未变', msgKey.slice(0, 40))
      }
    }

    // 未归属频道自愈：反查房主、补全归属表（新归属下一轮生效）；结构变化随本轮一并落盘
    if (await healChannelOwners(lastMessages, new Set(channelOwner.keys()), followedIds))
      dirty = true

    // 未读累加也必须落盘：dirty 只覆盖频道解析/首见锚定，不含计数路径，漏了会「重启丢未读」；
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
 * 标记房间已读：未读清零并广播。
 * 不接收渲染层的消息键——渲染层消息 id 与检测键（lastMsgList 空间）不同空间，
 * 混写回执键会让已读房间在下一轮被误判成有新消息而「复活」（踩过）。
 * 改为删除该房间大频道的回执键，下一轮检测重新锚定到当前最新消息
 * （锚定不计数，等价于「读到此刻为止」）；代价是 markRead 与下一轮检测之间
 * （≤60s）到达的新消息会被一并锚掉，阅读场景下可接受。
 */
export function markRead(userId: number): void {
  const data = store()
  const key = String(userId)
  const entry = data.unread[key]
  debug('[pocket-unread] markRead', key, '未读条数:', entry?.count ?? 0)
  // 没有未读就无事可做：回执键已在位（首见即锚定），不产生落盘与广播
  if (!entry)
    return
  delete data.unread[key]
  // 回执键按大房间 channelId 删（渲染层消息流是大房间）；小房间没有已读入口，不在此列。
  // 下一轮 tick 走「锚定」分支会置 dirty 并落盘，这里无需额外标记
  const receiptKeyId = data.channels[key]?.channelId
  if (receiptKeyId)
    delete data.seenKeys[receiptKeyId]
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
