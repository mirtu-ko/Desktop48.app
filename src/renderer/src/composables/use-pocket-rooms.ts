import type { LiveListItem } from '@renderer/services/api-types'
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
/**
 * 口袋「房间」页编排层：左侧关注成员房间列表 + 右侧房间消息流。
 *
 * 数据来源（与参考实现 yk1z/yaya_msg 同思路，落地在 desktop48 既有管道上）：
 * - 关注名单：口袋账号关注 ID（friendships/friends/id，只给 ID）∪ 本地关注名单，
 *   成员详情（头像/昵称/队伍）由本地成员目录反查——接口本身不返回这些；
 * - 房间频道：im/server/jump（starId=成员 userId）解析出 team server + channel，
 *   即口袋 App「房间」tab 里该成员的留言频道。解析不出频道 = 成员没有房间
 *   （含房间已关闭/被回收：同样解析不出频道，一并过滤，进不了列表）；
 * - 房间预览：im/team/classic/last/message/get 批量拉各频道最后一条消息（一次请求）；
 * - 房间消息：im/team/message/list/{homeowner,all} HTTP 拉取（msgTime 倒序，nextTime 游标翻历史），
 *   对应「只看成员 / 全部消息」两档范围；homeowner 会混入官方系统账号，已过滤。
 *   参考实现的实时推送走 QChat 长连接（另一套 NIM 协议），本版本以轮询替代，
 *   覆盖「查看房间消息」场景——注意与浮窗播放器的直播间弹幕是两套体系。
 *
 * 失败一律静默降级：频道解析/消息拉取失败只影响右侧消息区，左侧列表照常可用；
 * 唯一例外是 token 失效（重新登录才能恢复），直接上抛让整页报错。
 */
import type { PocketRoomChannel, PocketRoomLastMessage } from '../../../preload/ipc-contract'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useLiveStatusStore } from '@renderer/stores/live-status'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'

import { liveShareTitle, normalizePocketRoomMessage, normalizePocketRoomPreview } from '@renderer/utils/pocket-room-message'
import Tools from '@renderer/utils/tools'
import { useIntervalFn } from '@vueuse/core'
import { computed, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'

/** 左侧房间条目 */
export interface PocketRoom {
  userId: number
  nickname: string
  avatar: string
  teamName: string
  teamColor: string
  /** 房间频道（加载时遍历解析，选中/轮询直接用） */
  serverId: string
  channelId: string
  /** 左列预览：频道最新一条消息文案；空串 = 暂无消息 */
  preview: string
  /** 预览对应消息时刻：防止批量预览的旧快照覆盖更新的本地预览 */
  previewTime: number
  /** 匹配到的在直播；null = 未开播（房间留言流与直播与否无关，仍可查看） */
  live: LiveListItem | null
}

/** 右侧消息区状态 */
export type PocketRoomChatStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 房间新消息轮询间隔：参考实现通知轮询 2s，这里取 5s 平衡实时性与接口压力 */
const MESSAGE_POLL_MS = 5_000
/** 房间频道/状态遍历的并发上限：关注几十人时不打爆接口，也不至于让首灌等太久 */
const ROOM_RESOLVE_CONCURRENCY = 5
/** 口袋官方系统账号：homeowner（只看成员）接口会混入其发言，需过滤（参考实现 yaya_msg 同款） */
const OFFICIAL_USER_ID = '121569667'

/** 右侧消息范围：member = 只看成员发言（homeowner 接口），all = 全部用户发言（all 接口） */
export type PocketRoomMessageScope = 'member' | 'all'

/** token 失效不属于「房间不可用」：上抛让整页报错，引导重新登录 */
function isAuthExpired(error: unknown): boolean {
  return error instanceof Error && error.message.includes('登录已过期')
}

/** 有界并发映射：最多 limit 个在途，结果保序；任一任务抛错即整体拒绝 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export function usePocketRooms() {
  const { refreshFollowedMembers, followedMembers } = useFollowedMembersStore()
  const { findMemberByUserId } = useMemberDirectoryStore()
  const {
    liveByUserId,
    liveIdSet,
    refreshLiveStatus,
    ensureLiveStatusFresh,
    acquireLiveStatusPolling,
  } = useLiveStatusStore()

  const rooms = ref<PocketRoom[]>([])
  /** 页面是否处于 keep-alive 激活态：共享直播轮询只在可见房间页运行 */
  const pageActive = ref(false)
  /** 当前页持有的共享直播轮询释放函数 */
  let releaseLiveStatusPolling: (() => void) | null = null
  /** 首灌（关注 + 直播）中 */
  const loading = ref(false)
  /** 直播状态轮询中 */
  const liveRefreshing = ref(false)
  /** 首灌失败原因；空串 = 无失败 */
  const loadError = ref('')
  /** 口袋关注拉取失败原因（降级为本地名单时给一行提示）；空串 = 无 */
  const pocketFollowError = ref('')
  /** 被过滤掉的房间数（无房间 / 已关闭）；左列给一行说明，避免「关注了却看不到」的困惑 */
  const hiddenRoomCount = ref(0)
  /** 是否已登录（登录态镜像；未登录时页面展示登录引导） */
  const loggedIn = computed(() => pocketAuthState.value.loggedIn)

  const selectedUserId = ref<number | null>(null)
  const messages = ref<PocketRoomMessageView[]>([])
  const chatStatus = ref<PocketRoomChatStatus>('idle')
  const chatStatusText = ref('')
  /** 更早历史是否已到头（加载更多按钮的禁用态） */
  const historyExhausted = ref(false)
  /** 加载更多中（按钮 loading 态） */
  const loadingMore = ref(false)

  /** 当前房间的频道（轮询/加载更多用）；null = 未选中或解析失败 */
  let activeChannel: { serverId: string, channelId: string } | null = null
  /** 已加载消息的去重键集合：轮增量与翻历史共用，防重复插入 */
  let messageKeys = new Set<string>()
  /** 更早历史游标；0 = 没有更多 */
  let historyCursor = 0
  /** 消息范围（见 PocketRoomMessageScope）；切换时重拉当前房间 */
  const messageScope = ref<PocketRoomMessageScope>('member')

  /** userId → 频道缓存：加载时遍历解析即写入，选中/切回不重复解析 */
  const channelCache = new Map<number, { serverId: string, channelId: string }>()
  /** 首灌请求序号：丢弃过期回包，避免快速刷新时数据错乱 */
  let loadRequestId = 0
  /** 选中请求序号：切人/卸载后丢弃在途解析与拉取回包，防消息串房 */
  let selectRequestId = 0

  /** 选中中的房间；null = 未选中或已不在列表 */
  const selectedRoom = computed<PocketRoom | null>(
    () => rooms.value.find(room => room.userId === selectedUserId.value) ?? null,
  )

  /** 口袋关注 ID；失败返回空数组并由调用方降级（不抛错） */
  async function loadPocketFollowedIds(): Promise<number[]> {
    try {
      return await window.mainAPI.pocketGetFollowedIds()
    }
    catch (error) {
      pocketFollowError.value = error instanceof Error ? error.message : String(error)
      debugLog('pocket-rooms', '口袋关注拉取失败，降级为本地名单', error)
      return []
    }
  }

  /** 口袋关注 ID ∪ 本地关注 ID（本地含桌面端手动关注与历史合并结果） */
  async function loadFollowedIds(): Promise<number[]> {
    // 首灌走 refresh 而非 ensureLoaded：store 是模块级单例，ensureLoaded 命中后
    // 不再重拉，页面首灌要的是「此刻」的名单（设置页/成员页改过关注后开页即生效）
    const [pocketIds, localEntries] = await Promise.all([
      loadPocketFollowedIds(),
      refreshFollowedMembers().then(() => followedMembers.value),
    ])
    const ids = new Set<number>()
    for (const id of [...pocketIds, ...localEntries.map(entry => entry.userId)]) {
      const userId = Tools.normalizeUserId(id)
      if (Number.isFinite(userId) && userId > 0)
        ids.add(userId)
    }
    return [...ids]
  }

  /** 共享 store 的全站直播索引；force=true 用于手动刷新并绕过 120s 新鲜缓存。 */
  async function fetchLiveMap(force = false): Promise<Map<number, LiveListItem>> {
    await (force ? refreshLiveStatus(true) : ensureLiveStatusFresh())
    return liveByUserId.value
  }

  /** 在直播的排前面，其余按昵称排序——「谁的房间开着」是第一眼信息 */
  function sortRooms(list: PocketRoom[]) {
    list.sort((a, b) =>
      Number(!!b.live) - Number(!!a.live) || a.nickname.localeCompare(b.nickname, 'zh'),
    )
  }

  // 共享 store 更新后同步到当前房间列表；页面不再自己持有直播轮询定时器。
  watch(liveByUserId, (liveMap) => {
    if (!rooms.value.length)
      return
    for (const room of rooms.value)
      room.live = liveMap.get(room.userId) ?? null
    sortRooms(rooms.value)
  }, { immediate: true })

  /** 批量最新消息 → channelId → 消息；失败返回空 Map（预览静默降级，不影响房间可用） */
  async function fetchLastMessageMap(serverIds: string[]): Promise<Map<string, PocketRoomLastMessage>> {
    const map = new Map<string, PocketRoomLastMessage>()
    if (!serverIds.length)
      return map
    try {
      for (const item of await window.mainAPI.pocketGetRoomLastMessages(serverIds)) {
        if (item.channelId)
          map.set(item.channelId, item)
      }
    }
    catch (error) {
      debugLog('pocket-rooms', '房间最新消息拉取失败（无预览降级）', error)
    }
    return map
  }

  /**
   * 遍历解析全部关注成员的房间频道。
   * - 解析失败/为空：成员没有房间（含房间已关闭）→ 过滤；
   * - token 失效：上抛，整页报错。
   * 返回可用房间与「解析异常」计数——全部异常时（接口故障而非真的都没房间）由调用方整页报错。
   *
   * 注：im/team/room/info 的 channelStatus 语义不明（实测正常房间也非 0），
   * 不能作关闭判据；关闭的房间在 jump 阶段就解析不出频道，已在此过滤。
   */
  async function resolveRooms(entries: PocketRoom[]): Promise<{
    resolved: Array<{ entry: PocketRoom, channel: PocketRoomChannel }>
    resolveErrorCount: number
    firstResolveError: unknown
  }> {
    let resolveErrorCount = 0
    let firstResolveError: unknown = null

    const withChannel = await mapWithConcurrency(entries, ROOM_RESOLVE_CONCURRENCY, async (entry) => {
      let channel: PocketRoomChannel
      try {
        channel = await window.mainAPI.pocketGetRoomChannel(entry.userId)
      }
      catch (error) {
        if (isAuthExpired(error))
          throw error
        resolveErrorCount++
        if (!firstResolveError)
          firstResolveError = error
        debugLog('pocket-rooms', `房间频道解析失败（${entry.nickname}），按无房间过滤`, error)
        return null
      }
      if (!channel?.serverId || !channel?.channelId)
        return null
      return { entry, channel }
    })

    const resolved: Array<{ entry: PocketRoom, channel: PocketRoomChannel }> = []
    for (const item of withChannel) {
      if (!item)
        continue
      channelCache.set(item.entry.userId, item.channel)
      resolved.push(item)
    }
    return { resolved, resolveErrorCount, firstResolveError }
  }

  /** 首灌：关注名单 + 成员详情 + 直播匹配 + 房间遍历（过滤无房间）+ 最新消息预览 */
  async function load() {
    const requestId = ++loadRequestId
    loading.value = true
    loadError.value = ''
    pocketFollowError.value = ''
    hiddenRoomCount.value = 0
    try {
      // 必须等登录态落库：ensurePocketAuthState 是「同步返回旧值 + 异步刷新」，
      // 冷启动首帧会误判未登录；这里是页面级首灌，等得起一次本地读
      await refreshPocketAuthState()
      if (requestId !== loadRequestId)
        return
      if (!pocketAuthState.value.loggedIn) {
        rooms.value = []
        selectedUserId.value = null
        clearChat()
        return
      }
      const ids = await loadFollowedIds()
      if (requestId !== loadRequestId)
        return
      const liveMap = await fetchLiveMap(true)
      if (requestId !== loadRequestId)
        return

      const entries: PocketRoom[] = await Promise.all(ids.map(async (userId): Promise<PocketRoom> => {
        const live = liveMap.get(userId) ?? null
        const member = await findMemberByUserId(userId)
        return {
          userId,
          nickname: member?.realName || member?.nickname || live?.userInfo?.nickname || `口袋用户 ${userId}`,
          avatar: member?.avatar || '',
          teamName: member?.teamName || '',
          teamColor: member?.teamColor || '',
          serverId: '',
          channelId: '',
          preview: '',
          previewTime: 0,
          live,
        }
      }))
      if (requestId !== loadRequestId)
        return

      // 遍历解析房间：无房间（含已关闭）的成员直接过滤，不进列表
      const { resolved, resolveErrorCount, firstResolveError } = await resolveRooms(entries)
      if (requestId !== loadRequestId)
        return
      if (!resolved.length && entries.length && resolveErrorCount === entries.length) {
        // 全部解析异常 = 接口故障，不是「真的都没房间」：报错重试而不是展示空列表
        throw firstResolveError instanceof Error ? firstResolveError : new Error('房间频道解析失败')
      }
      hiddenRoomCount.value = entries.length - resolved.length

      // 左列预览：一次批量请求拿全部频道最新一条消息（失败无预览，不阻断）
      const lastMessageMap = await fetchLastMessageMap(resolved.map(item => item.channel.serverId))
      if (requestId !== loadRequestId)
        return
      const nextRooms = resolved.map(({ entry, channel }) => {
        entry.serverId = channel.serverId
        entry.channelId = channel.channelId
        const last = lastMessageMap.get(channel.channelId)
        if (last?.msgContent) {
          entry.preview = normalizePocketRoomPreview(last.msgContent)
          entry.previewTime = last.msgTime
        }
        return entry
      })

      sortRooms(nextRooms)
      rooms.value = nextRooms
      // 选中项已不在列表（取关/刷新/房间被过滤）时清空右侧；仍在则保持选中（消息流不动）
      const stillSelected = rooms.value.some(room => room.userId === selectedUserId.value)
      if (!stillSelected && selectedUserId.value !== null) {
        selectedUserId.value = null
        clearChat()
      }
    }
    catch (error) {
      if (requestId === loadRequestId)
        loadError.value = error instanceof Error ? error.message : String(error)
      debugLog('pocket-rooms', '房间列表加载失败', error)
    }
    finally {
      if (requestId === loadRequestId)
        loading.value = false
    }
  }

  /**
   * 刷新直播状态 + 左列最新消息预览，不重建列表（保留选中与消息流）。
   * force=false 供重新进入页面复用 120s 新鲜缓存；手动刷新传 true。
   */
  async function refreshRoomStatus(force = true) {
    if (!pocketAuthState.value.loggedIn || !rooms.value.length)
      return
    liveRefreshing.value = true
    try {
      const liveMap = await fetchLiveMap(force)
      const lastMessageMap = await fetchLastMessageMap(rooms.value.map(room => room.serverId))
      for (const room of rooms.value) {
        room.live = liveMap.get(room.userId) ?? null
        const last = lastMessageMap.get(room.channelId)
        // 只接受不比当前预览旧快照：轮询增量可能比批量预览更新
        if (last && last.msgTime >= room.previewTime) {
          room.preview = normalizePocketRoomPreview(last.msgContent)
          room.previewTime = last.msgTime
        }
      }
      sortRooms(rooms.value)
    }
    catch (error) {
      debugLog('pocket-rooms', '房间状态刷新失败', error)
    }
    finally {
      liveRefreshing.value = false
    }
  }

  /** 清空右侧消息区（轮询目标、游标、去重键一并复位） */
  function clearChat() {
    selectRequestId++
    activeChannel = null
    messageKeys = new Set()
    historyCursor = 0
    messages.value = []
    historyExhausted.value = false
    chatStatus.value = 'idle'
    chatStatusText.value = ''
  }

  /**
   * 把归一后的消息并入消息流。
   * mode=replace：首屏（接口倒序返回，翻转成时间升序）；
   * mode=prepend：翻更早历史（保持升序插到头部）；
   * mode=append：轮询增量（只收没见过的，排序后追加）。
   */
  function mergeMessages(incoming: PocketRoomMessageView[], mode: 'replace' | 'prepend' | 'append') {
    const fresh = incoming.filter(item => !messageKeys.has(item.id))
    for (const item of fresh)
      messageKeys.add(item.id)
    if (!fresh.length)
      return
    if (mode === 'replace') {
      // 接口按 msgTime 倒序（最新在前），聊天流是最新在下，翻转
      messages.value = fresh.slice().sort((a, b) => a.msgTime - b.msgTime)
    }
    else if (mode === 'prepend') {
      messages.value = [...fresh.sort((a, b) => a.msgTime - b.msgTime), ...messages.value]
    }
    else {
      messages.value = [...messages.value, ...fresh.sort((a, b) => a.msgTime - b.msgTime)]
      // 选中房间的左列预览同步到最新一条（批量预览接口有延迟，本地即时补）
      const selected = rooms.value.find(room => room.userId === selectedUserId.value)
      const newest = fresh.reduce((a, b) => (a.msgTime >= b.msgTime ? a : b))
      if (selected && newest.msgTime >= selected.previewTime) {
        selected.preview = newest.text
        selected.previewTime = newest.msgTime
      }
    }
  }

  /** 拉取并归一一页房间消息；mode 见 mergeMessages */
  async function fetchRoomPage(
    channel: { serverId: string, channelId: string },
    nextTime: number,
    mode: 'replace' | 'prepend' | 'append',
  ): Promise<void> {
    const scope = messageScope.value
    const result = await window.mainAPI.pocketGetRoomMessages(channel.channelId, channel.serverId, nextTime, scope)
    const views = result.messages
      .map(normalizePocketRoomMessage)
      .filter((item): item is PocketRoomMessageView => item !== null)
    // 只看成员时剔掉混入的官方系统账号发言（接口侧不区分）
    mergeMessages(
      scope === 'member' ? views.filter(item => item.userId !== OFFICIAL_USER_ID) : views,
      mode,
    )
    historyCursor = result.nextTime
    // 是否还有更早历史只认 nextTime：本页条数不满 limit 不代表到头（服务端分页策略不透明）
    if (!result.nextTime)
      historyExhausted.value = true
  }

  // 房间新消息轮询：仅选中房间就绪后由 selectRoom 启动，暂停/恢复随页面激活态。
  // 定义须早于 selectRoom（其成功路径调 resumeMessagePoll）；回调引用的
  // pollRoomMessages 是函数声明，提升后可用
  const { pause: pauseMessagePoll, resume: resumeMessagePoll } = useIntervalFn(
    () => void pollRoomMessages(),
    MESSAGE_POLL_MS,
    { immediate: false },
  )

  /**
   * 选中房间：取缓存频道 → 拉最近一页消息 → 启动轮询。
   * 频道在首灌时已遍历解析并缓存；缓存未命中（关注后有新增）才懒解析。
   * 选中态在 await 期间可能已被切换/清空，回包后必须复核，否则消息会串房。
   * 房间留言流与直播与否无关：未开播的成员同样有房间消息。
   */
  async function selectRoom(userId: number | null) {
    // 同房且已就绪：no-op（保留消息流与轮询）
    if (userId === selectedUserId.value && chatStatus.value === 'ready')
      return
    clearChat()
    selectedUserId.value = userId
    if (userId === null)
      return

    const requestId = selectRequestId
    chatStatus.value = 'loading'
    chatStatusText.value = ''

    let channel = channelCache.get(userId) ?? null
    if (!channel) {
      try {
        channel = await window.mainAPI.pocketGetRoomChannel(userId)
      }
      catch (error) {
        if (requestId === selectRequestId) {
          chatStatus.value = 'error'
          chatStatusText.value = error instanceof Error ? error.message : String(error)
        }
        return
      }
      if (requestId !== selectRequestId)
        return
      if (!channel?.serverId || !channel?.channelId) {
        chatStatus.value = 'error'
        chatStatusText.value = '未解析到该成员的房间频道'
        return
      }
      channelCache.set(userId, channel)
    }

    activeChannel = channel
    try {
      await fetchRoomPage(channel, 0, 'replace')
    }
    catch (error) {
      if (requestId === selectRequestId) {
        chatStatus.value = 'error'
        chatStatusText.value = error instanceof Error ? error.message : String(error)
      }
      return
    }
    if (requestId !== selectRequestId)
      return
    chatStatus.value = 'ready'
    chatStatusText.value = ''
    resumeMessagePoll()
  }

  /** 加载更早历史（prepend 到消息流头部） */
  async function loadMoreHistory() {
    if (!activeChannel || loadingMore.value || historyExhausted.value)
      return
    loadingMore.value = true
    try {
      await fetchRoomPage(activeChannel, historyCursor, 'prepend')
    }
    catch (error) {
      chatStatusText.value = error instanceof Error ? error.message : String(error)
      debugLog('pocket-rooms', '房间历史加载失败', error)
    }
    finally {
      loadingMore.value = false
    }
  }

  /** 轮询用：拉最新一页，只追加新消息（无新消息零开销） */
  async function pollRoomMessages() {
    if (!activeChannel || chatStatus.value !== 'ready')
      return
    try {
      await fetchRoomPage(activeChannel, 0, 'append')
    }
    catch (error) {
      debugLog('pocket-rooms', '房间新消息轮询失败', error)
    }
  }

  /**
   * 分享消息指向的直播是否在播：true = 在播，false = 不在播（按回放处理），null = 直播列表还没拉过。
   * 数据来自共享 live-status store：120s 轮询 / 页面恢复 / 手动刷新都会更新。
   */
  function isSharedLiveOnAir(liveId: string): boolean | null {
    if (!liveId || liveIdSet.value === null)
      return null
    return liveIdSet.value.has(liveId)
  }

  /**
   * 打开直播分享卡对应的独立播放窗（房间页唯一的开播入口）。
   * 分享消息可能指向实时直播，也可能指向录播/回放；liveType/开播时间缺失时按
   * 「视频 + 现在」降级：不能把 0 传下去——播放器的「已播时长」会显示成 1970 起算的时长。
   *
   * 直播/回放选路对齐参考实现 yaya_msg：消息本身不带可靠标记，以当前直播列表为准——
   * liveId 在播 → 直播窗；不在播（或消息显式标记回放）→ 回放窗。
   */
  function openSharedLive(message: PocketRoomMessageView) {
    if (!message.liveId)
      return
    const { openLive, openPlayback } = useFloatPlayersStore()
    const payload = {
      liveId: message.liveId,
      nickname: message.nick,
      title: liveShareTitle(message.text) || '直播分享',
      startTime: message.liveStartTime || Date.now(),
      liveType: message.liveType || 1,
    }
    if (message.liveIsPlayback || isSharedLiveOnAir(message.liveId) !== true)
      openPlayback(payload)
    else
      openLive(payload)
  }

  /** 可见且房间已加载时订阅共享直播轮询；最后一个消费者释放后 store 自动停表。 */
  function syncLiveStatusPolling(): void {
    const shouldPoll = pageActive.value && pocketAuthState.value.loggedIn && rooms.value.length > 0
    if (shouldPoll && !releaseLiveStatusPolling) {
      releaseLiveStatusPolling = acquireLiveStatusPolling()
    }
    else if (!shouldPoll && releaseLiveStatusPolling) {
      releaseLiveStatusPolling()
      releaseLiveStatusPolling = null
    }
  }

  watch([pageActive, loggedIn, () => rooms.value.length], syncLiveStatusPolling, { immediate: true })

  // onActivated/onDeactivated 仅在组件 setup 中有效：裸 effectScope（单测）直驱时跳过
  if (getCurrentInstance()) {
    onActivated(() => {
      pageActive.value = true
      if (pocketAuthState.value.loggedIn && rooms.value.length)
        void refreshRoomStatus(false)
      if (activeChannel)
        void pollRoomMessages()
      resumeMessagePoll()
    })
    onDeactivated(() => {
      pageActive.value = false
      pauseMessagePoll()
    })
  }

  // 登录态变化（在设置页登录/退出后回到本页）：重新首灌
  watch(loggedIn, () => void load())

  // 切换消息范围：重拉当前房间（去重键/游标随 clearChat 复位；未选中时切了也无需动作）
  watch(messageScope, () => {
    if (selectedUserId.value !== null) {
      clearChat()
      void selectRoom(selectedUserId.value)
    }
  })

  // 卸载/作用域销毁：停轮询（消息区状态随页面销毁自然废弃）
  onScopeDispose(() => {
    loadRequestId++
    selectRequestId++
    pageActive.value = false
    releaseLiveStatusPolling?.()
    releaseLiveStatusPolling = null
    pauseMessagePoll()
  })

  return {
    rooms,
    loading,
    liveRefreshing,
    loadError,
    pocketFollowError,
    hiddenRoomCount,
    loggedIn,
    selectedUserId,
    selectedRoom,
    messages,
    messageScope,
    chatStatus,
    chatStatusText,
    historyExhausted,
    loadingMore,
    load,
    refresh: load,
    refreshRoomStatus,
    selectRoom,

    loadMoreHistory,
    openSharedLive,
    isSharedLiveOnAir,
  }
}
