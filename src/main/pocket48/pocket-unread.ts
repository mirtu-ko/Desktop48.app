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
 * （一次请求覆盖全部关注的房间，登录态复用 pocket-auth）。双模式计数：
 * - 精确模式（pa 动态签名生效，回包带 unreadCount）：服务端计数与本地基线做差，
 *   未读 = unreadCount - 基线，与官方客户端同源、精确到条；基线在 markRead 时
 *   即时拉一轮批量预览对齐到「此刻」，服务端计数回落（别处已读）则自动清零；
 * - 降级模式（静态 pa，回包只有 4 个字段）：靠消息身份键变化粗算，每频道每轮
 *   最多 +1，同一房间连发两条相同文本会漏计——接口信息上限，见 pocket-auth 的 msgKey。
 * 两种模式按频道独立、逐轮回包自适应（pa 失效自动落回粗算，恢复后自动升回精确）。
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
   * 消息身份键锚（**channelId 为键**——一个成员有大房间和小房间两个频道）：
   * 降级模式的「首轮锚定 + 防重复计数」判据；精确模式也同步维护它，
   * 保证 pa 失效降级时无缝切到粗算而不误跳。键值一律来自 lastMsgList 检测侧，
   * 渲染层不写此字段（渲染层消息 id 与检测键不同空间，混写会让已读复活，踩过）。
   */
  seenKeys: Record<string, string>
  /** 降级模式：各频道累计的「有新消息」轮次计数（身份键变化 +1，markRead 清零） */
  fallbackUnread: Record<string, number>
  /** 精确模式：各频道已对齐的服务端 unreadCount 基线（markRead 对齐到当下） */
  baselines: Record<string, number>
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
      fallbackUnread: loaded?.fallbackUnread ?? {},
      baselines: loaded?.baselines ?? {},
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

  // 已取关的成员：频道缓存与未读/回执状态一并清掉——房间已不在列表，markRead 无从触发，
  // 残留的未读会永远计入 Dock 总数（广播后左列与角标同步消失）。
  // 注意 seenKeys/fallbackUnread/baselines 都以 channelId 为键，须按频道 id 逐个删
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
        delete data.fallbackUnread[channelId]
        delete data.baselines[channelId]
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
      const hadAccountState = hadUnread
        || Object.keys(data.seenKeys).length > 0
        || Object.keys(data.baselines).length > 0
        || Object.keys(data.fallbackUnread).length > 0
      data.unread = {}
      data.seenKeys = {}
      data.baselines = {}
      data.fallbackUnread = {}
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

    // 每轮按频道重算未读贡献、再按成员聚合——自愈式：基线/锚漂移会在下一轮自动收敛
    interface ChannelContribution { count: number }
    const contributions = new Map<string, ChannelContribution>()
    const latestByUser = new Map<string, number>()
    const respondedChannelIds = new Set<string>()
    let unreadChanged = false
    const lastMessages = await getRoomLastMessages([...serverIds])
    debug('[pocket-unread] lastMsgList 回包', lastMessages.length, '条：', JSON.stringify(lastMessages))
    for (const item of lastMessages) {
      respondedChannelIds.add(item.channelId)
      const userId = channelOwner.get(item.channelId)
      if (!userId) {
        // 回包里的频道不在归属表（缓存缺失/已取关竞态）：记下来方便对线
        debug('[pocket-unread] 回包频道无法归属，跳过', item.channelId)
        continue
      }
      if ((item.msgTime || 0) > (latestByUser.get(userId) ?? 0))
        latestByUser.set(userId, item.msgTime || 0)
      const msgKey = item.msgKey || `${item.msgTime}:${item.msgContent}`

      if (item.unreadCount !== null) {
        // ===== 精确模式：服务端给了该频道真实未读数（pa 动态签名生效）=====
        const baseline = data.baselines[item.channelId]
        let delta: number
        if (baseline === undefined) {
          // 首见锚定：以当下服务端计数为基线，历史不算未读
          debug('[pocket-unread] 首见频道，锚定基线', item.channelId, '=', item.unreadCount)
          delta = 0
        }
        else {
          delta = Math.max(0, item.unreadCount - baseline)
          if (item.unreadCount < baseline)
            debug('[pocket-unread] 服务端未读回落（已在别处读过），对齐基线', item.channelId, baseline, '->', item.unreadCount)
          else if (delta > 0)
            debug('[pocket-unread] 新消息计未读（精确）', userId, ':', item.unreadCount, '-', baseline, '=', delta)
        }
        if (baseline !== item.unreadCount) {
          data.baselines[item.channelId] = item.unreadCount
          dirty = true
        }
        // 身份锚与降级计数同步维护：pa 失效降级时锚是新的，无缝切粗算不误跳
        if (data.seenKeys[item.channelId] !== msgKey) {
          data.seenKeys[item.channelId] = msgKey
          dirty = true
        }
        if ((data.fallbackUnread[item.channelId] ?? 0) !== 0) {
          data.fallbackUnread[item.channelId] = 0
          dirty = true
        }
        contributions.set(item.channelId, { count: delta })
      }
      else {
        // ===== 降级模式：回包只有最新一条，身份键变化粗算 +1 =====
        const seenKey = data.seenKeys[item.channelId]
        if (seenKey === undefined) {
          // 首次见到该频道（或 markRead 刚清掉回执键）：锚定当前最新消息，历史不算未读
          debug('[pocket-unread] 首见频道，锚定回执键', item.channelId, '=', msgKey.slice(0, 40))
          data.seenKeys[item.channelId] = msgKey
          dirty = true
        }
        else if (msgKey !== seenKey) {
          debug('[pocket-unread] 新消息计未读（降级粗算）', userId, ': key', msgKey.slice(0, 40), '≠ 已计', seenKey.slice(0, 40))
          data.fallbackUnread[item.channelId] = (data.fallbackUnread[item.channelId] ?? 0) + 1
          data.seenKeys[item.channelId] = msgKey
          dirty = true
        }
        contributions.set(item.channelId, { count: data.fallbackUnread[item.channelId] ?? 0 })
      }
    }

    // 回包缺席的频道沿用上一轮计数：偶发缺条不把未读清零
    for (const channelId of channelOwner.keys()) {
      if (!respondedChannelIds.has(channelId))
        contributions.set(channelId, { count: data.fallbackUnread[channelId] ?? 0 })
    }

    // 聚合到成员（大房间 + 小房间都记在成员头上）并与旧快照比对
    const aggregated: Record<string, UnreadRoomState> = {}
    for (const [channelId, contribution] of contributions) {
      if (contribution.count <= 0)
        continue
      const ownerId = channelOwner.get(channelId)
      if (!ownerId)
        continue
      const entry = aggregated[ownerId] ?? { count: 0, latestTime: 0 }
      entry.count += contribution.count
      entry.latestTime = Math.max(entry.latestTime, latestByUser.get(ownerId) ?? 0)
      aggregated[ownerId] = entry
    }
    const previous = data.unread
    const nextIds = Object.keys(aggregated)
    const changed = Object.keys(previous).length !== nextIds.length
      || nextIds.some((id) => {
        const before = previous[id]
        const after = aggregated[id]
        return !before || before.count !== after.count || before.latestTime !== after.latestTime
      })
    if (changed) {
      data.unread = aggregated
      unreadChanged = true
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
 * 标记房间已读：未读清零并广播，随后把该成员全部频道的基线对齐到「此刻」。
 *
 * 不接收渲染层的消息键——渲染层消息 id 与检测键（lastMsgList 空间）不同空间，
 * 混写回执键会让已读房间在下一轮被误判成有新消息而「复活」（踩过）。
 * 对齐方式：即时拉一轮该成员所在 server 的批量预览（此刻用户刚读到消息流底部，
 * 服务端计数里含着的正是刚看完的这些消息），把 unreadCount 基线 / 身份锚钉到当下——
 * 下一轮检测的差值就是真正的「读了之后又来的新消息」。
 * 对齐请求失败不回滚：下一轮检测兜底重锚，最多多算一轮。
 */
export async function markRead(userId: number): Promise<void> {
  const data = store()
  const key = String(userId)
  const entry = data.unread[key]
  debug('[pocket-unread] markRead', key, '未读条数:', entry?.count ?? 0)
  // 没有未读就无事可做：基线/锚已在位（首见即锚定），不产生落盘与广播
  if (!entry)
    return
  delete data.unread[key]
  persist()
  publish()

  const memberChannels = [data.channels[key], data.smallChannels[key]]
    .filter((channel): channel is StoredChannel => !!channel?.channelId)
  const serverIds = [...new Set(memberChannels.map(channel => channel.serverId))]
  if (!serverIds.length)
    return
  try {
    const channelIds = new Set(memberChannels.map(channel => channel.channelId))
    for (const item of await getRoomLastMessages(serverIds)) {
      if (!channelIds.has(item.channelId))
        continue
      const msgKey = item.msgKey || `${item.msgTime}:${item.msgContent}`
      if (item.unreadCount !== null)
        data.baselines[item.channelId] = item.unreadCount
      data.fallbackUnread[item.channelId] = 0
      data.seenKeys[item.channelId] = msgKey
    }
    persist()
    debug('[pocket-unread] 已读基线对齐完成', key, '频道:', [...channelIds].join(','))
  }
  catch (error) {
    debug('[pocket-unread] 已读基线对齐失败（下一轮检测兜底）', error)
  }
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
