/**
 * 口袋「房间」页编排层：左侧关注成员房间列表 + 右侧房间消息流。
 *
 * 数据来源（与参考实现 yk1z/yaya_msg 同思路，落地在 desktop48 既有管道上）：
 * - 关注名单：口袋账号关注 ID（friendships/friends/id，只给 ID）∪ 本地关注名单，
 *   成员详情（头像/昵称/队伍）由本地成员目录反查——接口本身不返回这些；
 *   名单里可能混着官方号（袋王 / 各团官方号），它们不在成员名录里，
 *   回退 officialInfo（见 member-directory 的 findOfficialAccount）取真名与头像，
 *   其余口径与成员房间完全一致（同样解析频道、拉预览、计未读、参与排序，不另立档位）；
 *   被屏蔽的成员从这份并集里整体剔除（屏蔽优先，见 loadFollowedIds），
 *   屏蔽名单变化时左列条目就地摘除、右侧消息流一并收起（见 watch(blockedMembers)）；
 * - 房间频道：im/server/jump（starId=成员 userId）解析出 team server + channel，
 *   即口袋 App「房间」tab 里该成员的留言频道。解析不出频道 = 成员没有房间
 *   （含房间已关闭/被回收：同样解析不出频道，一并过滤，进不了列表）；
 * - 房间预览：im/team/classic/last/message/get 批量拉各频道最后一条消息（一次请求）；
 * - 房间消息：im/team/message/list/{homeowner,all} HTTP 拉取（msgTime 倒序，nextTime 游标翻历史），
 *   对应「只看房主 / 全部消息」两档范围；homeowner 会混入官方系统账号，已过滤。
 *   实时消息走 QChat 长连接（另一套 NIM 协议，见 main/pocket48/nim-qchat.ts）：
 *   进房订阅、收发消息与删除自己，推送（24/11）与 5s 轮询按 msgIdClient 双源去重，
 *   轮询同时是实时链路的兜底（断线 / 未识别类型的消息都靠它补齐）；
 * - 临时房间：成员详情卡底栏入口经 `/rooms?member=<userId>` 带进来的成员，可能不在关注
 *   名单里，只活在本次会话内存中（见 openTemporaryRoom / closeTemporaryRoom），
 *   频道解析缓存见 services/room-channel.ts。
 *
 * 失败一律静默降级：频道解析/消息拉取失败只影响右侧消息区，左侧列表照常可用；
 * 唯一例外是 token 失效（重新登录才能恢复），直接上抛让整页报错。
 */
import type { PocketRoomBatch, PocketRoomChannel, PocketRoomLastMessage, PocketRoomPermission, PocketRoomQChatStatus, PocketRoomQuestion, PocketRoomReplyTarget } from '@preload/ipc-contract'
import type { LiveListItem } from '@renderer/services/api-types'
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { OFFICIAL_POCKET_USER_ID } from '@common/pocket-rooms'
import { resolveMemberRoomChannel } from '@renderer/services/room-channel'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useLiveStatusStore } from '@renderer/stores/live-status'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { unreadCountOf, usePocketUnreadStore } from '@renderer/stores/pocket-unread'
import { debugLog } from '@renderer/utils/debug'

import { isPlaceholderText, liveShareTitle, normalizePocketRoomMessage, normalizePocketRoomPreview, normalizePocketRoomQChatMessage } from '@renderer/utils/pocket-room-message'
import { isSmallRoomUnlocked, markSmallRoomUnlocked } from '@renderer/utils/small-room-unlock'
import Tools from '@renderer/utils/tools'
import { useIntervalFn } from '@vueuse/core'
import { computed, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'

/** 关注来源：pocket = 来自口袋账号（拉取同步），local = 仅本地添加，both = 两边都有 */
export type PocketRoomFollowSource = 'pocket' | 'local' | 'both'

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
  /** 关注来源；临时房间缺省（不属于关注名单） */
  followSource?: PocketRoomFollowSource
  /**
   * 临时房间（成员详情卡入口带过来的）：成员不在关注名单里，只活在本次会话内存中，
   * 不写关注名单、不落盘，撤掉条目即消失。见 openTemporaryRoom。
   */
  temporary?: boolean
}

/** 右侧消息区状态 */
export type PocketRoomChatStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 房间新消息轮询间隔：参考实现通知轮询 2s，这里取 5s 平衡实时性与接口压力 */
const MESSAGE_POLL_MS = 5_000
/** 发送冷却（与主进程 pocket-room-qchat.ts 的 SEND_INTERVAL_MS 同值）：镜像只为按钮禁用态 */
const SEND_COOLDOWN_MS = 1500

/** 上翻连续零新增多少次才认定到头：单次零新增可能是边界/重发同页的假信号 */
const HISTORY_MISS_LIMIT = 2
/**
 * 左列预览刷新间隔：一次请求覆盖全部房间，与主进程未读检测（60s）同频，
 * 让「预览文案」和「未读角标」同一节奏到位。只驱动预览，不另建直播轮询
 * （共享 store 已覆盖直播状态）。
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

/** 频道已不存在：房主更新/删除小房间后旧频道即此结局（服务端原文，与主进程同一判据） */
function isChannelMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('频道不存在')
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
  /** 屏蔽名单（本地可见性偏好，与关注正交）：左列过滤 + 条目的就地摘除都读这一份 */
  const { blockedMembers, ensureBlockedLoaded, isBlocked } = useBlockedMembersStore()
  const { findMemberByUserId, findOfficialAccount } = useMemberDirectoryStore()
  /** 未读镜像（主进程唯一真相）：左列排序与角标共用同一判据，见 sortRooms */
  const { unreadRooms } = usePocketUnreadStore()
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
  /**
   * 临时房间：成员详情卡底栏入口经路由 query 带过来的成员（可能不在关注名单里）。
   * 只活在本次会话的内存中，不进关注名单、不落盘；撤掉条目即消失（见 closeTemporaryRoom）。
   */
  const temporaryRoom = ref<PocketRoom | null>(null)

  const selectedUserId = ref<number | null>(null)
  const messages = ref<PocketRoomMessageView[]>([])
  const chatStatus = ref<PocketRoomChatStatus>('idle')
  const chatStatusText = ref('')
  /** 更早历史是否已到头（加载更多按钮的禁用态） */
  const historyExhausted = ref(false)
  /** 加载更多中（按钮 loading 态） */
  const loadingMore = ref(false)

  /**
   * 房间精华消息（房主 / 管理员置顶的那批，口袋 App 房间顶部的「精华」）。
   * 按 msgTime **倒序**存：[0] 是最新一条，顶部精华条直接取它；弹层按同一顺序列出。
   * 只在进入房间 / 切频道时拉一页，不随 5s 消息轮询复查——精华是低频变更的内容，
   * 复查会让每个房间每次停留都多打一个请求。
   */
  const essenceMessages = ref<PocketRoomMessageView[]>([])
  /** 精华拉取中（弹层「加载更多」按钮的 loading 态；首屏拉取不阻塞任何界面） */
  const essenceLoading = ref(false)
  /** 精华是否已到头（弹层「加载更多」按钮的显隐） */
  const essenceExhausted = ref(false)
  /** 更早精华的游标；0 = 没有更多 */
  let essenceCursor = 0

  /** 当前房间的频道（轮询/加载更多用）；null = 未选中或解析失败 */
  let activeChannel: { serverId: string, channelId: string } | null = null

  // ===== 房间发言（QChat 长连接）=====
  /**
   * 当前频道的发言权限（room/info 的 userFunction，服务端按当前账号算好）。
   * null = 未知（还没拉到 / 未登录 / 小房间暗号未通过 / 接口异常）——一律按可发言处理，
   * 让服务端拒绝兜底；只有明确 false 才禁用输入。
   */
  const roomPermission = ref<PocketRoomPermission | null>(null)
  /**
   * 能否在本房间发文字：false = 房主开了房间级禁言（或个人禁言）。
   * 供输入框直接显示禁言态，并在点击前就拦住 QChat 建连（建连会顶掉手机端）。
   */
  const canSpeak = computed(() => roomPermission.value?.sendText !== false)
  /** 正在拉权限的频道 id：切房后旧回包不得覆盖新房间 */
  let permissionChannelId = ''
  /**
   * 用户是否已确认「连接云信会挤掉其他登录端」。默认 false：进房只跑 HTTP 轮询，
   * 不建连、不订阅；点聊天框确认后置位，登出即复位。
   */
  const qchatOptIn = ref(false)
  /**
   * QChat 连接状态：确认连接后由主进程经 pocketRoomBatch 推进
   * （connecting → connected；断线 disconnected → reconnecting，重连成功后订阅自动恢复）。
   * disconnected 时发送不可用（输入条禁用并给出原因）。
   */
  const qchatStatus = ref<PocketRoomQChatStatus>('disconnected')
  /** 连接状态附言（重连次数 / 失败原因）；空串 = 无 */
  const qchatHint = ref('')
  /** 已订阅的 QChat 频道（同步中的在途值以 activeChannel 为准，见 syncQChatChannel） */
  let qchatChannel: { serverId: string, channelId: string } | null = null
  /** 发送中（防重复提交；按钮 loading 态） */
  const sendBusy = ref(false)
  /**
   * 发送冷却剩余毫秒（与主进程 SEND_INTERVAL_MS 同口径的镜像）：主进程按会话限流，
   * 渲染层照抄一份只为按钮禁用态与倒数文案——真遇到并发发送，主进程的拒绝是最终防线。
   */
  const sendCooldownLeft = ref(0)
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined
  /** 回复态：选中了某条消息准备回复；null = 普通发言（输入条上方显示引用摘要） */
  const replyTarget = ref<PocketRoomReplyTarget | null>(null)
  /** 已加载消息的去重键集合：轮增量与翻历史共用，防重复插入 */
  let messageKeys = new Set<string>()
  /** 更早历史游标；0 = 下次上翻改用最早持有消息作探测游标（非「没有更多」） */
  let historyCursor = 0
  /** 上翻连续零新增计数，达 HISTORY_MISS_LIMIT 判到头；任何切房/换口径/有新增都归零 */
  let historyMissStreak = 0
  /** 消息范围（见 PocketRoomMessageScope）；切换时重拉当前房间 */
  const messageScope = ref<PocketRoomMessageScope>('member')
  /** 大房间 / 小房间视图（见 PocketRoomViewMode）；切换时换频道重拉 */
  const viewMode = ref<PocketRoomViewMode>('room')
  /** 选中成员的小房间频道；null = 未发现（主进程归属自愈只认 lastMsgList 回包里出现过的频道） */
  const smallChannel = ref<{ serverId: string, channelId: string } | null>(null)
  /** userId → 已发现的小房间频道缓存（只缓存命中；失效时由 dropSmallChannel 删除） */
  const smallChannelCache = new Map<number, { serverId: string, channelId: string }>()
  /**
   * 频道名表（tab 显示真实频道名）：连同所属 serverId 一起存，
   * 读取时校验归属——否则切成员后旧 server 的表会顶出新名字。
   */
  const channelNames = ref<{ serverId: string, map: Map<string, string> }>({ serverId: '', map: new Map() })
  /** serverId → 频道名表缓存（含空表：接口通了但没给名字，不重复打接口） */
  const serverChannelNameCache = new Map<string, Map<string, string>>()
  /** 当前小房间的暗号问题（channelId → 问题缓存，含 null：room/info 未被拦，即无门禁） */
  const smallQuestion = ref<PocketRoomQuestion | null>(null)
  const smallQuestionLoading = ref(false)
  const smallQuestionCache = new Map<string, PocketRoomQuestion | null>()
  /**
   * 小房间是否需要暗号：已发现频道 + 确认被暗号拦下（拿到问题）+ 本进程未解锁。
   * 解锁态在 utils/small-room-unlock.ts（模块级，页面层重建不丢）；
   * 刻意与当前视图解耦——页签上的锁要在大房间视图下同样可见，
   * 否则「需要暗号」这件事只在切过去之后才暴露。
   */
  const smallRequiresAnswer = computed(() =>
    !!smallChannel.value
    && smallQuestion.value !== null
    && !isSmallRoomUnlocked(smallChannel.value.channelId),
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

  /**
   * 左列成员：口袋关注 ID ∪ 本地关注 ID − 屏蔽名单。
   *
   * 减去屏蔽名单是「屏蔽优先」在房间页的落点：关注与屏蔽正交（见 composables/use-member-actions），
   * 账号关注照旧存在，但被屏蔽的成员不进左列——也就不必为它解析房间频道。
   */
  async function loadFollowedIds(): Promise<{ ids: number[], followSourceOf: Map<number, PocketRoomFollowSource> }> {
    // 屏蔽名单必须先就位：isBlocked 在未加载的空名单上恒为 false，漏加载等于放行被屏蔽成员
    await ensureBlockedLoaded()
    // 首灌走 refresh 而非 ensureLoaded：store 是模块级单例，ensureLoaded 命中后
    // 不再重拉，页面首灌要的是「此刻」的名单（设置页/成员页改过关注后开页即生效）
    const [pocketIds, localEntries] = await Promise.all([
      loadPocketFollowedIds(),
      refreshFollowedMembers().then(() => followedMembers.value),
    ])
    const pocketIdSet = new Set<number>()
    for (const id of pocketIds) {
      const userId = Tools.normalizeUserId(id)
      if (Number.isFinite(userId) && userId > 0)
        pocketIdSet.add(userId)
    }
    const localIdSet = new Set<number>()
    for (const entry of localEntries) {
      const userId = Tools.normalizeUserId(entry.userId)
      if (Number.isFinite(userId) && userId > 0)
        localIdSet.add(userId)
    }
    const ids = new Set<number>()
    const followSourceOf = new Map<number, PocketRoomFollowSource>()
    for (const userId of [...pocketIdSet, ...localIdSet]) {
      if (isBlocked(userId))
        continue
      ids.add(userId)
      const inPocket = pocketIdSet.has(userId)
      const inLocal = localIdSet.has(userId)
      followSourceOf.set(userId, inPocket && inLocal ? 'both' : inPocket ? 'pocket' : 'local')
    }
    return { ids: [...ids], followSourceOf }
  }

  /** 共享 store 的全站直播索引；force=true 用于手动刷新并绕过 120s 新鲜缓存。 */
  async function fetchLiveMap(force = false): Promise<Map<number, LiveListItem>> {
    await (force ? refreshLiveStatus(true) : ensureLiveStatusFresh())
    return liveByUserId.value
  }

  /**
   * 上次排序时「有未读」的成员集合：未读快照变化时据此判断要不要重排，
   * 见下方 watch(unreadRooms)。
   */
  let sortedUnreadIds = new Set<number>()

  /** 取列表中「有未读」的成员；判据与左列角标一致（大房间 + 小房间合计 > 0） */
  function collectUnreadIds(list: PocketRoom[]): Set<number> {
    const ids = new Set<number>()
    for (const room of list) {
      if (unreadCountOf(room.userId) > 0)
        ids.add(room.userId)
    }
    return ids
  }

  /**
   * 左列排序，四级判据：
   * 1. 临时房间恒置顶（用户刚点进来的那个，要第一眼看到）；
   * 2. 在直播的排在没直播的前面——「谁的房间开着」是第一眼信息；
   * 3. 其次是有未读的——「谁的房间有新消息」是第二眼信息；
   * 4. 同档按昵称 localeCompare('zh')。
   *
   * 未读判据取大房间 + 小房间合计（与左列角标同源），不是只看大房间：
   * 左列条目上只有一个角标，排序与它不一致会自相矛盾。
   */
  function sortRooms(list: PocketRoom[]) {
    list.sort((a, b) =>
      Number(!!b.temporary) - Number(!!a.temporary)
      || Number(!!b.live) - Number(!!a.live)
      || Number(unreadCountOf(b.userId) > 0) - Number(unreadCountOf(a.userId) > 0)
      || a.nickname.localeCompare(b.nickname, 'zh'),
    )
    sortedUnreadIds = collectUnreadIds(list)
  }

  // 共享 store 更新后同步到当前房间列表；页面不再自己持有直播轮询定时器。
  watch(liveByUserId, (liveMap) => {
    if (!rooms.value.length)
      return
    for (const room of rooms.value)
      room.live = liveMap.get(room.userId) ?? null
    sortRooms(rooms.value)
  }, { immediate: true })

  /**
   * 未读变化 → 重排左列（新消息浮上来），但**只在「新出现未读」时**重排。
   *
   * 读掉未读（进房即 markRead，本地乐观清零 + 主进程广播）不重排：那条正是用户刚点的，
   * 当场把它从顶部抽走会让人以为点错了。条目的下沉留给下一次自然排序
   * （重新进入页面 / 手动刷新 / 直播状态刷新），与「回到列表时名单已归位」的观感一致。
   *
   * 临时房间不在主进程未读检测范围内，对它这条 watch 是空转。
   */
  watch(unreadRooms, () => {
    if (!rooms.value.length)
      return
    const next = collectUnreadIds(rooms.value)
    if ([...next].some(userId => !sortedUnreadIds.has(userId)))
      sortRooms(rooms.value)
    else
      sortedUnreadIds = next
  })

  /**
   * 屏蔽名单变化 → 就地摘掉对应条目，不等下一次首灌。
   *
   * 屏蔽入口在成员页卡片与三处详情抽屉（成员 / 直播 / 回放），都可能在房间页挂在
   * keep-alive 后台时发生；只在 load() 里过滤的话，用户切回来看到的仍是旧列表。
   * 临时条目除外：那是用户从成员详情卡主动打开的，显式意图压过屏蔽。
   */
  watch(blockedMembers, () => {
    if (!rooms.value.length)
      return
    const next = rooms.value.filter(room => room.temporary || !isBlocked(room.userId))
    if (next.length === rooms.value.length)
      return
    rooms.value = next
    sortedUnreadIds = collectUnreadIds(next)
    // 正看着的成员被屏蔽：右侧消息流一并收起
    if (selectedUserId.value !== null && !next.some(room => room.userId === selectedUserId.value)) {
      selectedUserId.value = null
      clearChat()
      void syncQChatChannel()
    }
  })

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
        void syncQChatChannel()
        return
      }
      const { ids, followSourceOf } = await loadFollowedIds()
      if (requestId !== loadRequestId)
        return
      const liveMap = await fetchLiveMap(true)
      if (requestId !== loadRequestId)
        return

      const entries: PocketRoom[] = await Promise.all(ids.map(async (userId): Promise<PocketRoom> => {
        const live = liveMap.get(userId) ?? null
        const member = await findMemberByUserId(userId)
        // 关注名单里可能混着官方号（袋王 / 各团官方号）：它们不在成员名录里，
        // 回退到 officialInfo 取真名与头像，否则左列只剩「口袋用户 N」且无头像。
        // 其余口径与成员房间一致——同样参与频道解析、预览、未读与排序，不另立档位。
        const official = member ? null : await findOfficialAccount(userId)
        return {
          userId,
          nickname: member?.realName || member?.nickname || official?.name || live?.userInfo?.nickname || `口袋用户 ${userId}`,
          avatar: member?.avatar || official?.avatar || '',
          teamName: member?.teamName || '',
          teamColor: member?.teamColor || '',
          followSource: followSourceOf.get(userId),
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
      // 临时房间不在关注名单里，重建列表会把它的条目一起冲掉：这里重新并入。
      // 必须早于下面的选中复核 —— 用户正看着的可能就是它
      insertTemporaryRoom()
      // 选中项已不在列表（取关/刷新/房间被过滤）时清空右侧；仍在则保持选中（消息流不动）
      const stillSelected = rooms.value.some(room => room.userId === selectedUserId.value)
      if (!stillSelected && selectedUserId.value !== null) {
        selectedUserId.value = null
        clearChat()
        void syncQChatChannel()
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
    historyMissStreak = 0
    messages.value = []
    historyExhausted.value = false
    essenceMessages.value = []
    essenceCursor = 0
    essenceExhausted.value = false
    essenceLoading.value = false
    chatStatus.value = 'idle'
    chatStatusText.value = ''
    // 发言态随房间清空：回复目标与冷却都不属于下一个房间
    replyTarget.value = null
    // 发言权限也属于房间：清空后回到「未知 = 可发言」，避免上个房间的禁言态残留
    roomPermission.value = null
    permissionChannelId = ''
    clearSendCooldown()
  }

  /**
   * 把归一后的消息并入消息流。
   * mode=replace：首屏（接口倒序返回，翻转成时间升序）；
   * mode=prepend：翻更早历史（保持升序插到头部）；
   * mode=append：轮询增量（只收没见过的，排序后追加）。
   * 返回新并入条数（0 = 全是已见过的重复），供上翻判到头用。
   */
  function mergeMessages(incoming: PocketRoomMessageView[], mode: 'replace' | 'prepend' | 'append'): number {
    const fresh = incoming.filter(item => !messageKeys.has(item.id))
    for (const item of fresh)
      messageKeys.add(item.id)
    if (mode === 'replace') {
      // 首屏 / 换口径：以本页为准。空页也要落成空列表——换口径时旧内容不清、
      // 若这里提前 return，会让上一档的消息留在新档位下
      // 接口按 msgTime 倒序（最新在前），聊天流是最新在下，翻转
      messages.value = fresh.slice().sort((a, b) => a.msgTime - b.msgTime)
      return fresh.length
    }
    if (!fresh.length)
      return 0
    if (mode === 'prepend') {
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
    return fresh.length
  }

  // ===== 房间发言：连接同步 / 发送 / 删除（QChat）=====

  /** 自己发的消息（userId 口径见 normalizePocketRoomMessage；删除入口只对自己的展示） */
  function isOwnMessage(message: PocketRoomMessageView): boolean {
    const myId = pocketAuthState.value.userId
    return !!myId && !!message.userId && message.userId === myId
  }

  /**
   * 可回复的消息：有 msgIdClient 的文本 / 回复 / 礼物消息，且正文非占位
   * （eligibility 对齐参考实现——媒体消息没有可引用的文字，引用块会只剩空壳）。
   */
  function canReplyMessage(message: PocketRoomMessageView): boolean {
    return !!message.msgIdClient
      && (message.kind === 'text' || message.kind === 'reply' || message.kind === 'gift')
      && !isPlaceholderText(message.text)
  }

  /** 可删除的消息：自己发的，且 ID 与时刻齐全（删除接口三者都要） */
  function canDeleteMessage(message: PocketRoomMessageView): boolean {
    return isOwnMessage(message) && !!message.msgIdClient && message.msgTime > 0
  }

  /** 进入回复态：登记被回复消息摘要（msgIdClient 服务端据此关联原消息） */
  function startReply(message: PocketRoomMessageView): void {
    if (!canReplyMessage(message))
      return
    replyTarget.value = {
      msgIdClient: message.msgIdClient,
      senderName: message.nick || '用户',
      text: message.text,
    }
  }

  function cancelReply(): void {
    replyTarget.value = null
  }

  /** 开冷却倒数（自调度 setTimeout，到点自行收尾；切房/卸载由 clearCooldown 收） */
  function startSendCooldown(): void {
    const until = Date.now() + SEND_COOLDOWN_MS
    const tick = () => {
      const left = until - Date.now()
      if (left <= 0) {
        sendCooldownLeft.value = 0
        cooldownTimer = undefined
        return
      }
      sendCooldownLeft.value = left
      cooldownTimer = setTimeout(tick, 200)
    }
    tick()
  }

  function clearSendCooldown(): void {
    if (cooldownTimer) {
      clearTimeout(cooldownTimer)
      cooldownTimer = undefined
    }
    sendCooldownLeft.value = 0
  }

  /**
   * QChat 订阅与 activeChannel 对齐（唯一收敛点，串行执行防切房竞态）。
   * 顺序与主进程约定一致：**先订新房再退旧房**——旧频道若是最后一条订阅，
   * 先退会整条连接销毁，每次切房都要重连。连接状态走 pocketRoomBatch，这里只管调用与兜底；
   * 失败不抛——发送不可用而已，HTTP 轮询仍是消息链路的兜底。
   */
  let qchatSyncChain: Promise<void> = Promise.resolve()

  function syncQChatChannel(): Promise<void> {
    qchatSyncChain = qchatSyncChain.then(reconcileQChatChannel).catch((error) => {
      debugLog('pocket-rooms', '房间频道订阅同步失败', error)
    })
    return qchatSyncChain
  }

  /**
   * 用户确认后连接当前房间（置位 optIn 并同步订阅）。
   * 确认文案在页面层——这里只管「确认之后就按已授权处理」，失败原因经 qchatHint 回传。
   */
  async function connectRoomQChat(): Promise<{ ok: boolean, message?: string }> {
    const target = activeChannel
    if (!target)
      return { ok: false, message: '请先进入房间' }
    if (!loggedIn.value)
      return { ok: false, message: '登录口袋48账号后才能发言' }
    qchatOptIn.value = true
    await syncQChatChannel()
    // 以订阅表为准判断成败：qchatChannel 只在 enter 回包 ok 时更新，
    // 而连接状态由主进程异步推送，回包这一刻可能还没到
    const settled = qchatChannel
    if (!settled || settled.serverId !== target.serverId || settled.channelId !== target.channelId)
      return { ok: false, message: qchatHint.value || '房间连接失败' }
    return { ok: true }
  }

  /**
   * 主动断开房间 QChat：撤销连接授权并退订当前频道（连接按需销毁）。
   * 断开后本页回到只看模式：消息继续走 HTTP 轮询，不再顶掉手机等其他设备。
   */
  async function disconnectRoomQChat(): Promise<void> {
    qchatOptIn.value = false
    replyTarget.value = null
    clearSendCooldown()
    qchatStatus.value = 'disconnected'
    qchatHint.value = ''
    // 走同一收敛点退订当前频道：reconcileQChatChannel 见 optIn=false 会退旧房
    await syncQChatChannel()
  }

  async function leaveQChatChannel(channel: { serverId: string, channelId: string }): Promise<void> {
    try {
      await window.mainAPI.pocketRoomQChatLeave(channel.serverId, channel.channelId)
    }
    catch (error) {
      debugLog('pocket-rooms', '退订房间频道失败', error)
    }
  }

  async function reconcileQChatChannel(): Promise<void> {
    const next = activeChannel
    const previous = qchatChannel
    if (next && !qchatOptIn.value) {
      // 未确认连接：不建连、不订阅，消息走 HTTP 轮询。确认后由 connectRoomQChat 触发
      if (previous)
        await leaveQChatChannel(previous)
      qchatChannel = null
      qchatStatus.value = 'disconnected'
      return
    }
    const sameChannel = !!next && !!previous && next.serverId === previous.serverId && next.channelId === previous.channelId
    if (sameChannel || (!next && !previous))
      return
    if (next) {
      let entered = false
      try {
        const result = await window.mainAPI.pocketRoomQChatEnter(next.serverId, next.channelId)
        entered = result.ok
        if (!result.ok && activeChannel === next) {
          qchatStatus.value = 'disconnected'
          qchatHint.value = result.message || '房间连接失败'
        }
      }
      catch (error) {
        if (activeChannel === next) {
          qchatStatus.value = 'disconnected'
          qchatHint.value = error instanceof Error ? error.message : String(error)
        }
      }
      if (activeChannel !== next) {
        // 订阅回包期间又切了房：本次订阅已无用，退掉（旧房的退订交给后续同步）
        if (entered)
          await leaveQChatChannel(next)
        return
      }
      if (entered) {
        qchatChannel = next
        qchatHint.value = ''
      }
    }
    // 只有成功换到新房（或本就要退房）才退旧房：换房失败时旧订阅仍是唯一链路，
    // 不能退。退房 / 卸载时 qchatChannel 还指着旧频道，无条件退并清空跟踪
    if (previous && (!next || qchatChannel !== previous))
      await leaveQChatChannel(previous)
    if (!activeChannel) {
      qchatChannel = null
      qchatStatus.value = 'disconnected'
    }
  }

  /**
   * 在当前房间发言（文字 / 回复）。走 QChat 长连接（主进程 24/10），
   * ACK 带回一条发送回显（正文与资料由主进程用发送入参补全）——立即插入消息流；
   * 24/11 推送回显与 HTTP 轮询回包按 msgIdClient 去重，哪条先到都只显示一次。
   */
  async function sendMessage(text: string): Promise<{ ok: boolean, message?: string }> {
    const channel = activeChannel
    if (!channel || chatStatus.value !== 'ready')
      return { ok: false, message: '请先进入房间' }
    if (!loggedIn.value)
      return { ok: false, message: '登录口袋48账号后才能发言' }
    if (!qchatOptIn.value)
      return { ok: false, message: '请先点击聊天框连接房间' }
    // 服务端已明确禁言：入口已拦住，这里是并发/时序变化时的兜底
    if (!canSpeak.value)
      return { ok: false, message: '房主已开启全员禁言，暂时不能发言' }
    if (sendBusy.value)
      return { ok: false }
    const body = text.trim()
    if (!body)
      return { ok: false }
    const reply = replyTarget.value
    sendBusy.value = true
    try {
      const result = await window.mainAPI.pocketSendRoomMessage(channel.serverId, channel.channelId, body, reply ?? undefined)
      // 回包期间已切房：旧频道的 ACK 不得插进新房间的消息流
      if (activeChannel !== channel)
        return { ok: true }
      // 自己刚发的消息不受「只看房主」过滤：发送就要有回音（房主过滤是给「看别人」的）
      const view = normalizePocketRoomQChatMessage(result.message)
      if (view)
        mergeMessages([view], 'append')
      replyTarget.value = null
      startSendCooldown()
      return { ok: true }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    finally {
      sendBusy.value = false
    }
  }

  /**
   * 删除自己发的消息（HTTP；服务端按 accId 校验只能删自己的）。
   * 本地立即摘除，id 留在去重键里——服务端传播延迟内轮询回包仍会带上它，不放回屏上。
   */
  async function deleteOwnMessage(message: PocketRoomMessageView): Promise<{ ok: boolean, message?: string }> {
    const channel = activeChannel
    if (!channel)
      return { ok: false, message: '请先进入房间' }
    if (!canDeleteMessage(message))
      return { ok: false, message: '只能删除自己发送的消息' }
    try {
      await window.mainAPI.pocketDeleteRoomMessage(channel.channelId, message.msgIdClient, message.msgTime)
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    messages.value = messages.value.filter(item => item.id !== message.id)
    return { ok: true }
  }

  /**
   * 实时推送的可见性（与 HTTP 两档口径对齐）：「全部消息」全收；
   * 「只看房主」只收房主与自己——homeowner 链路本就不返回其他成员的发言，
   * 实时链路不过滤会让两档口径不一致（同样一条消息，轮询能显示、推送不能）。
   */
  function visibleInScope(view: PocketRoomMessageView): boolean {
    if (messageScope.value === 'all')
      return true
    const ownerId = selectedUserId.value === null ? '' : String(selectedUserId.value)
    return view.userId === ownerId || isOwnMessage(view)
  }

  /**
   * QChat 事件批次（主进程推给订阅了该账号房间会话的窗口）：连接状态 + 频道消息。
   * 消息只认当前订阅频道与 ready 态——切房瞬间可能收到旧频道的尾包；首屏拉取中
   * （replace）插进来的消息会被回包顶掉（去重键已登记但不在新页里），交给轮询补齐。
   */
  function onRoomBatch(batch: PocketRoomBatch): void {
    if (batch.kind === 'status') {
      qchatStatus.value = batch.status
      qchatHint.value = batch.message || ''
      return
    }
    if (chatStatus.value !== 'ready' || !activeChannel)
      return
    const message = batch.message
    if (message.channelId !== activeChannel.channelId || message.serverId !== activeChannel.serverId)
      return
    const view = normalizePocketRoomQChatMessage(message)
    if (view && visibleInScope(view))
      mergeMessages([view], 'append')
  }

  const stopRoomBatch = window.mainAPI.pocketRoomBatch(onRoomBatch)

  /** 已持有消息里最早的 msgTime（>0）；作上翻游标的兜底探测点 */
  function earliestHeldMsgTime(): number {
    let min = 0
    for (const item of messages.value) {
      if (item.msgTime > 0 && (min === 0 || item.msgTime < min))
        min = item.msgTime
    }
    return min
  }

  /** 拉取并归一一页房间消息；mode 见 mergeMessages */
  async function fetchRoomPage(
    channel: { serverId: string, channelId: string },
    nextTime: number,
    mode: 'replace' | 'prepend' | 'append',
  ): Promise<void> {
    const requestId = selectRequestId
    const scope = messageScope.value
    // 上翻游标兜底：游标为 0（首屏回过 0 / 上次上翻无进展）时，用最早持有消息的 msgTime 作探测
    const cursor = mode === 'prepend' && nextTime <= 0 ? earliestHeldMsgTime() : nextTime
    const result = await window.mainAPI.pocketGetRoomMessages(channel.channelId, channel.serverId, cursor, scope)
    // 回包期间已切房 / 换了拉取口径：旧回包不得并入当前列表
    if (requestId !== selectRequestId)
      return
    const views = result.messages
      .map(normalizePocketRoomMessage)
      .filter((item): item is PocketRoomMessageView => item !== null)
    // 只看房主时剔掉混入的官方系统账号发言（接口侧不区分）
    const mergedInput = scope === 'member' ? views.filter(item => item.userId !== OFFICIAL_POCKET_USER_ID) : views
    const freshCount = mergeMessages(mergedInput, mode)
    // 轮询（append）只管追加新消息：回包游标属「最新一页」，不能拿去写上翻游标
    if (mode === 'append')
      return
    if (mode === 'replace') {
      historyCursor = result.nextTime
      return
    }
    // 上翻到头判定只认「无进展」：游标推进或有新增都算进展，居其一就不计 miss。
    // 游标没前进或归零（协议终点；懒服务端也可能提前归零）→ 下次改用最早持有消息
    // 兜底探测，连续 HISTORY_MISS_LIMIT 次无进展才认定到头；条数不满 limit 不代表到头。
    const cursorAdvanced = result.nextTime > 0 && result.nextTime < cursor
    historyCursor = cursorAdvanced ? result.nextTime : 0
    if (freshCount > 0 || cursorAdvanced)
      historyMissStreak = 0
    else if (++historyMissStreak >= HISTORY_MISS_LIMIT)
      historyExhausted.value = true
  }

  /**
   * 拉取精华消息一页（mode=replace 首屏 / more 弹层加载更多）。
   * 失败只记日志、不打断房间：精华是附加信息，拉不到时顶部条直接不出现。
   * 接口按 msgTime 倒序返回，这里统一再排一次（[0] = 最新），不依赖服务端顺序。
   */
  async function fetchEssencePage(
    channel: { serverId: string, channelId: string },
    mode: 'replace' | 'more',
  ): Promise<void> {
    const requestId = selectRequestId
    if (mode === 'replace') {
      essenceMessages.value = []
      essenceCursor = 0
      essenceExhausted.value = false
    }
    essenceLoading.value = true
    try {
      const result = await window.mainAPI.pocketGetRoomEssenceMessages(
        channel.channelId,
        channel.serverId,
        mode === 'more' ? essenceCursor : 0,
      )
      // 回包期间可能已切房 / 切频道：过期回包不得写进当前房间的状态
      if (requestId !== selectRequestId)
        return
      const views = result.messages
        .map(normalizePocketRoomMessage)
        .filter((item): item is PocketRoomMessageView => item !== null)
      const existing = new Set(essenceMessages.value.map(item => item.id))
      const fresh = views.filter(item => !existing.has(item.id))
      essenceMessages.value = [...essenceMessages.value, ...fresh].sort((a, b) => b.msgTime - a.msgTime)
      essenceCursor = result.nextTime
      essenceExhausted.value = !result.nextTime
    }
    catch (error) {
      if (requestId === selectRequestId)
        debugLog('pocket-rooms', '精华消息拉取失败（顶部精华条不展示）', error)
    }
    finally {
      if (requestId === selectRequestId)
        essenceLoading.value = false
    }
  }

  /** 弹层里加载更早的精华（用户主动触发；加载中 / 已到头时 no-op） */
  async function loadMoreEssence(): Promise<void> {
    if (!activeChannel || essenceLoading.value || essenceExhausted.value)
      return
    await fetchEssencePage(activeChannel, 'more')
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
   * 发现选中成员的小房间频道（主进程枚举 server 频道列表的结果）；null = 未发现，入口隐藏。
   * 本地没有时让主进程重新枚举一次（server 级间隔，反复选中不会反复打接口）——
   * 房主新建 / 换新的小房间不必等最多一分钟的检测轮才出现。
   * `refresh` 用于同房重选：缓存命中也要问一次主进程，别一直显示已被换掉的旧频道。
   * 只缓存命中：缓存 null 会让新频道等到重启才出现。
   * 频道就位后顺手取一次暗号问题：页签上的锁图标靠它判定「是否需要暗号」，
   * 不能等到切进小房间才拉，否则在大房间视图下永远看不到锁。
   */
  async function ensureSmallChannel(userId: number, refresh = false): Promise<void> {
    const cached = smallChannelCache.get(userId)
    if (cached && !refresh) {
      if (selectedUserId.value === userId)
        smallChannel.value = cached
    }
    else {
      try {
        // 一次往返：主进程查自己的记录，没有（或要求校正）就枚举该 server 的频道列表
        const channel = await window.mainAPI.pocketRefreshSmallChannel(userId, refresh)
        if (channel)
          smallChannelCache.set(userId, channel)
        if (selectedUserId.value === userId)
          smallChannel.value = channel
        if (!channel)
          debugLog('pocket-rooms', '小房间入口隐藏：主进程未发现', userId, '强制重查', refresh)
      }
      catch (error) {
        debugLog('pocket-rooms', '小房间频道查询失败（入口降级隐藏）', error)
      }
    }
    if (selectedUserId.value === userId && smallChannel.value)
      void ensureSmallQuestion()
  }

  /**
   * 作废失效的小房间频道并立刻重找：清本地缓存 → 通知主进程清归属 → 强制枚举该 server，
   * 返回房主换上的新频道（没有则 null）。旧频道被删后新频道通常已经在列表里，
   * 不必让用户等下一轮检测。
   */
  async function refreshAfterDrop(userId: number, channelId: string): Promise<{ serverId: string, channelId: string } | null> {
    smallChannelCache.delete(userId)
    smallQuestionCache.delete(channelId)
    if (selectedUserId.value === userId) {
      smallChannel.value = null
      smallQuestion.value = null
      viewMode.value = 'room'
    }
    try {
      await window.mainAPI.pocketInvalidateSmallChannel(userId)
      const channel = await window.mainAPI.pocketRefreshSmallChannel(userId, true)
      if (channel)
        smallChannelCache.set(userId, channel)
      return channel
    }
    catch (error) {
      debugLog('pocket-rooms', '小房间重新发现失败（入口暂时隐藏）', error)
      return null
    }
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
      markSmallRoomUnlocked(channel.channelId)
      clearChat()
      await openChannel(userId, channel)
      return { ok: true }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 换拉取口径后重拉当前频道（切消息范围用）：只复位消息流自身，其余状态原样保留。
   *
   * 不走 clearChat + reopenActiveView —— 那条路径推倒的东西比换口径需要的多：
   * 精华消息按频道取、与范围无关，却要被清空再拉一次（顶部条会闪一下）；
   * activeChannel 置空后还得再走一遍 openChannel。这里保留频道与精华，只把
   * 去重键 / 游标 / 到头标记复位，旧口径的消息先留在屏上
   * （chatStatus=loading 由底部文案提示），回包后整体替换。
   *
   * 失败时清空消息：旧口径的内容留在新档位下会读成「这一档就这些」。
   */
  async function reloadMessagesForScope() {
    const channel = activeChannel
    if (!channel)
      return
    selectRequestId++
    const requestId = selectRequestId
    // 在途的精华翻页已作废（回包会因 requestId 不符被丢弃），别把按钮留在加载态
    essenceLoading.value = false
    messageKeys = new Set()
    historyCursor = 0
    historyMissStreak = 0
    historyExhausted.value = false
    chatStatus.value = 'loading'
    chatStatusText.value = ''
    try {
      await fetchRoomPage(channel, 0, 'replace')
    }
    catch (error) {
      if (requestId !== selectRequestId)
        return
      messages.value = []
      messageKeys = new Set()
      chatStatus.value = 'error'
      chatStatusText.value = error instanceof Error ? error.message : String(error)
      return
    }
    if (requestId !== selectRequestId)
      return
    chatStatus.value = 'ready'
    chatStatusText.value = ''
    resumeMessagePoll()
  }

  /**
   * 拉取当前频道发言权限（进房时与消息并行，不阻塞消息渲染）。
   * 失败一律保持「未知」：小房间暗号未通过（status 2001）、网络异常都只影响输入框提示，
   * 不能把「没查到」当成「被禁言」——真禁言时服务端发送会拒绝，主进程也会回错误文案。
   */
  async function loadRoomPermission(channelId: string): Promise<void> {
    permissionChannelId = channelId
    roomPermission.value = null
    try {
      const permission = await window.mainAPI.pocketGetRoomPermissions(channelId)
      // 回包期间已切房：旧频道的权限不得贴到新房间的输入框上
      if (permissionChannelId !== channelId)
        return
      roomPermission.value = permission
    }
    catch (error) {
      debugLog('pocket-rooms', '房间发言权限拉取失败', error)
    }
  }

  /** 在选中成员下打开指定频道（大房间或小房间）：首屏拉取 + 启动轮询 */
  async function openChannel(userId: number, channel: { serverId: string, channelId: string }) {
    const requestId = selectRequestId
    activeChannel = channel
    chatStatus.value = 'loading'
    chatStatusText.value = ''
    // 精华、首屏消息、发言权限三路并行：禁言态晚到也不影响消息先显示
    void fetchEssencePage(channel, 'replace')
    void loadRoomPermission(channel.channelId)
    try {
      await fetchRoomPage(channel, 0, 'replace')
    }
    catch (error) {
      if (requestId === selectRequestId) {
        // 小房间在打开期间被房主更新：旧频道已删除。作废归属并立刻枚举该 server，
        // 找到新频道就直接切过去；没有小房间了才退回大房间，不把「频道不存在」当错误页留给用户。
        if (viewMode.value === 'small' && smallChannel.value?.channelId === channel.channelId && isChannelMissing(error)) {
          const next = await refreshAfterDrop(userId, channel.channelId)
          if (requestId !== selectRequestId)
            return
          // 只在真的换到了新频道时自动切过去：同一频道重试只会再吃一次 404
          if (next && next.channelId !== channel.channelId && selectedUserId.value === userId) {
            smallChannel.value = next
            viewMode.value = 'small'
            await openChannel(userId, next)
            return
          }
          const bigChannel = channelCache.get(userId)
          if (bigChannel) {
            await openChannel(userId, bigChannel)
            return
          }
          await selectRoom(userId)
          return
        }
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
    // 进房不连 QChat：消息走 HTTP 轮询。用户点聊天框确认后才建连（会挤掉其他登录端），
    // 见 connectRoomQChat；退旧房在 sync 内部后置，见 reconcileQChatChannel
    void syncQChatChannel()
  }

  /**
   * 选中房间：取缓存频道 → 拉最近一页消息 → 启动轮询。
   * 频道在首灌时已遍历解析并缓存；缓存未命中（关注后有新增）才懒解析。
   * 选中态在 await 期间可能已被切换/清空，回包后必须复核，否则消息会串房。
   * 房间留言流与直播与否无关：未开播的成员同样有房间消息。
   */
  async function selectRoom(userId: number | null) {
    // 同房且已就绪：消息流与轮询保持不动，但小房间可能刚被房主新建 / 换新，
    // 补一次发现（缓存命中不打接口，主进程侧也有 server 级间隔）
    if (userId === selectedUserId.value && chatStatus.value === 'ready') {
      if (userId !== null)
        void ensureSmallChannel(userId, true)
      return
    }
    clearChat()
    selectedUserId.value = userId
    // 视图随选中成员复位到大房间；小房间频道异步发现（不阻塞大房间首屏）
    viewMode.value = 'room'
    smallChannel.value = null
    smallQuestion.value = null
    if (userId === null) {
      // 退房（点空白处取消选中）：同步退掉 QChat 订阅，连接交给主进程按需销毁
      void syncQChatChannel()
      return
    }
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
   * 把临时房间并入左列：置顶（见 sortRooms），已在关注列表里则就地撤掉临时条目
   * ——同一成员两条会重复，关注条目已覆盖它。
   */
  function insertTemporaryRoom() {
    const temp = temporaryRoom.value
    if (!temp)
      return
    if (rooms.value.some(room => room.userId === temp.userId)) {
      temporaryRoom.value = null
      return
    }
    rooms.value = [temp, ...rooms.value]
    sortRooms(rooms.value)
  }

  /** 撤掉临时房间（左列关掉按钮 / 路由 query 消失）：正看着它就一并清空右侧消息区 */
  function closeTemporaryRoom() {
    const temp = temporaryRoom.value
    if (!temp)
      return
    temporaryRoom.value = null
    rooms.value = rooms.value.filter(room => room !== temp)
    if (selectedUserId.value === temp.userId) {
      selectedUserId.value = null
      clearChat()
      void syncQChatChannel()
    }
  }

  /**
   * 临时打开某成员的大房间（成员详情卡入口 → 路由 query 的唯一入口）。
   *
   * 与关注房间的区别只在「条目从哪来」：不改关注名单、不落盘。频道经
   * services/room-channel 解析（与入口显隐共用同一份缓存），拿到后并入列表并走
   * selectRoom 的同一条链路（小房间发现 / 频道名 / 首屏 / 轮询）。
   * 已关注成员不建临时条目——左列本来就有它。
   */
  async function openTemporaryRoom(userId: number): Promise<{ ok: boolean, message?: string }> {
    // 必须等登录态落库：否则冷启动首帧会被误判成「未登录」而拒绝打开
    await refreshPocketAuthState()
    if (!pocketAuthState.value.loggedIn)
      return { ok: false, message: '登录口袋48账号后才能查看房间' }

    const channel = await resolveMemberRoomChannel(userId)
    if (!channel)
      return { ok: false, message: '未查询到该成员的大房间' }

    // 频道入册：selectRoom 命中缓存即不再打一次 jump
    channelCache.set(userId, channel)

    if (rooms.value.some(room => room.userId === userId)) {
      temporaryRoom.value = null
      await selectRoom(userId)
      return { ok: true }
    }

    // 成员详情由本地名录反查（与关注房间同口径）；查不到降级为口袋昵称，不阻断打开
    const member = await findMemberByUserId(userId).catch(() => null)
    temporaryRoom.value = {
      userId,
      nickname: member?.realName || member?.nickname || `口袋用户 ${userId}`,
      avatar: member?.avatar || '',
      teamName: member?.teamName || '',
      teamColor: member?.teamColor || '',
      serverId: channel.serverId,
      channelId: channel.channelId,
      preview: '',
      previewTime: 0,
      live: liveByUserId.value.get(userId) ?? null,
      temporary: true,
    }
    insertTemporaryRoom()
    await selectRoom(userId)
    return { ok: true }
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

  // 登录态变化（在设置页登录/退出后回到本页）：重新首灌；退出即撤回连接授权并退订
  watch(loggedIn, (value) => {
    if (!value) {
      qchatOptIn.value = false
      void syncQChatChannel()
    }
    void load()
  })

  // 切换消息范围：接口按范围过滤，只能重拉当前频道最近一页（未选中时切了也无需动作）。
  // 走 reloadMessagesForScope —— 频道没变，不必 clearChat + 重开（会连带清掉与范围无关的精华）。
  // 小房间锁定态不拉消息（暗号层展示），只补一次题面；频道尚未打开时才回退到原重开路径。
  watch(messageScope, () => {
    if (selectedUserId.value === null)
      return
    if (!activeChannel) {
      if (smallLocked.value) {
        void ensureSmallQuestion()
        return
      }
      clearChat()
      void reopenActiveView()
      return
    }
    void reloadMessagesForScope()
  })

  // 卸载/作用域销毁：停轮询、退 QChat 订阅（消息区状态随页面销毁自然废弃）
  onScopeDispose(() => {
    loadRequestId++
    selectRequestId++
    pageActive.value = false
    releaseLiveStatusPolling?.()
    releaseLiveStatusPolling = null
    pauseMessagePoll()
    stopRoomBatch()
    clearSendCooldown()
    // 先清空跟踪目标再同步：不清的话 reconcile 看到「同房」直接返回，订阅不退
    activeChannel = null
    void syncQChatChannel()
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
    temporaryRoom,
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
    essenceMessages,
    essenceLoading,
    essenceExhausted,
    loadMoreEssence,
    load,
    refresh: load,
    refreshRoomStatus,
    refreshRoomPreviews,
    selectRoom,
    setViewMode,
    unlockSmall,
    openTemporaryRoom,
    closeTemporaryRoom,

    loadMoreHistory,
    openSharedLive,
    isSharedLiveOnAir,

    qchatStatus,
    qchatHint,
    qchatOptIn,
    /** 当前房间是否允许发言（房主房间级禁言时 false，输入框据此禁用并跳过建连） */
    canSpeak,
    connectRoomQChat,
    disconnectRoomQChat,
    sendBusy,
    sendCooldownLeft,
    replyTarget,
    isOwnMessage,
    canReplyMessage,
    canDeleteMessage,
    startReply,
    cancelReply,
    sendMessage,
    deleteOwnMessage,
  }
}
