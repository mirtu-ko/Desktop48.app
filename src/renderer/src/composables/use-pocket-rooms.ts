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
 *   对应「只看房主 / 全部消息」两档范围；homeowner 会混入官方系统账号，已过滤。
 *   参考实现的实时推送走 QChat 长连接（另一套 NIM 协议），本版本以轮询替代，
 *   覆盖「查看房间消息」场景——注意与浮窗播放器的直播间弹幕是两套体系。
 *
 * 失败一律静默降级：频道解析/消息拉取失败只影响右侧消息区，左侧列表照常可用；
 * 唯一例外是 token 失效（重新登录才能恢复），直接上抛让整页报错。
 */
import type { PocketRoomChannel, PocketRoomLastMessage, PocketRoomQuestion } from '@preload/ipc-contract'
import type { LiveListItem } from '@renderer/services/api-types'
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { OFFICIAL_POCKET_USER_ID } from '@common/pocket-rooms'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useLiveStatusStore } from '@renderer/stores/live-status'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'

import { liveShareTitle, normalizePocketRoomMessage, normalizePocketRoomPreview } from '@renderer/utils/pocket-room-message'
import Tools from '@renderer/utils/tools'
import { useIntervalFn } from '@vueuse/core'
import { computed, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, reactive, ref, watch } from 'vue'

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
  /**
   * 预览对应消息时刻（0 = 未知）。批量预览接口不回该字段，实际只用于选中房间轮询的单调比较；
   * 跨来源（批量 / 轮询）的先后由 refreshRoomPreviews 按来源划分所有权，不靠这个值。
   */
  previewTime: number
  /** 匹配到的在直播；null = 未开播（房间留言流与直播与否无关，仍可查看） */
  live: LiveListItem | null
}

/** 右侧消息区状态 */
export type PocketRoomChatStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 房间新消息轮询间隔：参考实现通知轮询 2s，这里取 5s 平衡实时性与接口压力 */
const MESSAGE_POLL_MS = 5_000
/**
 * 左列预览刷新间隔：一次请求覆盖全部房间，与主进程未读检测（60s）同频，
 * 让「预览文案」和「未读角标」同一节奏到位。
 *
 * 这条轮询是补回来的：本页原先只有一个 60s 定时器跑 `refreshRoomStatus`
 * （直播状态 + 预览一起刷），抽出全站直播 store 时只把「直播」那半边改接共享轮询，
 * 「预览」半边再没有定时器 —— 于是未读角标照常增长，左列文案却只在
 * 重进页面（onActivated）或手动刷新（load）时才变。
 * 只驱动预览、不再建第二个直播轮询：共享 store 已覆盖直播状态，重复建会翻倍直播接口流量。
 */
const ROOM_PREVIEW_POLL_MS = 60_000
/** 房间频道/状态遍历的并发上限：关注几十人时不打爆接口，也不至于让首灌等太久 */
const ROOM_RESOLVE_CONCURRENCY = 5

/** 右侧消息范围：member = 只看房主发言（homeowner 接口），all = 全部用户发言（all 接口） */
export type PocketRoomMessageScope = 'member' | 'all'

/** 右侧消息视图：room = 大房间留言流（默认），small = 小房间（暗号频道问答流） */
export type PocketRoomViewMode = 'room' | 'small'

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
  /** 大房间 / 小房间视图（见 PocketRoomViewMode）；切换时换频道重拉 */
  const viewMode = ref<PocketRoomViewMode>('room')
  /** 选中成员的小房间频道；null = 未发现（主进程归属自愈只认 lastMsgList 回包里出现过的频道） */
  const smallChannel = ref<{ serverId: string, channelId: string } | null>(null)
  /** userId → 小房间频道缓存（null 也缓存：查过但未发现，不重复打接口） */
  const smallChannelCache = new Map<number, { serverId: string, channelId: string } | null>()
  /**
   * 频道名表（tab 显示真实频道名）：连同所属 serverId 一起存，
   * 读取时校验归属——否则切成员后旧 server 的表会顶出新名字。
   */
  const channelNames = ref<{ serverId: string, map: Map<string, string> }>({ serverId: '', map: new Map() })
  /** serverId → 频道名表缓存（含空表：接口通了但没给名字，不重复打接口） */
  const serverChannelNameCache = new Map<string, Map<string, string>>()
  /**
   * 本次会话内已通过暗号的小房间（channelId 为键）；解锁状态只存客户端内存，
   * 重启后重新校验一次。
   *
   * 必须是 reactive 而非裸 Set：`smallRequiresAnswer` 是 computed，靠 `.has()` 收集依赖，
   * 裸 Set 的增删不触发重算——解锁后页签上的锁与消息范围开关会一直停在锁定态
   * （消息区分支在模板里靠前，把锁定层盖住了，所以现象只露在页签的锁上）。
   */
  const unlockedSmallChannels = reactive(new Set<string>())
  /** 当前小房间的暗号问题（channelId → 问题缓存，含 null：room/info 未被拦，即无门禁） */
  const smallQuestion = ref<PocketRoomQuestion | null>(null)
  const smallQuestionLoading = ref(false)
  const smallQuestionCache = new Map<string, PocketRoomQuestion | null>()
  /**
   * 小房间是否需要暗号：已发现频道 + 确认被暗号拦下（拿到问题）+ 本次会话未解锁。
   * 刻意与当前视图解耦——页签上的锁要在大房间视图下同样可见，
   * 否则「需要暗号」这件事只在切过去之后才暴露。
   */
  const smallRequiresAnswer = computed(() =>
    !!smallChannel.value
    && smallQuestion.value !== null
    && !unlockedSmallChannels.has(smallChannel.value.channelId),
  )
  /** 暗号输入层是否展示：当前在小房间视图且该频道仍被暗号拦着 */
  const smallLocked = computed(() => viewMode.value === 'small' && smallRequiresAnswer.value)

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

  /** 大房间（选中成员主频道）的真实频道名；空串 = 未取到，由渲染层回退通用名 */
  const roomChannelName = computed(() => {
    const room = selectedRoom.value
    if (!room || channelNames.value.serverId !== room.serverId)
      return ''
    return channelNames.value.map.get(room.channelId) ?? ''
  })

  /** 小房间（暗号频道）的真实频道名；空串 = 未发现频道或未取到名称 */
  const smallChannelName = computed(() => {
    const small = smallChannel.value
    if (!small || channelNames.value.serverId !== small.serverId)
      return ''
    return channelNames.value.map.get(small.channelId) ?? ''
  })

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
   * 刷新左列预览文案（批量最新消息，一次请求覆盖全部房间；失败静默）。
   *
   * 预览的所有权按「来源」划分，不按时间戳比较 —— `lastMsgList` 实测拿不到真实 msgTime
   * （恒为 0，见 pa-sign.ts 的降级回包说明），时间守卫在这条链路上无从建立：
   * - 非选中房间：只由本函数维护，回包文案与本地不同即采纳；
   * - 选中房间：由 5s 消息轮询即时维护（见 mergeMessages 的 append 分支），本函数不覆盖
   *   —— 批量接口有延迟，回写会把用户正看着的房间的预览退回上一条。判定条件与
   *   mergeMessages 一致（仅 viewMode === 'room' 时轮询才写大房间预览），否则用户停在
   *   「小房间」视图时该房预览无人维护，会冻死。
   *
   * 回包若仍带真实 msgTime（pa 特征齐全时），退化为按时间单调：更旧的快照不采纳。
   */
  async function refreshRoomPreviews() {
    if (!pocketAuthState.value.loggedIn || !rooms.value.length)
      return
    const lastMessageMap = await fetchLastMessageMap(rooms.value.map(room => room.serverId))
    for (const room of rooms.value) {
      const last = lastMessageMap.get(room.channelId)
      if (!last)
        continue
      if (room.userId === selectedUserId.value && viewMode.value === 'room')
        continue
      if (last.msgTime > 0) {
        if (last.msgTime < room.previewTime)
          continue
        room.previewTime = last.msgTime
      }
      const nextPreview = normalizePocketRoomPreview(last.msgContent)
      if (nextPreview !== room.preview)
        room.preview = nextPreview
    }
  }

  /**
   * 刷新直播状态 + 左列最新消息预览，不重建列表（保留选中与消息流）。
   * force=false 供重新进入页面复用 120s 新鲜缓存；手动刷新传 true。
   * 预览部分复用 refreshRoomPreviews，与定时轮询走同一条口径。
   */
  async function refreshRoomStatus(force = true) {
    if (!pocketAuthState.value.loggedIn || !rooms.value.length)
      return
    liveRefreshing.value = true
    try {
      const liveMap = await fetchLiveMap(force)
      for (const room of rooms.value)
        room.live = liveMap.get(room.userId) ?? null
      await refreshRoomPreviews()
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
      // 选中房间的左列预览同步到最新一条（批量预览接口有延迟，本地即时补）；
      // 小房间视图的新消息不写大房间预览
      if (viewMode.value === 'room') {
        const selected = rooms.value.find(room => room.userId === selectedUserId.value)
        const newest = fresh.reduce((a, b) => (a.msgTime >= b.msgTime ? a : b))
        if (selected && newest.msgTime >= selected.previewTime) {
          selected.preview = newest.text
          selected.previewTime = newest.msgTime
        }
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
    // 只看房主时剔掉混入的官方系统账号发言（接口侧不区分）
    mergeMessages(
      scope === 'member' ? views.filter(item => item.userId !== OFFICIAL_POCKET_USER_ID) : views,
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
   * 取当前 server 的频道名表（页签显示真实频道名）。
   * 一次请求覆盖该 server 下全部频道（大房间与小房间同 server）；命中缓存不再打接口；
   * 失败静默——页签回退通用名，不影响消息链路。
   */
  async function ensureChannelNames(serverId: string): Promise<void> {
    if (!serverId)
      return
    const cached = serverChannelNameCache.get(serverId)
    if (cached) {
      channelNames.value = { serverId, map: cached }
      return
    }
    try {
      const list = await window.mainAPI.pocketGetServerChannels(serverId)
      const map = new Map(
        list.filter(item => item.channelName).map(item => [item.channelId, item.channelName]),
      )
      serverChannelNameCache.set(serverId, map)
      // 回包期间可能已切到别的成员，只认仍是当前房间的那个 server
      if (selectedRoom.value?.serverId === serverId)
        channelNames.value = { serverId, map }
    }
    catch (error) {
      debugLog('pocket-rooms', '频道名拉取失败（页签回退通用名）', error)
    }
  }

  /**
   * 发现选中成员的小房间频道（主进程归属自愈的结果）；null = 未发现，入口隐藏。
   * 频道就位后顺手取一次暗号问题：页签上的锁图标靠它判定「是否需要暗号」，
   * 不能等到切进小房间才拉，否则在大房间视图下永远看不到锁。
   */
  async function ensureSmallChannel(userId: number): Promise<void> {
    if (smallChannelCache.has(userId)) {
      if (selectedUserId.value === userId)
        smallChannel.value = smallChannelCache.get(userId) ?? null
    }
    else {
      try {
        const channel = await window.mainAPI.pocketGetSmallChannel(userId)
        smallChannelCache.set(userId, channel)
        if (selectedUserId.value === userId)
          smallChannel.value = channel
      }
      catch (error) {
        debugLog('pocket-rooms', '小房间频道查询失败（入口降级隐藏）', error)
      }
    }
    if (selectedUserId.value === userId && smallChannel.value)
      void ensureSmallQuestion()
  }

  /** 拉取当前小房间的暗号问题（channelId 缓存；null = room/info 未被拦，即无门禁） */
  async function ensureSmallQuestion(): Promise<void> {
    const channel = smallChannel.value
    if (!channel || smallQuestionCache.has(channel.channelId)) {
      smallQuestion.value = smallQuestionCache.get(channel?.channelId ?? '') ?? null
      return
    }
    smallQuestionLoading.value = true
    try {
      const question = await window.mainAPI.pocketGetRoomQuestion(channel.channelId)
      smallQuestionCache.set(channel.channelId, question)
      if (selectedUserId.value !== null && smallChannel.value?.channelId === channel.channelId)
        smallQuestion.value = question
    }
    catch (error) {
      debugLog('pocket-rooms', '暗号问题拉取失败', error)
    }
    finally {
      smallQuestionLoading.value = false
    }
  }

  /**
   * 提交暗号：只有服务端校验通过才解锁并加载小房间消息。
   * 校验端点见 pocket-auth.checkRoomAnswer（`team/channel/question/answer/verify`）；
   * 万能密码由主进程客户端直通。服务端判错或接口不可达时如实返回失败，**不放行**。
   */
  async function unlockSmall(answer: string): Promise<{ ok: boolean, message?: string }> {
    const channel = smallChannel.value
    const userId = selectedUserId.value
    if (!channel || userId === null)
      return { ok: false, message: '未发现该成员的小房间频道' }
    try {
      const question = smallQuestion.value
      const result = await window.mainAPI.pocketCheckRoomAnswer(channel.channelId, question?.questionId ?? '', answer)
      if (!result.ok)
        return { ok: false, message: result.message || '暗号不正确' }
      unlockedSmallChannels.add(channel.channelId)
      clearChat()
      await openChannel(userId, channel)
      return { ok: true }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 在选中成员下打开指定频道（大房间或小房间）：首屏拉取 + 启动轮询 */
  async function openChannel(userId: number, channel: { serverId: string, channelId: string }) {
    const requestId = selectRequestId
    activeChannel = channel
    chatStatus.value = 'loading'
    chatStatusText.value = ''
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
    if (requestId !== selectRequestId || selectedUserId.value !== userId)
      return
    chatStatus.value = 'ready'
    chatStatusText.value = ''
    resumeMessagePoll()
  }

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
    // 视图随选中成员复位到大房间；小房间频道异步发现（不阻塞大房间首屏）
    viewMode.value = 'room'
    smallChannel.value = null
    smallQuestion.value = null
    if (userId === null)
      return
    void ensureSmallChannel(userId)

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

    // 频道名（页签显示真实名称）：与消息首屏并行，失败回退通用名
    void ensureChannelNames(channel.serverId)

    await openChannel(userId, channel)
  }

  /**
   * 按当前 `viewMode` 重开频道（调用方负责先 clearChat）。
   * 切视图与切消息范围共用这一条重开路径——范围变化只换拉取口径，不该改变看的是哪个频道。
   * 小房间频道缺失（自愈尚未发现）时退回大房间。
   */
  async function reopenActiveView() {
    const userId = selectedUserId.value
    if (userId === null)
      return
    const mode = viewMode.value
    if (mode === 'small' && smallChannel.value) {
      // 小房间锁定态：不拉消息，渲染层展示暗号输入层（解锁成功后 unlockSmall 里补拉）
      if (smallLocked.value) {
        void ensureSmallQuestion()
        return
      }
      await openChannel(userId, smallChannel.value)
      return
    }
    const channel = channelCache.get(userId) ?? null
    if (channel) {
      if (mode === 'small')
        viewMode.value = 'room'
      await openChannel(userId, channel)
      return
    }
    // 大房间频道缓存缺失：走完整选中流程补解析（会把视图复位到大房间，此处正确）
    viewMode.value = 'room'
    await selectRoom(userId)
  }

  /**
   * 切换大房间 / 小房间视图：换频道重拉当前成员的消息流（去重键/游标随 clearChat 复位）。
   * 轮询与翻历史走 activeChannel，自动跟随。
   */
  async function setViewMode(mode: PocketRoomViewMode) {
    if (viewMode.value === mode)
      return
    viewMode.value = mode
    if (selectedUserId.value === null)
      return
    clearChat()
    await reopenActiveView()
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

  /**
   * 左列预览轮询：补上被抽走的那条 60s 定时器（见 ROOM_PREVIEW_POLL_MS 注解）。
   * 只调 refreshRoomPreviews —— 不碰 liveRefreshing（否则刷新按钮每轮闪 loading），
   * 也不重复建直播轮询（共享 store 已覆盖直播状态）。
   */
  const {
    pause: pauseRoomPreviewPoll,
    resume: resumeRoomPreviewPoll,
    isActive: roomPreviewPolling,
  } = useIntervalFn(() => void refreshRoomPreviews(), ROOM_PREVIEW_POLL_MS, { immediate: false })

  /** 与共享直播轮询同一开关条件：页面可见 + 已登录 + 房间已加载 */
  function syncRoomPreviewPolling(): void {
    const shouldPoll = pageActive.value && pocketAuthState.value.loggedIn && rooms.value.length > 0
    if (shouldPoll && !roomPreviewPolling.value)
      resumeRoomPreviewPoll()
    else if (!shouldPoll && roomPreviewPolling.value)
      pauseRoomPreviewPoll()
  }

  // pageActive 由 onActivated / onDeactivated 维护，两个轮询共用这一份开关条件
  watch([pageActive, loggedIn, () => rooms.value.length], () => {
    syncLiveStatusPolling()
    syncRoomPreviewPolling()
  }, { immediate: true })

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

  // 切换消息范围：重拉**当前视图**的消息流（去重键/游标随 clearChat 复位；未选中时切了也无需动作）。
  // 必须走 reopenActiveView —— selectRoom 会把 viewMode 复位到大房间，
  // 在小房间里切范围会被弹回大房间（踩过）。
  watch(messageScope, () => {
    if (selectedUserId.value === null)
      return
    clearChat()
    void reopenActiveView()
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
    viewMode,
    smallChannel,
    roomChannelName,
    smallChannelName,
    smallRequiresAnswer,
    smallLocked,
    smallQuestion,
    smallQuestionLoading,
    chatStatus,
    chatStatusText,
    historyExhausted,
    loadingMore,
    load,
    refresh: load,
    refreshRoomStatus,
    refreshRoomPreviews,
    selectRoom,
    setViewMode,
    unlockSmall,

    loadMoreHistory,
    openSharedLive,
    isSharedLiveOnAir,
  }
}
