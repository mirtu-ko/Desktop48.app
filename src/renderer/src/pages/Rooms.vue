<script setup lang="ts">
// 口袋「房间」页：左栏关注成员房间列表，右栏房间消息流（成员在房间频道的留言，非直播间弹幕）。
// 数据与连接编排见 composables/use-pocket-rooms.ts（本页只做展示与交互）。

import type { PocketRoom } from '@renderer/composables/use-pocket-rooms'
import type { PocketRoomCopyKey, PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import type { Component, ComponentPublicInstance } from 'vue'
import { ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'
import { ArrowRight, Calendar, ChatDotRound, Check, Delete, DocumentCopy, Lock, Microphone, Picture, Refresh, StarFilled, VideoCamera } from '@element-plus/icons-vue'
import RoomAlbum from '@renderer/components/rooms/RoomAlbum.vue'
import RoomComposer from '@renderer/components/rooms/RoomComposer.vue'
import RoomDateDialog from '@renderer/components/rooms/RoomDateDialog.vue'
import RoomEssenceDialog from '@renderer/components/rooms/RoomEssenceDialog.vue'
import RoomListItem from '@renderer/components/rooms/RoomListItem.vue'
import RoomLiveCard from '@renderer/components/rooms/RoomLiveCard.vue'
import RoomMessageMenu from '@renderer/components/rooms/RoomMessageMenu.vue'
import RoomProfileCard from '@renderer/components/rooms/RoomProfileCard.vue'

import RoomVoiceBar from '@renderer/components/rooms/RoomVoiceBar.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import PreviewImage from '@renderer/components/ui/PreviewImage.vue'
import { usePocketRooms } from '@renderer/composables/use-pocket-rooms'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { useMemberTeamPromotionStore } from '@renderer/stores/member-team-promotion'
import { markRoomRead, unreadChannelOf, unreadCountOf } from '@renderer/stores/pocket-unread'
import { useRoomPinsStore } from '@renderer/stores/room-pins'
import { copyText } from '@renderer/utils/clipboard'
import { debugLog } from '@renderer/utils/debug'
import { isPlaceholderText, liveShareTitle, pocketRoomCopyTargets } from '@renderer/utils/pocket-room-message'
import { resolveDateChannel, resolveRoomArchiveStart } from '@renderer/utils/room-date-jump'
import { shouldTrackRoomEnter } from '@renderer/utils/room-enter-tracker'
import Tools from '@renderer/utils/tools'
import { trackEvent } from '@renderer/utils/umami'
import { useDebounceFn, useDocumentVisibility, useEventListener, useIntersectionObserver, useResizeObserver } from '@vueuse/core'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, h, nextTick, onDeactivated, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const {
  rooms,
  loading,
  liveRefreshing,
  loadError,
  pocketFollowError,
  hiddenRoomCount,
  loggedIn,
  selectedRoom,
  selectedUserId,
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
  smallGateNotice,
  chatStatus,
  chatStatusText,
  roomClosed,
  isRoomClosedOf,
  archiveChannelOf,
  historyExhausted,
  loadingMore,
  essenceMessages,
  essenceLoading,
  essenceExhausted,
  loadMoreEssence,
  load,
  selectRoom,
  setViewMode,
  unlockSmall,
  openTemporaryRoom,
  closeTemporaryRoom,
  applyRoomFollowSource,
  notePocketFollow,

  loadMoreHistory,
  openSharedLive,
  isSharedLiveOnAir,

  qchatStatus,
  qchatHint,
  canSpeak,
  sendBusy,
  sendCooldownLeft,
  replyTarget,
  canReplyMessage,
  canDeleteMessage,
  startReply,
  cancelReply,
  sendMessage,
  deleteOwnMessage,
} = usePocketRooms()

const router = useRouter()
const route = useRoute()

/** 页面可见性：窗口隐藏 / 最小化时暂停左列直播特效动画（见 .rooms-page.is-paused） */
const docVisibility = useDocumentVisibility()

/** 精华消息弹层是否打开 */
const essenceOpen = ref(false)
/** 按日期查看弹层是否打开 */
const dateOpen = ref(false)

/** 打开按日期查看：入口只有头部一处，埋点放在这里 */
function openDateDialog() {
  dateOpen.value = true
  trackEvent('room:date_open')
}

/** 进房上报：from 区分左列点击与深链，每日每房间去重 */
function trackRoomEnter(userId: number, from: 'list' | 'query') {
  const starName = rooms.value.find(room => room.userId === userId)?.nickname || ''
  if (shouldTrackRoomEnter(userId, starName))
    trackEvent('rooms:enter', { starName, from })
}

/** 房间页关注上报：target 区分口袋账号关注与本机关注 */
function trackRoomFollow(action: 'follow' | 'unfollow', target: 'pocket' | 'local', failed = false) {
  const starName = selectedRoom.value?.nickname || ''
  trackEvent('member:follow', { action, from: 'room', target, starName, ...(failed ? { result: 'fail' } : {}) })
}

const { findMemberByUserId } = useMemberDirectoryStore()
/** 本地关注名单：资料卡「本地关注」开关的写入口（见 toggleLocalFollow） */
const { followMember, unfollowMember } = useFollowedMembersStore()

/** 房间展示队伍：整列一次派生，模板只读 displayTeam；服务端原值仍留在 room 上 */
const { displayTeamOf } = useMemberTeamPromotionStore()
/** 置顶名单（本地展示偏好，见 stores/room-pins）：顺序由 composable 的 sortRooms 统一决定，这里只读标记与切换 */
const { isRoomPinned, toggleRoomPin } = useRoomPinsStore()

/** 置顶上报：from 区分右键菜单与头部按钮，action 取点击前状态 */
function onToggleRoomPin(userId: number, from: 'menu' | 'header') {
  const action = isRoomPinned(userId) ? 'unpin' : 'pin'
  toggleRoomPin(userId)
  const starName = rooms.value.find(room => room.userId === userId)?.nickname || ''
  trackEvent('room:pin', { action, from, starName })
}
const displayRooms = computed(() => rooms.value.map(room => ({
  ...room,
  pinned: isRoomPinned(room.userId),
  displayTeam: displayTeamOf(room.userId, room.teamName, room.teamColor),
  // 以下四项是入口组件要的展示结果，在这里一次算好：组件不该为了未读/关闭态去读各 store
  unreadText: unreadCountOf(room.userId) ? roomUnreadText(room.userId) : '',
  hint: roomItemHint(room),
  closed: isRoomClosedOf(room.userId),
  pocketFollowed: isPocketFollowed(room.followSource),
})))
/** 当前列表里的置顶条数：置顶过但已取消关注 / 房间关掉的成员不算，免得数与所见不一致 */
const pinnedRoomCount = computed(() => displayRooms.value.filter(room => room.pinned).length)
const selectedRoomTeam = computed(() => selectedRoom.value
  ? displayTeamOf(selectedRoom.value.userId, selectedRoom.value.teamName, selectedRoom.value.teamColor)
  : { teamName: '', teamColor: '' })
/** 头部置顶按钮的当前态：入口与左列标记共用同一份名单 */
const selectedRoomPinned = computed(() => !!selectedRoom.value && isRoomPinned(selectedRoom.value.userId))

/** 当前房间成员的入团时间；名录未同步或查不到时为空，起点回落到归档日 */
const roomJoinTime = ref('')
let joinLookupSeq = 0
watch(selectedUserId, async (userId) => {
  const seq = ++joinLookupSeq
  roomJoinTime.value = ''
  if (userId === null)
    return
  try {
    const member = await findMemberByUserId(userId)
    if (seq === joinLookupSeq)
      roomJoinTime.value = member?.joinTime || ''
  }
  catch {
    // 名录未同步：保留空值，由起点计算回落
  }
}, { immediate: true })

/** 按日期查看的可查起点：入团日与归档日取较晚者 */
const roomArchiveStart = computed(() => resolveRoomArchiveStart(roomJoinTime.value))

/**
 * 按日期查看的读取频道与不可用原因：关闭态只认历史存档频道，其余按视图取小房间 / 大房间
 * （见 resolveDateChannel）。关闭却没解析到存档频道时按日期无可读内容，弹层据此说明原因。
 */
const dateTarget = computed(() => {
  const closed = roomClosed.value
  const archive = archiveChannelOf(selectedUserId.value)
  return {
    channel: resolveDateChannel({
      closed,
      archive,
      viewMode: viewMode.value,
      small: smallChannel.value,
      room: selectedRoom.value,
    }),
    missing: closed && !archive,
  }
})

/** 小房间上锁时收起弹层：门禁未通过不该留着房间历史 */
watch(smallLocked, (locked) => {
  if (locked)
    dateOpen.value = false
})

/** 顶部精华条展示的那条：最新一条精华（列表已按 msgTime 倒序） */
const newestEssence = computed(() => essenceMessages.value[0] ?? null)

/** 精华条摘要：单行展示，正文优先；图片 / 语音等占位文案由归一化给出 */
const essenceSummary = computed(() => {
  const message = newestEssence.value
  if (!message)
    return ''
  return message.text || '[消息]'
})

/** 未读数字角标文案：计数按列表一页封顶，触顶即「至少这么多」，收敛为 50+ */
function unreadText(count: number): string {
  return count >= ROOM_MESSAGE_LIMIT ? `${ROOM_MESSAGE_LIMIT}+` : String(count)
}

/** 左列房间未读角标文案：v-if 与插值共用同一出口，计数语义与封顶规则只此一处 */
function roomUnreadText(userId: number): string {
  return unreadText(unreadCountOf(userId))
}

/** 是否在口袋账号侧有关注（pocket / both 都算；本地独有的不算） */
function isPocketFollowed(source: PocketRoom['followSource']): boolean {
  return source === 'pocket' || source === 'both'
}

/** 是否在本机名单里（local / both 都算） */
function isLocallyFollowed(source: PocketRoom['followSource']): boolean {
  return source === 'local' || source === 'both'
}

const selectedPocketFollowed = computed(() => isPocketFollowed(selectedRoom.value?.followSource))
const selectedLocalFollowed = computed(() => isLocallyFollowed(selectedRoom.value?.followSource))

/**
 * 资料卡的两个关注开关。
 *
 * 口袋关注写账号（friends/id）并顺带补本机 flag；本地关注只写本机名单。
 * 两者不是对等的两份名单：账号关注按策略 A 只增不删地并进本机（见
 * stores/member-flags 的 mergeFromPocket），所以账号已关注时本地必然收录——
 * 本地开关这时锁定为开，只有「仅本地关注」的成员才能本地取关。
 * 两个来源都不再关注时，房间随条目移出左列（正看着则右侧收起）。
 */
const pocketFollowBusy = ref(false)
const localFollowBusy = ref(false)

/** 口袋关注开关：写账号并顺带补本机 flag；取消只动账号、保留本机记录（二次确认） */
async function togglePocketFollow() {
  const room = selectedRoom.value
  if (!room || pocketFollowBusy.value || localFollowBusy.value)
    return
  const willFollow = !selectedPocketFollowed.value
  // 本地状态在 await 前截下：回包期间可能已切房
  const keepLocal = selectedLocalFollowed.value
  if (!willFollow) {
    const ok = await ElMessageBox.confirm(
      `确定在口袋账号取消关注「${room.nickname}」吗？该操作会同步到你的口袋账号。`,
      '取消口袋关注',
      {
        type: 'warning',
        customClass: 'app-confirm',
        modalClass: 'detail-card-overlay',
        confirmButtonText: '取消关注',
        cancelButtonText: '再想想',
      },
    ).then(() => true).catch(() => false)
    if (!ok)
      return
  }
  pocketFollowBusy.value = true
  try {
    if (willFollow) {
      await window.mainAPI.pocketFollowMember(room.userId)
      // 先更新口袋镜像再写本地：本地 store 的变化会触发来源 watch，此时镜像须已是最新
      notePocketFollow(room.userId, true)
      const localOk = await followMember({ userId: room.userId, realName: room.nickname, teamColor: room.teamColor })
      applyRoomFollowSource(room.userId, localOk ? 'both' : 'pocket')
      trackRoomFollow('follow', 'pocket')
      ElMessage({
        message: localOk ? '已关注（口袋账号 + 本机）' : '已关注口袋账号，本机记录同步失败',
        type: localOk ? 'success' : 'warning',
      })
      return
    }
    await window.mainAPI.pocketUnfollowMember(room.userId)
    notePocketFollow(room.userId, false)
    applyRoomFollowSource(room.userId, keepLocal ? 'local' : undefined)
    trackRoomFollow('unfollow', 'pocket')
    ElMessage({
      message: keepLocal ? '已取消口袋关注，本地关注保留' : '已取消关注，房间已移出列表',
      type: 'success',
    })
  }
  catch (error) {
    trackRoomFollow(willFollow ? 'follow' : 'unfollow', 'pocket', true)
    ElMessage.error(willFollow ? '口袋关注失败，请稍后重试' : '口袋取关失败，请稍后重试')
    debugLog('pocket-rooms', '口袋关注/取关失败', error)
  }
  finally {
    pocketFollowBusy.value = false
  }
}

/**
 * 本地关注开关：只动本机名单。口袋已关注时锁定（见上），这里再守一道，
 * 免得按钮态与服务端不同步时把同步会补回来的记录删掉。
 */
async function toggleLocalFollow() {
  const room = selectedRoom.value
  if (!room || localFollowBusy.value || pocketFollowBusy.value || selectedPocketFollowed.value)
    return
  const willFollow = !selectedLocalFollowed.value
  localFollowBusy.value = true
  try {
    if (willFollow) {
      const ok = await followMember({ userId: room.userId, realName: room.nickname, teamColor: room.teamColor })
      trackRoomFollow('follow', 'local', !ok)
      if (!ok) {
        ElMessage.error('本地关注失败，请稍后重试')
        return
      }
      applyRoomFollowSource(room.userId, 'local')
      ElMessage({ message: '已在本机关注该成员', type: 'success' })
      return
    }
    const ok = await unfollowMember(room.userId)
    trackRoomFollow('unfollow', 'local', !ok)
    if (!ok) {
      ElMessage.error('本地取关失败，请稍后重试')
      return
    }
    applyRoomFollowSource(room.userId, undefined)
    ElMessage({ message: '已移出本机，房间不再显示', type: 'success' })
  }
  finally {
    localFollowBusy.value = false
  }
}

// ===== 未读分割线（进房时的已读水位锚点）=====

/**
 * 本次进房截到的未读起点（清零前的已读水位 + 条数）；null = 不画分割线。
 * userId / target 限定归属：切房或换频道后该锚点不再参与定位。
 */
const unreadAnchor = ref<{
  userId: number
  target: 'room' | 'small'
  /** 水位那条的服务端 id：优先按它定位（同一毫秒多条不致错位） */
  msgIdServer: string
  msgTime: number
  /** 截下时的未读条数（角标口径，含封顶）：底部胶囊文案用 */
  count: number
  /** 补页触顶后水位仍在窗口外：分割线钉窗口顶、文案降级（见 fillUnreadWindow） */
  beyond: boolean
} | null>(null)
/** 未读胶囊是否已让位：跳转过后、或用户自己上翻去找时收起（分割线本身保留） */
const unreadJumped = ref(false)
/**
 * 进房 / 切频道收尾在途数：不清零前贴底监听不抢跑 markRoomRead，否则锚点截不到旧水位。
 * 用计数而非布尔：连点两个房间时两趟收尾重叠，布尔会被先结束的一趟解掉，后一趟的分割线随之丢失。
 */
let entryMarkDepth = 0
function beginEntryMark() {
  entryMarkDepth += 1
}
function endEntryMark() {
  entryMarkDepth = Math.max(0, entryMarkDepth - 1)
}
/** 分割线在 messages 里的下标；-1 = 不画（没有锚点，或列表里没有比水位更新的消息） */
const unreadIndex = computed(() => {
  const anchor = unreadAnchor.value
  if (!anchor || anchor.userId !== selectedUserId.value || anchor.target !== viewMode.value)
    return -1
  const list = messages.value
  // 优先按 id 找到水位那条，分割线落在其后（同一毫秒多条不致错位）；id 不在窗口时退回时刻比较
  if (anchor.msgIdServer) {
    const byId = list.findIndex(message => message.msgIdServer === anchor.msgIdServer)
    if (byId >= 0)
      return byId + 1 < list.length ? byId + 1 : -1
  }
  return list.findIndex(message => message.msgTime > anchor.msgTime)
})
/**
 * 分割线以下的可见条数（「以下是 N 条新消息」）：与分割线位置一致。
 * 不用 anchor.count——那是角标口径（只数房主发言、按一页封顶），与可见条数对不上。
 */
const unreadRegionCount = computed(() =>
  unreadIndex.value >= 0 ? messages.value.length - unreadIndex.value : 0,
)

/** 分割线的 DOM 锚点（v-for 内函数 ref，元素卸载时传 null） */
const unreadAnchorEl = ref<HTMLElement | null>(null)
function setUnreadAnchorEl(el: Element | ComponentPublicInstance | null) {
  unreadAnchorEl.value = el instanceof HTMLElement ? el : null
}

/**
 * 清零目标频道未读并截下分割线锚点：水位由 markRoomRead 原子带回（先截后推），
 * count 由调用方在清零前取得（乐观清零后只剩 0）。回包时已切房 / 换频道则不落锚点。
 */
async function markRoomReadCapturing(userId: number, target: 'room' | 'small', count: number) {
  unreadJumped.value = false
  const prev = await markRoomRead(userId, target)
  if (selectedUserId.value !== userId || viewMode.value !== target)
    return false
  if (count <= 0 || !prev) {
    unreadAnchor.value = null
    return false
  }
  unreadAnchor.value = {
    userId,
    target,
    msgIdServer: String(prev.msgIdServer ?? ''),
    msgTime: prev.msgTime,
    count,
    beyond: false,
  }
  return true
}

/** 分割线钉在窗口顶且补页触顶：水位仍在更早的未加载区域（上翻补进后恢复精确定位） */
const unreadAnchorBeyond = computed(() =>
  unreadAnchor.value?.beyond === true && unreadIndex.value === 0,
)

/** 分割线文案：正常报「以下是 N 条」；水位在未加载区域时降级为提示上翻 */
const unreadDividerText = computed(() => {
  const anchor = unreadAnchor.value
  if (!anchor)
    return ''
  return unreadAnchorBeyond.value
    ? `新消息从更早开始（${unreadText(anchor.count)} 条），上翻继续查看`
    : `以下是 ${unreadRegionCount.value} 条新消息`
})

/**
 * 换消息范围（只看房主 / 全部消息）等于换了一批消息：进房时截的水位在新列表里通常不存在，
 * 分割线会退回按时刻比较、落在并非真实边界的位置。清掉重算，等下次进房再截。
 */
watch(messageScope, () => {
  unreadAnchor.value = null
  unreadJumped.value = false
})

/**
 * 频道切换（页签）：切到哪个频道就清该频道未读。
 * 点已激活的页签直接返回——重进会覆盖原分割线并强制回底打断上翻；
 * 上翻期间攒的未读由「回到底部即补标」清（onListScroll）。
 */
async function onViewModeChange(mode: 'room' | 'small') {
  if (mode === viewMode.value)
    return
  const userId = selectedUserId.value
  if (mode !== 'room') {
    // 小房间未读同样在清零前截（两个频道各有自己的水位与条数）
    const hadUnread = userId !== null ? unreadChannelOf(userId).small : 0
    unreadAnchor.value = null
    unreadJumped.value = false
    beginEntryMark()
    try {
      void setViewMode(mode)
      if (userId !== null && hadUnread > 0)
        await markRoomReadCapturing(userId, 'small', hadUnread)
    }
    finally {
      endEntryMark()
    }
    return
  }
  const hadUnread = userId !== null ? unreadChannelOf(userId).big : 0
  unreadAnchor.value = null
  unreadJumped.value = false
  beginEntryMark()
  try {
    await setViewMode(mode)
    if (userId !== null)
      await settleBigRoomEnter(userId, hadUnread)
  }
  finally {
    endEntryMark()
  }
}

/**
 * 频道页签（大房间 + 已发现的小房间）：名称取服务端频道名（见 use-pocket-rooms 的
 * ensureChannelNames），未取到退回通用名；未读按频道分计，落在各自页签上。
 * 小房间未发现时也渲染整条页签栏（只剩大房间一个页签），保持头部结构稳定。
 */
const roomTabs = computed<Array<{ mode: 'room' | 'small', name: string, unread: number, locked: boolean }>>(() => {
  const userId = selectedRoom.value?.userId
  if (userId === undefined)
    return []
  const unread = unreadChannelOf(userId)
  const tabs: Array<{ mode: 'room' | 'small', name: string, unread: number, locked: boolean }> = [
    { mode: 'room', name: roomChannelName.value || '房间', unread: unread.big, locked: false },
  ]
  if (smallChannel.value) {
    tabs.push({
      mode: 'small',
      name: smallChannelName.value || '小房间',
      unread: unread.small,
      // 与当前视图无关：只要该频道被暗号拦着且本会话未解锁，锁就一直挂在页签上
      locked: smallRequiresAnswer.value,
    })
  }
  return tabs
})

/** 不可作答门禁的说明：原文已转述，这里只说「本地无从解锁、条件满足后自动放行」 */
const smallGateHint = computed(() => {
  const kind = smallGateNotice.value?.kind
  if (kind === 'chicken-leg')
    return '这是成员给小房间设的赠送门槛，本应用无法代为解锁；条件满足后重新进入即可查看'
  if (kind === 'contribution')
    return '这是成员给小房间设的贡献 / 守护门槛（服务端只用同一个业务码回，分不出是哪一种），本应用无法代为解锁；条件满足后重新进入即可查看'
  return '当前账号未通过该小房间的准入条件，本应用无法代为解锁'
})

/** 小房间暗号输入层（锁定态展示） */
const smallAnswer = ref('')
const smallSubmitting = ref(false)
const smallAnswerError = ref('')

/** 输入即清错误：改一个字的成本应当低于重读一次报错 */
function onSmallAnswerInput() {
  smallAnswerError.value = ''
}

/**
 * 提交暗号。只有校验通过（含万能密码）才解锁并加载小房间消息；
 * 未通过一律停留在锁定层，如实展示失败原因。
 */
async function submitSmallAnswer() {
  const answer = smallAnswer.value.trim()
  if (smallSubmitting.value || !answer)
    return
  smallSubmitting.value = true
  smallAnswerError.value = ''
  const result = await unlockSmall(answer)
  smallSubmitting.value = false
  // 门禁通过率是这块功能唯一有效的指标，不记录暗号本身
  trackEvent('room:unlock_small', { result: result.ok ? 'ok' : 'fail' })
  if (!result.ok) {
    smallAnswerError.value = result.message || '暗号不正确'
    return
  }
  smallAnswer.value = ''
}

// 换成员 / 换视图即复位输入层：上一位成员的报错不该留到下一位身上
watch([selectedUserId, viewMode], () => {
  smallAnswer.value = ''
  smallAnswerError.value = ''
})

/** 在直播的房间数：列表头部一句话说明 */
const liveCount = ref(0)
watch(rooms, (list) => {
  liveCount.value = list.filter(room => room.live).length
  // 参数会在调用前求值，生产环境的 debugLog 是 no-op —— 用 dev 门控把整段构造成本挡掉
  if (import.meta.env.DEV) {
    debugLog('rooms-page', '获取频道列表完成', {
      count: list.length,
      liveCount: liveCount.value,
      hiddenRoomCount: hiddenRoomCount.value,
      rooms: list.map(room => ({
        userId: room.userId,
        nickname: room.nickname,
        serverId: room.serverId,
        channelId: room.channelId,
        liveId: room.live?.liveId ?? '',
        previewTime: room.previewTime,
      })),
    })
  }
}, { immediate: true })

watch([selectedUserId, chatStatus], ([userId, status]) => {
  if (!import.meta.env.DEV)
    return
  const room = rooms.value.find(item => item.userId === userId) ?? null
  debugLog('rooms-page', '频道详情状态更新', {
    userId,
    status,
    statusText: chatStatusText.value,
    messageCount: messages.value.length,
    room: room
      ? {
          userId: room.userId,
          nickname: room.nickname,
          serverId: room.serverId,
          channelId: room.channelId,
          liveId: room.live?.liveId ?? '',
          previewTime: room.previewTime,
        }
      : null,
  })
}, { immediate: true })

/** dev 调试：进入房间后打印归一化消息列表（仅 dev 生效，用来看消息格式与内容） */
watch(chatStatus, (status) => {
  if (status !== 'ready' || !import.meta.env.DEV)
    return
  // 深拷贝只该发生在 dev：生产环境 debugLog 是 no-op，JSON 往返纯属浪费
  debugLog('rooms-page', '进入房间获取的消息列表', JSON.parse(JSON.stringify(messages.value)))
})
// ===== 消息流自动滚底 =====
// 切房强制回底（新房子的滚动位置没有意义）；同房新消息且本就贴在底部时才拽回，
// 上翻看历史不强行打断；翻更早历史时保持视口（新消息插在头部，贴回去等于白翻）
//
// atBottom 是「钉底」开关而非纯几何判断：内容增长（懒加载图片/视频撑高）只改
// scrollHeight 不改 scrollTop，不能据此判定用户上滚 —— 否则贴底后异步派发的
// scroll 事件会拿「已长高」的 scrollHeight 把钉底误判成离开底部，媒体补贴底
// 全被拦住，进房就停在了半空。onListScroll 只在 scrollTop 相对上次变小时退钉。
const listRef = ref<HTMLElement | null>(null)
const atBottom = ref(true)
/** 上次滚动位置：-1 = 尚未建立基线（切房重置），用于识别用户上滚 */
let lastSeenScrollTop = -1
/** 翻历史中：抑制 length 监听的回底，改由 onLoadMore 显式保持视口 */
let preservingScroll = false

/** 上翻历史时收到的新消息数：浮标提示用，回底 / 切房清零 */
const newCount = ref(0)

function onListScroll() {
  const el = listRef.value
  if (!el)
    return
  const prevSeen = lastSeenScrollTop
  const wasAtBottom = atBottom.value
  lastSeenScrollTop = el.scrollTop
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  // scrollTop 相对上次变小才是用户真的上滚，才允许退出钉底；
  // 仅 scrollHeight 变大（媒体撑高、追加消息）保持钉底，由媒体回调继续补贴底
  if (!nearBottom && prevSeen >= 0 && el.scrollTop < prevSeen - 1) {
    atBottom.value = false
    // 用户自己上翻去找未读，胶囊让位（分割线还在，不重复挡视线）
    unreadJumped.value = true
  }
  else if (nearBottom) {
    atBottom.value = true
  }
  // 回到底部即清空新消息计数
  if (atBottom.value) {
    newCount.value = 0
    // 上翻后回到底部即补标（贴底即已读，与 length 监听同口径）；只在刚回底这一刻标，
    // 停在底部时新消息由 length 监听管
    if (!wasAtBottom && docVisibility.value === 'visible' && entryMarkDepth === 0
      && selectedUserId.value !== null && messages.value.length) {
      void markRoomRead(selectedUserId.value, viewMode.value)
    }
  }
  // 贴近顶部自动翻更早历史；加载中 / 已到头 / 上一次还在恢复视口时不触发。
  // 加载完视口按插入增量下移（scrollTop>0），用户再上滚才会继续翻，不会连环拉满
  if (!preservingScroll && el.scrollTop < 60 && !loadingMore.value && !historyExhausted.value)
    void onLoadMore()
}

/** 回底：所有程序化贴底统一走这里，同步 lastSeenScrollTop 供 onListScroll 判定 */
function scrollToBottom() {
  const el = listRef.value
  if (!el)
    return
  el.scrollTop = el.scrollHeight
  lastSeenScrollTop = el.scrollTop
}

/** 分割线在视口内时浮标让位；交点状态只由 observer 写，元素卸载用 DOM ref 兜底，避免残留 true 压住新锚点 */
const unreadAnchorIntersecting = ref(false)
useIntersectionObserver(
  unreadAnchorEl,
  ([entry]) => { unreadAnchorIntersecting.value = entry?.isIntersecting === true },
  // 上下各留 24px：线只贴边露出一点时仍保留跳转入口
  { root: listRef, rootMargin: '-24px 0px' },
)
const unreadAnchorVisible = computed(() => unreadAnchorEl.value !== null && unreadAnchorIntersecting.value)

/** 跳转后分割线距视口顶的比例：上方留一点旧消息作上下文，其余空间都给新消息 */
const UNREAD_ANCHOR_TOP_RATIO = 0.25

/** 跳到未读分割线：只滚消息容器，把线落在视口上部，胶囊随即让位（分割线留着做视觉标记） */
function jumpToUnread() {
  unreadJumped.value = true
  const el = listRef.value
  const anchor = unreadAnchorEl.value
  if (!el || !anchor)
    return
  const anchorTop = el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
  el.scrollTo({
    top: Math.max(0, anchorTop - el.clientHeight * UNREAD_ANCHOR_TOP_RATIO),
    behavior: 'smooth',
  })
}

/** 左列条目：进房、双击回底、右键标已读都没有文字入口，靠 hover 说明 */
function roomItemHint(room: PocketRoom): string {
  const hints = [`进入「${room.nickname}」的房间`]
  if (room.userId === selectedUserId.value)
    hints.push('双击回到最新消息')
  if (unreadCountOf(room.userId))
    hints.push('右键置顶 / 标为已读')
  else
    hints.push('右键置顶')
  return hints.join(' · ')
}

/**
 * 双击左列房间条目：若正是当前房间，消息流立即钉回底部
 * （其他房间双击时单击已先选中、进房流程本身会回底，无需额外处理）。
 */
function onRoomWrapDblClick(room: PocketRoom, event: MouseEvent) {
  // 临时房间的关闭钮不参与：双击关闭钮误触回底没有意义
  if ((event.target as HTMLElement).closest('.room-temp-close'))
    return
  if (room.userId === selectedUserId.value)
    scrollToBottom()
}

/**
 * 进入大房间视图的收尾（点左列条目、点大房间页签共用）：进房即清该成员**大房间**的
 * 未读（Tab 级计数移交房间页），小房间未读保留、留给它自己的页签入口。
 * 首屏加载失败不清——用户没看到消息，角标留到重进或重试。
 * 首屏空页分两种：房间确已关闭（room/info 无留言板）或「全部消息」档也空，才当真没有内容；
 * 「只看房主」档的空页可能只是房主没发过言，粉丝发言在「全部消息」里，不能凭它清零。
 * 进房前有未读时加载完成强制回底，避免「角标没了但新消息还在上面」；
 * 未读为 0 时交给消息流自身的贴底逻辑（同房重进不重拉，位置保留）。
 *
 * unreadCount 传条数：锚点要用它，而 markRoomRead 会乐观清零，之后只剩 0。
 */
async function settleBigRoomEnter(userId: number, unreadCount: number) {
  // 加载失败：未读保留，留到下次进房成功再清
  if (chatStatus.value !== 'ready') {
    unreadAnchor.value = null
    return
  }
  const hasContent = messages.value.length > 0
  // 空页且确实没有可读内容：不画未读分割线（列表里无处可落），但角标要清
  const emptyRoom = !hasContent && (roomClosed.value || messageScope.value === 'all')
  if (!hasContent && !emptyRoom) {
    unreadAnchor.value = null
    return
  }
  await markRoomReadCapturing(userId, 'room', hasContent ? unreadCount : 0)
  if (unreadCount <= 0 || !hasContent)
    return
  // 收尾期间已切房：不能把新房间的列表拽到底部
  if (selectedUserId.value !== userId)
    return
  await nextTick()
  scrollToBottom()
}

/** 点进房间（左列条目）：选中 → 清大房间未读（有未读则回底） */
async function enterRoom(userId: number) {
  trackRoomEnter(userId, 'list')
  // 未读数在 markRoomRead 乐观清零前取，否则永远是 0
  const hadUnread = unreadChannelOf(userId).big
  // 换房先撤掉上一间的分割线：消息清空与水位重取之间有间隙，别让旧锚点落回新列表
  unreadAnchor.value = null
  unreadJumped.value = false
  // 收尾在途时压住贴底监听，锚点要截在第一趟清零之前
  beginEntryMark()
  try {
    await selectRoom(userId)
    await settleBigRoomEnter(userId, hadUnread)
  }
  finally {
    endEntryMark()
  }
}

/**
 * 临时房间的边界就是这条路由 query：成员详情卡底栏入口 push `/rooms?member=<userId>`，
 * query 一旦消失（Dock 切回房间页、走别的入口）即撤掉临时条目——离开页面就不再保留。
 * 成员不在关注名单里也照样打开，这正是「临时」的用途（不写关注名单、不落盘）。
 */
watch(() => route.query.member, async (value) => {
  const userId = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isFinite(userId) || userId <= 0) {
    closeTemporaryRoom()
    return
  }
  const result = await openTemporaryRoom(userId)
  if (result.ok) {
    // 深链进房与左列共用每日去重
    trackRoomEnter(userId, 'query')
    return
  }
  // 失败单独记，不占每日去重额度
  trackEvent('rooms:enter', { from: 'query', result: 'fail' })
  ElMessage.warning(result.message || '未能打开该成员的大房间')
}, { immediate: true })

/** 左列关掉临时房间：一并清掉 query。否则 URL 还留着这个成员，下次点同一个入口不触发 watch */
function closeTempRoom() {
  closeTemporaryRoom()
  if (route.query.member)
    void router.replace({ path: '/rooms' })
}

watch(selectedUserId, () => {
  atBottom.value = true
  newCount.value = 0
  // 重置滚动基线：切房清空旧内容时浏览器钳制 scrollTop，会触发一次「向上」的
  // scroll 事件 —— 不是用户上滚，不能据此退钉
  lastSeenScrollTop = -1
  // 折叠 / 到达高亮都是「这一屏」的状态，换房即复位
  resetCardState()
})

watch(() => messages.value.length, async (len, oldLen) => {
  // 内容增删都会改变折行与「是否超长」，统一在这条监听里重新测量长文
  // （含翻历史 prepend 的旧消息——它们同样可能触发折叠）
  void nextTick(measureLongText)
  // 翻更早历史：视口由 onLoadMore 保持，prepend 不计入新消息
  if (preservingScroll)
    return
  if (!atBottom.value) {
    // 上翻浏览历史时来了新消息：只计数，不打断
    if (oldLen !== undefined && len > oldLen)
      newCount.value += len - oldLen
    return
  }
  newCount.value = 0
  // 贴底浏览即已读：主进程清当前视图频道未读并对齐基线，广播后角标同步消失；上翻不标记。
  // 收尾在途时让位（见 entryMarkDepth）；窗口隐藏期间不标——用户看不见，静默清零等于吞掉
  // 未读，回显时由 docVisibility 监听补标
  if (docVisibility.value === 'visible' && entryMarkDepth === 0 && selectedUserId.value !== null && messages.value.length)
    void markRoomRead(selectedUserId.value, viewMode.value)
  await nextTick()
  scrollToBottom()
})

/**
 * 回显补标：隐藏期间贴底到的消息先攒着未读（见 length 监听），回显时消息已在视口里，
 * 按「贴底即已读」补一次标记。上翻中（!atBottom）不补——那正是没看完的样子。
 */
watch(docVisibility, (visibility) => {
  if (visibility !== 'visible')
    return
  if (entryMarkDepth > 0 || selectedUserId.value === null || !messages.value.length || !atBottom.value)
    return
  void markRoomRead(selectedUserId.value, viewMode.value)
})

/**
 * 媒体加载后重新贴底：图片/视频在 length 监听滚底时高度还是 0（lazy / preload=metadata），
 * 加载完成内容变高会把底部「拽」下去，导致选房后停在不贴底的位置——
 * 且 onListScroll 会把 atBottom 置 false，之后再也不自动回底。
 * 所以媒体加载完成（成功或失败，占位高度都可能变）且仍贴底时补一次贴底；
 * 用户已上翻（atBottom=false）则不打扰。
 */
function onMediaLoad() {
  if (preservingScroll || !atBottom.value)
    return
  scrollToBottom()
}

async function onLoadMore() {
  const el = listRef.value
  if (!el) {
    await loadMoreHistory()
    return
  }
  const prevHeight = el.scrollHeight
  const prevTop = el.scrollTop
  preservingScroll = true
  try {
    await loadMoreHistory()
  }
  finally {
    preservingScroll = false
  }
  await nextTick()
  // 头部插入了 prevHeight → scrollHeight 的增量，视口按同样增量下移，肉眼位置不变
  el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  lastSeenScrollTop = el.scrollTop
  // 本次上翻才发现到头才提示（此后 onListScroll 不再触发，天然只出一次）
  if (historyExhausted.value)
    ElMessage.info('没有更早的消息了')
}

/**
 * 未读补页的一页：与 onLoadMore 只差视口策略——贴底时保持贴底（与进房回底并行时，
 * 视口换算会把人拽回旧位置），上翻中按插入增量保持视口；不弹到头提示。
 */
async function fillLoadPage() {
  const el = listRef.value
  if (!el) {
    await loadMoreHistory()
    return
  }
  const stickBottom = atBottom.value
  const prevHeight = el.scrollHeight
  const prevTop = el.scrollTop
  preservingScroll = true
  try {
    await loadMoreHistory()
  }
  finally {
    preservingScroll = false
  }
  await nextTick()
  if (stickBottom && atBottom.value) {
    scrollToBottom()
    return
  }
  el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  lastSeenScrollTop = el.scrollTop
}

/**
 * 未读补页（触顶兜底）：`unreadIndex === 0` 说明水位那条沉在已加载窗口外（未读 ≥ 一页）。
 * 循环补拉更早历史把它补进窗口，分割线落到真实边界、条数一并精确；补满上限仍在窗口外
 * 则标记 `beyond`、文案降级（继续上翻补进后恢复）。
 * 锚点对象身份即令牌：换房 / 重进换了锚点即作废在途补页。
 */
const UNREAD_FILL_MAX_PAGES = 4
let fillRunningFor: typeof unreadAnchor.value = null

async function fillUnreadWindow() {
  const anchor = unreadAnchor.value
  if (!anchor || fillRunningFor === anchor)
    return
  fillRunningFor = anchor
  try {
    for (let page = 0; page < UNREAD_FILL_MAX_PAGES; page++) {
      if (unreadAnchor.value !== anchor || unreadIndex.value !== 0)
        return
      const before = messages.value.length
      await fillLoadPage()
      if (unreadAnchor.value !== anchor || unreadIndex.value !== 0)
        return
      // 到头：全部历史已在窗口里，「以下是 N 条」就是真实条数，不降级
      if (historyExhausted.value)
        return
      // 无进展（加载失败 / 别的加载在途）：不误判不空转，保持原文案
      if (messages.value.length === before)
        return
    }
    // 补满上限，水位仍在窗口外：真实起点在更早，文案降级
    if (unreadAnchor.value === anchor && unreadIndex.value === 0)
      unreadAnchor.value = { ...anchor, beyond: true }
  }
  finally {
    if (fillRunningFor === anchor)
      fillRunningFor = null
  }
}

// 分割线钉到窗口顶（unreadIndex 归 0）即补页；空列表先停在 -1，首屏到达后自然触发
watch(unreadIndex, (index) => {
  if (index === 0)
    void fillUnreadWindow()
})

/** 头像 URL：口袋扩展给的是相对/完整路径混杂，统一过 sourceUrl */
function avatarUrl(avatar: string) {
  return avatar ? Tools.sourceUrl(avatar) : ''
}

/**
 * 是否当前房间的房主本人。
 * `isMember` 只表示「发言者是成员（roleId>1）」——「全部消息」档下其他成员串门发言
 * 也满足该条件，标成「房主」是错的，这里按 userId 与房间成员比对区分。
 */
function isRoomOwner(message: PocketRoomMessageView): boolean {
  return selectedUserId.value !== null && message.userId === String(selectedUserId.value)
}

// ===== 长文折叠：成员小作文超过 10 行先收起来 =====
/** 折叠行数：注入 CSS 变量 --collapse-lines，由 .msg-text.is-clamped 按行高换算成 max-height */
const COLLAPSE_LINES = 10

/**
 * 判定为超长的消息 id。只登记不撤销：展开态没有高度截断，再量一次会「量不到溢出」，
 * 把刚点开的「收起」按钮判没。登记表每轮整体重建，顺带清掉已不在列表里的旧 id。
 */
const longTextIds = ref<Set<string>>(new Set())
/** 已展开全文的消息 id：只在内存，切房即复位（换个人没必要继承上一位的阅读状态） */
const expandedTextIds = ref<Set<string>>(new Set())

/** 该条正文是否处于收起态（超长且未展开） */
function isLongTextClamped(id: string): boolean {
  return longTextIds.value.has(id) && !expandedTextIds.value.has(id)
}

function toggleLongText(id: string) {
  const next = new Set(expandedTextIds.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expandedTextIds.value = next
}

/**
 * 量一遍已渲染的正文高度，超出折叠行数的登记为超长。
 * 收起态用 max-height 截断，scrollHeight 仍是完整内容高度 —— 反复量结果稳定，
 * 不会「量一次收起来、再量就不是超长」地来回抖。
 */
function measureLongText() {
  const root = listRef.value
  if (!root)
    return
  const next = new Set<string>()
  root.querySelectorAll<HTMLElement>('.msg-text').forEach((el) => {
    const id = el.dataset.msgId
    if (!id)
      return
    if (longTextIds.value.has(id) || el.scrollHeight > el.clientHeight + 1)
      next.add(id)
  })
  if (next.size === longTextIds.value.size && [...next].every(id => longTextIds.value.has(id)))
    return
  longTextIds.value = next
}

// 列宽变化会改变折行数，只有窗口缩放会把列宽改掉（右栏固定宽、聊天区自适应）；
// 内容变化的触发点收在 messages 的 length 监听里（与贴底逻辑同一条），两个入口覆盖
// 全部「需要重量」的时机
const measureLongTextDebounced = useDebounceFn(measureLongText, 150)
useEventListener(window, 'resize', measureLongTextDebounced)

// ===== 新消息到达高亮（只贴底时）=====
/** 时长同时注入 CSS 变量：动画与类移除同一节拍，不会闪到一半被掐 */
const ARRIVE_FLASH_MS = 1200
/** 待高亮的消息 id */
const arrivingIds = ref<Set<string>>(new Set())
let arrivingTimer: ReturnType<typeof setTimeout> | undefined

function flashArrivals(ids: string[]) {
  const next = new Set(arrivingIds.value)
  for (const id of ids)
    next.add(id)
  arrivingIds.value = next
  if (arrivingTimer)
    clearTimeout(arrivingTimer)
  arrivingTimer = setTimeout(() => {
    arrivingIds.value = new Set()
    arrivingTimer = undefined
  }, ARRIVE_FLASH_MS)
}

/**
 * 上一条消息 id：只有「它仍在列表里」才把其后的消息当作新到。
 * 切房与换消息范围都先 clearChat（列表清空 → 记为 null），翻更早历史插在头部，
 * 三者都不会误判成「新到」；上翻浏览历史时不打扰阅读，交给浮标计数。
 */
let tailMessageId: string | null = null

watch(messages, (list) => {
  const prevTail = tailMessageId
  tailMessageId = list.length ? list[list.length - 1].id : null
  if (!prevTail || !atBottom.value)
    return
  const index = list.findIndex(item => item.id === prevTail)
  if (index < 0)
    return
  const appended = list.slice(index + 1)
  if (appended.length)
    flashArrivals(appended.map(item => item.id))
}, { flush: 'post' })

// ===== 发言输入条（确认连接后在消息区底部常驻）=====
/** 输入草稿；发送成功即清空 */
const draft = ref('')

/** 输入条可见条件：已登录 + 选中房间 + 消息就绪 + 不在小房间暗号锁定态。
 * 连接状态不影响可见性——未连接也要把输入条摆出来，点它才引导连接。
 * 房间禁言 / 未关注也不隐藏：要让用户看到「为什么说不了话」，而不是输入框凭空消失。
 * 房间已关闭则隐藏：没有留言板，禁言文案（「房主已开启全员禁言」）在这里是错的。
 */
const composerVisible = computed(() =>
  loggedIn.value
  && !!selectedRoom.value
  && chatStatus.value === 'ready'
  && !smallLocked.value
  && !roomClosed.value,
)

/**
 * 发言阻断原因（房间级不可发言的唯一判定口）：
 * unfollowed = 该成员不在口袋账号关注里（只有本地名单或临时房间），服务端不接受发言；
 * muted = 房主开了房间级禁言（room/info 的 userFunction.sendText === false）。
 * null = 可发言，剩下的只看连接与冷却。
 */
const speakBlock = computed<'unfollowed' | 'muted' | null>(() => {
  if (!composerVisible.value)
    return null
  // 口袋关注拉取失败时所有房间的来源都退化成 local，此时无从判断真实关注关系，
  // 不拦（否则整页误禁言），交给服务端拒
  if (!pocketFollowError.value && !isPocketFollowed(selectedRoom.value?.followSource))
    return 'unfollowed'
  return canSpeak.value ? null : 'muted'
})

const composerMuted = computed(() => speakBlock.value === 'muted')

/** 阻断提示节流：反复点输入框时只每 3s 提示一次，不堆一屏 toast */
let speakBlockToastAt = 0

/** 输入条可交互（不含连接状态）：阻断态直接不可交互；未连接时点发送钮给出状态提示 */
const composerUsable = computed(() =>
  composerVisible.value
  && !speakBlock.value
  && !sendBusy.value
  && sendCooldownLeft.value === 0,
)

/** 可发送：连接就绪 + 不在发送中 / 冷却中（主进程同口径限流是最终防线） */
const canSend = computed(() =>
  composerUsable.value
  && qchatStatus.value === 'connected',
)

/** 占位文案即状态：未就绪时只提示连接 / 重连，不给点击引导 */
const composerPlaceholder = computed(() => {
  if (!composerVisible.value)
    return ''
  // 阻断原因优先于连接状态：连接了也发不出去，别让文案引导用户等连接
  if (speakBlock.value === 'unfollowed')
    return '请关注后发言'
  if (speakBlock.value === 'muted')
    return '暂时不能发言'
  if (sendBusy.value)
    return '正在发送…'
  if (sendCooldownLeft.value > 0)
    return `发送冷却中（${Math.ceil(sendCooldownLeft.value / 1000)}s）…`
  if (qchatStatus.value === 'connecting')
    return '正在连接房间…'
  if (qchatStatus.value === 'reconnecting')
    return qchatHint.value || '连接断开，正在重连…'
  if (qchatStatus.value !== 'connected')
    return qchatHint.value || '房间未连接，暂不能发言'
  return '说点什么…'
})

/** 发送钮文案：发送中 / 冷却倒数 / 发送 */
const sendButtonLabel = computed(() => {
  if (sendBusy.value)
    return '发送中'
  if (sendCooldownLeft.value > 0)
    return `${Math.ceil(sendCooldownLeft.value / 1000)}s`
  return '发送'
})

const composerEl = ref<InstanceType<typeof RoomComposer> | null>(null)
/** 量高度用：输入条已抽成组件，取它的根元素（.chat-composer） */
const composerRef = computed(() => (composerEl.value?.$el as HTMLElement | undefined) ?? null)
const composerHeight = ref(0)

/** 发送钮 hover：说明倒数与禁用原因，这些状态不写在按钮文字里 */
const sendButtonHint = computed(() => {
  if (speakBlock.value === 'unfollowed')
    return '该成员未在口袋账号关注，关注后才能发言'
  if (speakBlock.value === 'muted')
    return '全员禁言，暂不能发言'
  if (sendBusy.value)
    return '正在发送消息'
  if (sendCooldownLeft.value > 0)
    return `发言冷却中，${Math.ceil(sendCooldownLeft.value / 1000)}s 后可继续发送`
  if (qchatStatus.value !== 'connected')
    return '房间连接未就绪，暂不能发送'
  return '发送消息（也可按 Enter）'
})

/** 阻断态点输入框：只解释原因，不发请求 */
function noticeSpeakBlock(): void {
  const block = speakBlock.value
  if (!block || Date.now() - speakBlockToastAt < 3000)
    return
  speakBlockToastAt = Date.now()
  ElMessage.info(block === 'unfollowed'
    ? '该成员未在口袋账号关注，关注后才能发言'
    : '房主已开启全员禁言，暂时不能发言')
}

/** 点输入框：阻断态只解释原因（连接随进房自动建立） */
function onComposerClick(): void {
  if (speakBlock.value)
    noticeSpeakBlock()
}

/** Enter 发送；组词中的 Enter 是拼音选字，不是确认 */
function onDraftEnter(event: KeyboardEvent) {
  if (event.isComposing)
    return
  void onSendClick('enter')
}

async function onSendClick(via: 'enter' | 'button') {
  if (!composerUsable.value)
    return
  if (!canSend.value) {
    // 连接随进房建立：只在尚未就绪时解释一句
    if (qchatStatus.value !== 'connected') {
      const fallback = qchatStatus.value === 'disconnected'
        ? '房间未连接，暂不能发言'
        : '房间正在连接，请稍候'
      ElMessage.info(qchatHint.value || fallback)
    }
    return
  }
  const text = draft.value.trim()
  if (!text)
    return
  const result = await sendMessage(text)
  trackEvent('room:send', {
    result: result.ok ? 'ok' : 'fail',
    via,
    hasReply: replyTarget.value ? 'yes' : 'no',
  })
  if (result.ok) {
    draft.value = ''
    return
  }
  if (result.message)
    ElMessage.error(result.message)
}

/** 删除自己消息：破坏性操作二次确认，成功后本地摘除（主进程已删） */
async function confirmDeleteOwn(message: PocketRoomMessageView) {
  try {
    await ElMessageBox.confirm('删除后所有人都看不到这条消息，确定删除吗？', '删除消息', {
      type: 'warning',
      customClass: 'app-confirm',
      modalClass: 'detail-card-overlay',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  }
  catch {
    // 用户取消：安静退出，不弹错误
    return
  }
  const result = await deleteOwnMessage(message)
  if (result.ok)
    ElMessage.success('消息已删除')
  else
    ElMessage.error(result.message || '删除失败')
}

// 输入条高度联动「新消息浮标」：浮标贴在输入条上方，不挡住发送钮。
useResizeObserver(
  composerRef,
  (entries) => {
    composerHeight.value = entries[0]?.borderBoxSize?.[0]?.blockSize
      ?? entries[0]?.contentRect.height
      ?? 0
  },
  { box: 'border-box' },
)
const newMsgFloatStyle = computed(() => ({
  bottom: `${12 + (composerVisible.value ? composerHeight.value : 0)}px`,
}))

// ===== 复制（hover 按钮 + 右键菜单）=====
/** 右键菜单的目标：消息（回复 / 复制 / 删除）或左列房间条目（置顶 / 标已读） */
type RoomMenuTarget
  = | { kind: 'message', message: PocketRoomMessageView }
    | { kind: 'room', room: PocketRoom }

/**
 * 右键菜单的唯一状态：光标位置 + 目标。两类菜单共用一个 ref，
 * 「同时只开一个」由赋值天然成立，不再靠两套 close 互相调用来维持。
 */
const menu = ref<{ x: number, y: number, target: RoomMenuTarget } | null>(null)

/** 复制项的文案与图标：清单本身（有哪些可复制）在归一层，这里只贴 UILabel */
const COPY_ITEMS: Record<PocketRoomCopyKey, { label: string, icon: Component }> = {
  text: { label: '复制文字', icon: DocumentCopy },
  image: { label: '复制图片链接', icon: Picture },
  audio: { label: '复制语音链接', icon: Microphone },
  video: { label: '复制视频链接', icon: VideoCamera },
}

/** 右键菜单项：danger 只影响配色（删除是破坏性操作，与普通动作分开） */
interface RoomMenuItem {
  key: string
  label: string
  icon: Component
  danger?: boolean
}

function copyMenuItems(message: PocketRoomMessageView): RoomMenuItem[] {
  return pocketRoomCopyTargets(message).map(item => ({ key: item.key, ...COPY_ITEMS[item.key] }))
}

/**
 * 消息菜单全量项：回复 → 复制 → 删除。
 * 回复 / 删除的 eligibility 在归一层（canReplyMessage / canDeleteMessage）：
 * 别人发的文本类消息可回复，自己发的才可删（服务端也只允许删自己的）。
 */
function messageMenuItems(message: PocketRoomMessageView): RoomMenuItem[] {
  const items: RoomMenuItem[] = []
  if (canReplyMessage(message))
    items.push({ key: 'reply', label: '回复', icon: ChatDotRound })
  items.push(...copyMenuItems(message))
  if (canDeleteMessage(message))
    items.push({ key: 'delete', label: '删除', icon: Delete, danger: true })
  return items
}

/** 当前该展示哪一组项：两类目标各自成组，模板只读这一处 */
const menuItems = computed<RoomMenuItem[]>(() => {
  const current = menu.value
  if (!current)
    return []
  return current.target.kind === 'message'
    ? messageMenuItems(current.target.message)
    : roomMenuItems(current.target.room)
})

/** hover 复制按钮的文案；空串 = 这条没有可复制内容，按钮不渲染（如系统通知、投票） */
function copyHint(message: PocketRoomMessageView): string {
  const first = pocketRoomCopyTargets(message)[0]
  return first ? COPY_ITEMS[first.key].label : ''
}

/** 复制并如实反馈：剪贴板被拒时静默会让人以为按钮坏了 */
async function runCopy(key: PocketRoomCopyKey, message: PocketRoomMessageView) {
  const target = pocketRoomCopyTargets(message).find(item => item.key === key)
  if (!target)
    return
  const ok = await copyText(target.text)
  if (ok)
    ElMessage.success(`已${COPY_ITEMS[key].label}`)
  else
    ElMessage.error(`${COPY_ITEMS[key].label}失败`)
}

/** hover 按钮：复制该条的首选内容（有正文复制正文，媒体消息退化为直链） */
function copyPrimary(message: PocketRoomMessageView) {
  const first = pocketRoomCopyTargets(message)[0]
  if (first)
    void runCopy(first.key, message)
}

/**
 * 打开菜单（唯一入口）：消息没有可回复 / 可复制 / 可删除的动作时不弹（系统通知、投票等），
 * 房间条目恒可弹——置顶是常规操作。
 */
function openMenu(event: MouseEvent, target: RoomMenuTarget) {
  if (target.kind === 'message') {
    const message = target.message
    if (!canReplyMessage(message) && !canDeleteMessage(message) && !pocketRoomCopyTargets(message).length)
      return
  }
  menu.value = { x: event.clientX, y: event.clientY, target }
}

function closeMenu() {
  menu.value = null
}

/** 动作分发：先关菜单再执行，动作里再触发右键时不会新旧状态叠加 */
function onMenuPick(key: string) {
  const current = menu.value
  menu.value = null
  if (!current)
    return
  const { target } = current
  if (target.kind === 'room') {
    if (key === 'pin' || key === 'unpin') {
      onToggleRoomPin(target.room.userId, 'menu')
      return
    }
    void markRoomRead(target.room.userId, key === 'read-small' ? 'small' : 'room')
    return
  }
  if (key === 'reply') {
    startReply(target.message)
    void nextTick(() => composerEl.value?.focus())
    return
  }
  if (key === 'delete') {
    void confirmDeleteOwn(target.message)
    return
  }
  void runCopy(key as PocketRoomCopyKey, target.message)
}

/** 消息右键：模板已 .prevent，这里只走一次入口 */
function openMessageMenu(event: MouseEvent, message: PocketRoomMessageView) {
  openMenu(event, { kind: 'message', message })
}

// ===== 左列房间条目的右键菜单 =====
// 两件事：置顶 / 取消置顶（展示顺序），以及未读的手动出口。
// 未读出口的由来：进房清零要求首屏消息加载成功（见 settleBigRoomEnter），频道失效 / 空页时
// 那条路走不通，角标会一直挂着；右键直接标已读是这类房间当前唯一的手动出口。

// ===== 左列房间条目的右键菜单 =====
// 两件事：置顶 / 取消置顶（展示顺序），以及未读的手动出口。
// 未读出口的由来：进房清零要求首屏消息加载成功（见 settleBigRoomEnter），频道失效 / 空页时
// 那条路走不通，角标会一直挂着；右键直接标已读是这类房间当前唯一的手动出口。
// 菜单状态与消息菜单共用上面那一个 menu，动作在 onMenuPick 里按 target.kind 分流。

/**
 * 图钉（MediaIcon 实心壳）：菜单只接受组件，这里把 name 固定住；
 * 列标记与菜单共用同一枚，避免「同一个概念两套图标语言」。
 */
const PinIcon = () => h(MediaIcon, { name: 'pushpinFilled' })

/** 置顶恒有；未读按分部各给一条：大 / 小房间是两个独立频道，进哪个清哪个 */
function roomMenuItems(room: PocketRoom): RoomMenuItem[] {
  const pinned = isRoomPinned(room.userId)
  const items: RoomMenuItem[] = [
    pinned
      ? { key: 'unpin', label: '取消置顶', icon: PinIcon }
      : { key: 'pin', label: '置顶', icon: PinIcon },
  ]
  const unread = unreadChannelOf(room.userId)
  if (unread.big > 0)
    items.push({ key: 'read-room', label: '大房间标为已读', icon: Check })
  if (unread.small > 0)
    items.push({ key: 'read-small', label: '小房间标为已读', icon: Check })
  return items
}

/** 右键必定接管：置顶是常规操作，不再只在有未读时才弹菜单 */
function onRoomContextMenu(room: PocketRoom, event: MouseEvent) {
  event.preventDefault()
  openMenu(event, { kind: 'room', room })
}

// 页面切走（keep-alive 只停用不销毁）：右键菜单挂在 body 上，不关会盖住别的页面
onDeactivated(resetCardState)

/**
 * 折叠 / 到达高亮 / 右键菜单的整块复位：换房与页面切走共用。
 * 待高亮的定时器一并清掉，避免它在新房间的列表上把 id 撞亮。
 */
function resetCardState() {
  longTextIds.value = new Set()
  expandedTextIds.value = new Set()
  arrivingIds.value = new Set()
  if (arrivingTimer) {
    clearTimeout(arrivingTimer)
    arrivingTimer = undefined
  }
  closeMenu()
}

// ===== 引用块 =====
// 引用块只读展示「谁 + 说了什么」摘要：回复类是被回复者 + 被引用内容，翻牌是被翻提问
// （昵称位固定「提问」）。不做点击跳转——被引用消息往往不在当前列表，跳转价值有限。

/**
 * 视频尺寸占位：服务端 bodys 带真实 w/h（实测竖屏 w=1080/h=1920）。
 * 横屏沿用 280px 宽上限、按真实比例出高；竖屏高度封顶 360px（小窗再按视口收缩）、
 * 宽度按比例收——两维都显式算出，不赌 aspect-ratio 对 block 尺寸的解析。
 * 无尺寸（视频翻牌等）返回 undefined，回退 .msg-video 默认 16:9 占位。
 */
function videoBoxStyle(message: PocketRoomMessageView) {
  if (!message.videoWidth || !message.videoHeight)
    return undefined
  if (message.videoWidth >= message.videoHeight)
    return { aspectRatio: `${message.videoWidth} / ${message.videoHeight}`, width: 'min(280px, 100%)' }
  const height = 'min(360px, 50vh)'
  return { height, width: `calc(${height} * ${(message.videoWidth / message.videoHeight).toFixed(4)})` }
}

/** 消息时刻（HH:mm:ss） */
function messageTime(msgTime: number) {
  return msgTime ? dayjs(msgTime).format('HH:mm:ss') : ''
}

/**
 * 当前已加载消息的图片列表（时间序）：点开任一张后可在整个列表内左右切换，与右侧相册同一范围。
 * 预览列表在打开 viewer 时快照，翻历史追加不影响已打开的预览。
 */
const messageImageUrls = computed(() =>
  messages.value
    .filter(message => message.imageUrl)
    .map(message => message.imageUrl as string),
)

/** 与 messageImageUrls 严格同序：预览左右切换后按 activeIndex 取当前这张的命名元数据 */
const messageImageMetas = computed(() =>
  messages.value
    .filter(message => message.imageUrl)
    .map(message => ({ nickname: message.nick, timestamp: message.msgTime })),
)

/**
 * 消息 id → 在预览列表中的下标。
 * 不能按 URL 反查：同一条图片被转发两次时 indexOf 恒指第一张，点第二张会从第一张开始看。
 */
const messageImageIndex = computed(() => {
  const map = new Map<string, number>()
  let index = 0
  for (const message of messages.value) {
    if (!message.imageUrl)
      continue
    map.set(message.id, index)
    index += 1
  }
  return map
})

/** 短时刻（MM-DD HH:mm）：直播分享卡的时刻行 */
function shortTime(ts: number | string) {
  return ts ? dayjs(ts).format('MM-DD HH:mm') : ''
}

/** 分隔线文案：今天 / 昨天 / 本年 M月D日 / 跨年 YYYY年M月D日 */
function dayLabel(msgTime: number): string {
  const day = dayjs(msgTime)
  const now = dayjs()
  if (day.isSame(now, 'day'))
    return '今天'
  if (day.isSame(now.subtract(1, 'day'), 'day'))
    return '昨天'
  return day.year() === now.year() ? day.format('M月D日') : day.format('YYYY年M月D日')
}

/** 相邻两条消息间隔超过它才插时刻分隔：按 IM 惯例取 5 分钟（成员的发言本来就是一阵一阵的） */
const TIME_GAP_MS = 5 * 60 * 1000

/**
 * 分隔条预计算：消息下标 → 文案。跨天用日期（今天/昨天/M月D日），同一天内断档超过
 * TIME_GAP_MS 用时刻（HH:mm）。两条都满足时日期优先——断档文案跨天时没有信息量。
 *
 * 一次性 O(n) 算好给模板 O(1) 查表：逐条在模板里判断要对每条消息做两次 dayjs 解析，
 * 翻历史一页上百条、且每次重渲染都要重算。
 */
const dividerMap = computed(() => {
  const map = new Map<number, string>()
  const list = messages.value
  let prevTime = 0
  let prevDay = ''
  for (let index = 0; index < list.length; index += 1) {
    const msgTime = list[index]?.msgTime ?? 0
    // 没有 msgTime 的消息无法归日/比间隔：跳过且不推进基线（否则会渲染出 1970 年的假日期）
    if (!msgTime)
      continue
    const day = dayjs(msgTime).format('YYYY-MM-DD')
    if (!prevTime || day !== prevDay)
      map.set(index, dayLabel(msgTime))
    else if (msgTime - prevTime > TIME_GAP_MS)
      map.set(index, dayjs(msgTime).format('HH:mm'))
    prevTime = msgTime
    prevDay = day
  }
  return map
})

/**
 * 直播分享卡角标（类型语义对齐 LiveItem）：回放 > 录屏 > 电台 > 直播。
 * 在播与否优先于 liveType：分享消息本身不带可靠回放标记（yaya_msg 同款），
 * 以当前直播列表判定——liveId 不在播即回放；列表未拉到（null）时按 liveType 兜底展示。
 */
function liveCardBadge(message: PocketRoomMessageView): { text: string, type: 'live' | 'screen' | 'radio' | 'playback' } {
  if (message.liveIsPlayback || isSharedLiveOnAir(message.liveId) === false)
    return { text: '回放', type: 'playback' }
  if (message.liveType === 1)
    return message.liveMode === 1 ? { text: '录屏', type: 'screen' } : { text: '直播', type: 'live' }
  if (message.liveType === 2)
    return { text: '电台', type: 'radio' }
  return { text: '直播', type: 'live' }
}

/** 分享卡 hover：点击打开的是独立播放窗，直播与回放走不同窗口 */
function liveCardHint(message: PocketRoomMessageView): string {
  if (!message.liveId)
    return '这条分享没有可播放的直播或回放'
  const playback = message.liveIsPlayback || isSharedLiveOnAir(message.liveId) !== true
  return playback ? '在独立播放窗观看回放' : '在独立播放窗进入直播'
}

/** 右栏消息区状态文案 */
const statusText = ref('')
watch([chatStatus, chatStatusText], () => {
  if (chatStatus.value === 'loading')
    statusText.value = '正在加载房间消息…'
  else if (chatStatus.value === 'error')
    statusText.value = chatStatusText.value || '房间消息加载失败'
  else
    statusText.value = ''
}, { immediate: true })
</script>

<template>
  <div class="page-root rooms-page" :class="{ 'is-paused': docVisibility === 'hidden' }">
    <!-- 未登录：居中登录卡片（房间依赖账号关注关系） -->
    <div v-if="!loggedIn && !loading" class="gate">
      <div class="gate-card frosted-surface">
        <span class="gate-icon icon-tile" :style="{ '--tile-color': 'var(--color-rooms)' }">
          <el-icon :size="28"><ChatDotRound /></el-icon>
        </span>
        <h2 class="gate-title">
          登录后查看关注房间
        </h2>
        <p class="gate-sub">
          房间列表来自口袋48账号的关注成员，登录后可查看 TA 们房间里的消息（文字 / 图片 / 语音 / 回复等）。
        </p>
        <div class="gate-points">
          <span class="gate-point">
            <el-icon><StarFilled /></el-icon>
            关注同步
          </span>
          <span class="gate-point">
            <el-icon><ChatDotRound /></el-icon>
            房间消息
          </span>
          <span class="gate-point">
            <el-icon><VideoCamera /></el-icon>
            直播回放
          </span>
        </div>
        <el-button type="primary" round @click="router.push('/setting')">
          去设置页登录
          <el-icon class="el-icon--right">
            <ArrowRight />
          </el-icon>
        </el-button>
      </div>
    </div>

    <template v-else>
      <!-- 左栏：关注成员房间 -->
      <aside class="rooms-side">
        <header class="side-head">
          <span class="side-title-icon icon-tile" :style="{ '--tile-color': 'var(--color-rooms)' }">
            <el-icon :size="18"><ChatDotRound /></el-icon>
          </span>
          <div class="side-title-text">
            <h2 class="side-title">
              关注房间
            </h2>
            <p class="side-sub">
              {{ rooms.length }} 个房间<template v-if="liveCount">
                · {{ liveCount }} 个正在直播
              </template><template v-if="pinnedRoomCount">
                · {{ pinnedRoomCount }} 个置顶
              </template><template v-if="hiddenRoomCount">
                · 已隐藏 {{ hiddenRoomCount }} 个
              </template>
            </p>
          </div>
          <el-tooltip content="刷新列表与直播状态" placement="top">
            <el-button
              class="side-refresh"
              size="small"
              circle
              :loading="loading || liveRefreshing"
              @click="load(true)"
            >
              <el-icon v-if="!loading && !liveRefreshing">
                <Refresh />
              </el-icon>
            </el-button>
          </el-tooltip>
        </header>

        <p v-if="pocketFollowError" class="side-warn">
          口袋关注获取失败，暂时仅显示本地关注
        </p>

        <div v-if="loadError" class="side-error">
          <p>{{ loadError }}</p>
          <el-button size="small" @click="load()">
            重试
          </el-button>
        </div>

        <div v-else-if="rooms.length" class="room-list detail-scroll">
          <!-- 关闭钮是条目的兄弟节点而非子节点：条目本体是 <button>，嵌套交互元素会破坏语义 -->
          <RoomListItem
            v-for="room in displayRooms"
            :key="room.userId"
            :room="room"
            :active="selectedRoom?.userId === room.userId"
            @select="enterRoom(room.userId)"
            @dblclick="onRoomWrapDblClick(room, $event)"
            @contextmenu="onRoomContextMenu(room, $event)"
            @close-temp="closeTempRoom"
          />
        </div>

        <div v-else-if="!loading" class="side-empty">
          <el-icon :size="30">
            <StarFilled />
          </el-icon>
          <template v-if="hiddenRoomCount">
            <p>关注的成员暂未开通房间</p>
            <p class="side-empty-hint">
              已过滤 {{ hiddenRoomCount }} 个未开通 / 已关闭的房间
            </p>
          </template>
          <template v-else>
            <p>还没有关注任何成员</p>
            <p class="side-empty-hint">
              在成员页点「关注」，或到设置页同步口袋关注
            </p>
          </template>
        </div>

        <div v-else class="side-loading">
          <el-icon class="is-loading" :size="22">
            <Refresh />
          </el-icon>
        </div>
      </aside>

      <!-- 右栏：房间消息 -->
      <main class="rooms-main">
        <template v-if="selectedRoom">
          <header class="main-head">
            <span class="main-avatar">
              <img v-if="selectedRoom.avatar" :src="selectedRoom.avatar" :alt="selectedRoom.nickname" referrerpolicy="no-referrer">
              <span v-else class="main-avatar-fallback">{{ selectedRoom.nickname.slice(0, 1) }}</span>
            </span>
            <div class="main-head-text">
              <div class="main-head-name-row">
                <h3 class="main-head-name ellipsis">
                  {{ selectedRoom.nickname }}
                </h3>
                <span
                  v-if="selectedRoomTeam.teamName"
                  class="room-team"
                  :style="Tools.colorVarStyle('--tb-color', selectedRoomTeam.teamColor)"
                >{{ Tools.shortTeamName(selectedRoomTeam.teamName) }}</span>
                <span v-if="selectedRoom.temporary" class="room-temp-tag">临时</span>
                <span v-if="selectedRoom.live" class="main-live-tag">直播中</span>
              </div>
              <p class="main-head-sub ellipsis">
                {{ selectedRoom.live?.title || '房间留言' }}
              </p>
            </div>

            <!-- 频道切换（大房间 / 小房间）：放头部右侧，页签显示服务端真实频道名；
                 小房间未发现时也整条渲染（只剩大房间一个页签） -->
            <div
              v-if="roomTabs.length > 0"
              class="room-tabs"
              role="tablist"
              aria-label="房间频道"
            >
              <button
                v-for="tab in roomTabs"
                :key="tab.mode"
                type="button"
                role="tab"
                class="room-tab"
                :class="{ 'is-active': viewMode === tab.mode }"
                :aria-selected="viewMode === tab.mode"
                :title="tab.locked ? `「${tab.name}」需要暗号，点击后输入` : `切换到「${tab.name}」`"
                @click="onViewModeChange(tab.mode)"
              >
                <el-icon v-if="tab.locked" :size="12" class="room-tab-lock">
                  <Lock />
                </el-icon>
                <span class="room-tab-name">{{ tab.name }}</span>
                <span v-if="tab.unread" class="unread-badge">{{ unreadText(tab.unread) }}</span>
              </button>
            </div>

            <!-- 置顶入口：右键菜单之外的可发现入口，落在头部右端。
                 左列的图钉是「已置顶」状态，这里是操作，同一枚图标串起两者；
                 带文字是因为纯图标没人认得出来（藏起来就等于没有入口） -->
            <button
              type="button"
              class="head-pin-btn"
              :class="{ 'is-on': selectedRoomPinned }"
              :title="selectedRoomPinned ? '取消置顶：不再排在左列最前' : '置顶：把该房间排到左列最前'"
              @click="onToggleRoomPin(selectedRoom.userId, 'header')"
            >
              <MediaIcon name="pushpinFilled" :size="13" />
              {{ selectedRoomPinned ? '已置顶' : '置顶' }}
            </button>
          </header>

          <!-- 右区双栏：左侧聊天流，右侧成员信息卡 + 相册 -->
          <div class="main-body">
            <section class="main-chat">
              <!-- 消息范围（只看房主 / 全部消息）：聊天区右上角。
                   与头部的频道页签分两层——频道是导航、范围是次级筛选，故用中性配色 -->
              <div v-if="!smallLocked" class="chat-tools">
                <!-- 精华消息：房间顶部置顶条，展示最新一条精华；点击打开完整列表。
                     房间没有精华时整条不渲染，不占位、不留空壳 -->
                <button
                  v-if="newestEssence"
                  type="button"
                  class="essence-bar"
                  title="查看房间精华消息"
                  @click="essenceOpen = true"
                >
                  <span class="essence-tag">
                    <el-icon :size="11"><StarFilled /></el-icon>
                    精华
                  </span>
                  <span class="essence-bar-nick">{{ newestEssence.nick }}：</span>
                  <span class="essence-bar-text">{{ essenceSummary }}</span>
                  <span v-if="essenceMessages.length > 1" class="essence-bar-count">{{ essenceMessages.length }}</span>
                </button>
                <button
                  type="button"
                  class="date-jump-btn"
                  title="按日期查看历史消息"
                  @click="openDateDialog"
                >
                  <el-icon :size="12">
                    <Calendar />
                  </el-icon>
                  按日期
                </button>
                <div class="scope-tabs" role="tablist" aria-label="消息范围">
                  <button
                    type="button"
                    role="tab"
                    class="scope-tab"
                    :class="{ 'is-active': messageScope === 'member' }"
                    :aria-selected="messageScope === 'member'"
                    title="只看房主：仅显示房主 / 成员发言，不含粉丝留言；切换后重新拉取"
                    @click="messageScope = 'member'"
                  >
                    只看房主
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class="scope-tab"
                    :class="{ 'is-active': messageScope === 'all' }"
                    :aria-selected="messageScope === 'all'"
                    title="全部消息：包含粉丝发言、回复与其他成员串门；切换后重新拉取"
                    @click="messageScope = 'all'"
                  >
                    全部消息
                  </button>
                </div>
              </div>

              <div
                v-if="messages.length"
                ref="listRef"
                class="msg-scroll detail-scroll"
                :style="{ '--arrive-flash': `${ARRIVE_FLASH_MS}ms`, '--collapse-lines': COLLAPSE_LINES }"
                @scroll="onListScroll"
              >
                <div class="msg-more">
                  <span v-if="loadingMore" class="msg-more-text">
                    <el-icon class="is-loading"><Refresh /></el-icon>
                    正在加载更早的消息…
                  </span>
                  <span v-else-if="historyExhausted" class="msg-more-text">没有更早的消息了</span>
                </div>
                <!-- 聊天气泡卡片：时间分隔 + 头像 + 昵称行 + 气泡；系统通知居中弱化 -->
                <template v-for="(message, index) in messages" :key="message.id">
                  <!-- 时间分隔：跨天显示日期，同一天内断档超过 5 分钟显示时刻（见 dividerMap） -->
                  <div v-if="dividerMap.get(index)" class="msg-date-pill">
                    {{ dividerMap.get(index) }}
                  </div>
                  <!-- 未读分割线：水位之后的第一条；日期分隔在前，重合时叠成两层。水位沉出窗口（补页触顶）时钉在窗口顶、文案降级 -->
                  <div
                    v-if="unreadAnchor && unreadIndex === index"
                    :ref="setUnreadAnchorEl"
                    class="msg-unread-pill"
                  >
                    {{ unreadDividerText }}
                  </div>
                  <div
                    class="msg-row"
                    :class="[`msg-row--${message.kind}`, { 'msg-row--member': message.isMember, 'msg-row--member-visitor': message.isMember && !isRoomOwner(message), 'msg-row--member-reply': message.isMember && message.quote && message.kind !== 'flip', 'is-arriving': arrivingIds.has(message.id) }]"
                    @contextmenu.prevent="openMessageMenu($event, message)"
                  >
                    <template v-if="message.kind === 'system'">
                      <div class="msg-system-pill">
                        {{ message.text }}
                      </div>
                    </template>
                    <template v-else>
                      <img
                        v-if="message.avatar"
                        class="msg-avatar"
                        :src="avatarUrl(message.avatar)"
                        :alt="message.nick"
                        referrerpolicy="no-referrer"
                      >
                      <span v-else class="msg-avatar msg-avatar--fallback">{{ message.nick.slice(0, 1) }}</span>
                      <div class="msg-main">
                        <div class="msg-meta">
                          <span class="msg-nick ellipsis">{{ message.nick || '用户' }}</span>
                          <span v-if="message.isMember" class="msg-member-tag">{{ isRoomOwner(message) ? '房主' : '成员' }}</span>
                          <!-- 等级徽章：房主标签与等级互斥展示，语义对齐弹幕气泡的 Lv 徽章 -->
                          <span v-else-if="message.level > 0" class="msg-level">Lv{{ message.level }}</span>
                          <span class="msg-time">{{ messageTime(message.msgTime) }}</span>
                          <!-- hover 复制：压在时间戳上（绝对定位不占位），键盘可达；右键菜单是完整入口 -->
                          <button
                            v-if="copyHint(message)"
                            type="button"
                            class="msg-copy"
                            :title="copyHint(message)"
                            :aria-label="`${copyHint(message)}：${message.nick || '用户'}的消息`"
                            @click="copyPrimary(message)"
                          >
                            <el-icon :size="12">
                              <DocumentCopy />
                            </el-icon>
                          </button>
                        </div>

                        <!-- 引用块：被回复消息的摘要（昵称 + 内容），只读展示。
                             翻牌不走这里——翻牌不是回复某条消息，而是一张问答卡（见 .msg-flip） -->
                        <div
                          v-if="message.quote && message.kind !== 'flip'"
                          class="msg-quote"
                          :class="{ 'msg-quote--gift': message.quote.isGift }"
                        >
                          <span class="msg-quote-nick">{{ message.quote.nick }}</span>
                          <span class="msg-quote-text">{{ message.quote.text || '引用了一条消息' }}</span>
                        </div>

                        <!-- 翻牌卡：上「回答」下「提问」，中间一条分隔线。
                             翻牌不引用某条消息，而是成员对粉丝提问的公开回答，所以不复用引用块：
                             回答是主内容（文字 / 语音条 / 视频），提问是被翻原文，完整展开不截断 -->
                        <div
                          v-if="message.kind === 'flip' && message.quote"
                          class="msg-flip"
                        >
                          <div class="msg-flip-answer">
                            <RoomVoiceBar v-if="message.audioUrl" :src="message.audioUrl" />
                            <video
                              v-else-if="message.videoUrl"
                              class="msg-video"
                              :style="videoBoxStyle(message)"
                              :src="message.videoUrl"
                              :poster="message.videoPoster || undefined"
                              controls
                              preload="metadata"
                              @loadedmetadata="onMediaLoad"
                            />
                            <p v-else class="msg-flip-answer-text">
                              {{ message.text }}
                            </p>
                          </div>
                          <div class="msg-flip-ask">
                            <span class="msg-flip-ask-tag">{{ message.quote.nick }}</span>
                            <p class="msg-flip-ask-text">
                              {{ message.quote.text }}
                            </p>
                          </div>
                        </div>

                        <div
                          v-else
                          class="msg-bubble"
                          :class="{
                            'msg-bubble--media': message.imageUrl || message.audioUrl || message.videoUrl,
                            'msg-bubble--live': message.kind === 'live',
                          }"
                        >
                          <!-- 图片：PreviewImage（el-image 全屏预览 + 下载工具条，按原始尺寸占位；
                               预览范围 = 当前已加载消息的图片列表，可与相册一样左右切换） -->

                          <PreviewImage
                            v-if="message.imageUrl"
                            class="msg-image"
                            :src="message.imageUrl"
                            :image-width="message.imageWidth"
                            :image-height="message.imageHeight"
                            :preview-list="messageImageUrls"
                            :initial-index="messageImageIndex.get(message.id) ?? 0"
                            :name-metas="messageImageMetas"
                            :owner-name="selectedRoom?.nickname ?? ''"
                            lazy
                            @load="onMediaLoad"
                            @error="onMediaLoad"
                          />
                          <template v-else-if="message.audioUrl">
                            <RoomVoiceBar :src="message.audioUrl" />
                            <!-- 语音条本身就是内容，类型占位文案不再补一行；回复消息的真实正文（非占位）仍要展示 -->
                            <p v-if="!isPlaceholderText(message.text)" class="msg-media-text">
                              {{ message.text }}
                            </p>
                          </template>

                          <video
                            v-else-if="message.videoUrl"
                            class="msg-video"
                            :style="videoBoxStyle(message)"
                            :src="message.videoUrl"
                            :poster="message.videoPoster || undefined"
                            controls
                            preload="metadata"
                            @loadedmetadata="onMediaLoad"
                          />

                          <!-- 直播/回放分享卡：竖排小卡（与 LiveItem 同构）——16:9 封面 + 类型角标叠封面 +
                         标题 + 开播时间与动作提示，可点开独立播放窗（liveId 缺失时只读）。
                         回放卡由 liveIsPlayback 区分（角标 + 动作文案），点击走回放播放窗 -->
                          <RoomLiveCard
                            v-else-if="message.kind === 'live'"
                            :cover="message.liveCover"
                            :clickable="!!message.liveId"
                            :badge="liveCardBadge(message)"
                            :hint="liveCardHint(message)"
                            :title="liveShareTitle(message.text)"
                            :start-time-text="message.liveStartTime ? shortTime(message.liveStartTime) : ''"
                            @open="openSharedLive(message)"
                          />
                          <template v-else>
                            <!-- 正文：超长的先收起（由 measureLongText 量出高度登记），末行渐隐提示还有内容 -->
                            <div
                              class="msg-text"
                              :class="{ 'is-clamped': isLongTextClamped(message.id) }"
                              :data-msg-id="message.id"
                            >
                              {{ message.text }}
                            </div>
                            <button
                              v-if="longTextIds.has(message.id)"
                              type="button"
                              class="msg-text-toggle"
                              @click="toggleLongText(message.id)"
                            >
                              {{ isLongTextClamped(message.id) ? '展开全文' : '收起' }}
                            </button>
                          </template>
                        </div>
                      </div>
                    </template>
                  </div>
                </template>
              </div>

              <!-- 小房间门禁层：不展示消息内容。两种形态——
                   暗号门禁给输入框（本地可作答）；赠送鸡腿一类的门槛只说明原因，本地无从解锁，
                   给输入框只会把人引到「输错了无数遍」的死路 -->
              <div v-else-if="smallLocked" class="small-lock">
                <div v-if="smallGateNotice" class="small-lock-card">
                  <span class="small-lock-badge">
                    <el-icon :size="18">
                      <Lock />
                    </el-icon>
                  </span>
                  <p class="small-lock-title">
                    「{{ smallChannelName || '小房间' }}」需要权限
                  </p>
                  <!-- 门槛原文是服务端对当前账号的判定（含刷新说明），原样转述，不自己编改写规则 -->
                  <blockquote v-if="smallGateNotice.message" class="small-lock-question">
                    {{ smallGateNotice.message }}
                  </blockquote>
                  <p class="small-lock-hint">
                    {{ smallGateHint }}
                  </p>
                </div>

                <div v-else class="small-lock-card">
                  <span class="small-lock-badge">
                    <el-icon :size="18">
                      <Lock />
                    </el-icon>
                  </span>
                  <p class="small-lock-title">
                    「{{ smallChannelName || '小房间' }}」需要暗号
                  </p>
                  <blockquote v-if="smallQuestion?.question" class="small-lock-question">
                    {{ smallQuestion.question }}
                  </blockquote>
                  <p v-else-if="smallQuestionLoading" class="small-lock-hint">
                    正在获取暗号问题…
                  </p>
                  <p v-else class="small-lock-hint">
                    未取到暗号问题，可直接输入暗号
                  </p>

                  <div class="small-lock-form">
                    <el-input
                      v-model="smallAnswer"
                      placeholder="输入暗号"
                      clearable
                      autofocus
                      :disabled="smallSubmitting"
                      @input="onSmallAnswerInput"
                      @keyup.enter="submitSmallAnswer"
                    />
                    <el-button
                      type="primary"
                      :loading="smallSubmitting"
                      @click="submitSmallAnswer"
                    >
                      进入
                    </el-button>
                  </div>

                  <p v-if="smallAnswerError" class="small-lock-error">
                    {{ smallAnswerError }}
                  </p>
                </div>
              </div>

              <div v-else-if="chatStatus === 'error'" class="msg-empty">
                <el-icon :size="30">
                  <ChatDotRound />
                </el-icon>
                <p>{{ chatStatusText || '房间消息加载失败' }}</p>
                <p class="msg-empty-hint">
                  点击左侧房间可重试
                </p>
              </div>

              <div v-else class="msg-empty">
                <el-icon :size="30">
                  <ChatDotRound />
                </el-icon>
                <template v-if="chatStatus === 'loading'">
                  <p>正在加载房间消息…</p>
                </template>
                <template v-else-if="roomClosed">
                  <p>该房间已关闭</p>
                  <p class="msg-empty-hint">
                    房间关闭后不再有新消息
                  </p>
                </template>
                <template v-else>
                  <p>暂无消息</p>
                  <p class="msg-empty-hint">
                    成员在房间里发送的文字、图片、语音与回复会显示在这里
                  </p>
                </template>
              </div>

              <!-- 发言输入条：房间就绪后常驻消息区底部。进房即订阅，未就绪时占位文案即状态 -->
              <RoomComposer
                v-if="composerVisible"
                ref="composerEl"
                v-model:draft="draft"
                :reply-target="replyTarget"
                :send-busy="sendBusy"
                :blocked="!!speakBlock"
                :muted="composerMuted"
                :placeholder="composerPlaceholder"
                :can-send="canSend"
                :usable="composerUsable"
                :send-hint="sendButtonHint"
                :send-label="sendButtonLabel"
                @cancel-reply="cancelReply"
                @composer-click="onComposerClick"
                @draft-enter="onDraftEnter"
                @send="onSendClick('button')"
              />

              <footer v-if="statusText" class="main-foot">
                {{ statusText }}
              </footer>

              <!-- 进房遗留未读的跳转浮标：贴底且分割线不在视口内才出现，点它滚到那里。
                   与下面的「新消息」浮标互斥（一个只在贴底、一个只在离开底部时出现） -->
              <Transition name="msg-float">
                <button
                  v-if="atBottom && unreadAnchor && unreadIndex >= 0 && !unreadJumped && !unreadAnchorVisible"
                  type="button"
                  class="new-msg-float new-msg-float--up"
                  :style="newMsgFloatStyle"
                  title="跳到未读消息的起点"
                  @click="jumpToUnread"
                >
                  <el-icon :size="12">
                    <ArrowRight />
                  </el-icon>
                  {{ unreadText(unreadAnchor.count) }} 条未读
                </button>
              </Transition>

              <!-- 上翻历史时收到新消息的浮标：点击回底（贴在输入条上方，见 newMsgFloatStyle） -->
              <Transition name="msg-float">
                <button
                  v-if="newCount > 0 && !atBottom"
                  type="button"
                  class="new-msg-float"
                  :style="newMsgFloatStyle"
                  title="回到最新消息"
                  @click="scrollToBottom"
                >
                  <el-icon :size="12">
                    <ArrowRight />
                  </el-icon>
                  {{ newCount }} 条新消息
                </button>
              </Transition>
            </section>

            <aside class="rooms-aside detail-scroll">
              <RoomProfileCard
                :user-id="selectedRoom.userId"
                :nickname="selectedRoom.nickname"
                :avatar="selectedRoom.avatar"
                :team-name="selectedRoom.teamName"
                :team-color="selectedRoom.teamColor"
                :live="selectedRoom.live"
                :pocket-followed="selectedPocketFollowed"
                :local-followed="selectedLocalFollowed"
                :pocket-follow-busy="pocketFollowBusy"
                :local-follow-busy="localFollowBusy"
                :pocket-unavailable="!!pocketFollowError"
                @toggle-pocket-follow="togglePocketFollow"
                @toggle-local-follow="toggleLocalFollow"
              />
              <RoomAlbum :messages="messages" :owner-name="selectedRoom?.nickname ?? ''" />
            </aside>
          </div>

          <!-- 精华消息弹层：完整列表（数据与翻页在 use-pocket-rooms，展示收在组件内） -->
          <RoomEssenceDialog
            v-model="essenceOpen"
            :messages="essenceMessages"
            :loading="essenceLoading"
            :exhausted="essenceExhausted"
            :room-name="selectedRoom?.nickname ?? ''"
            @load-more="loadMoreEssence"
          />

          <!-- 按日期查看弹层：独立只读轨道，不进主消息流、不碰已读与轮询 -->
          <RoomDateDialog
            v-model="dateOpen"
            :channel="dateTarget.channel"
            :scope="messageScope"
            :room-name="selectedRoom?.nickname ?? ''"
            :archive-start="roomArchiveStart"
            :empty-reason="dateTarget.missing ? '该房间已关闭，暂未取到关闭前的留言频道' : ''"
          />
        </template>

        <div v-else class="main-placeholder">
          <el-icon :size="34">
            <ChatDotRound />
          </el-icon>
          <p>从左侧选择一位关注的成员</p>
          <p class="main-placeholder-hint">
            查看 TA 的房间，浏览成员们发送的消息
          </p>
        </div>
      </main>
    </template>

    <!-- 右键菜单（Teleport 到 body，定位在光标处）：目标为消息或左列房间条目，
         动作按 menu.target.kind 分发；两类共用一个状态，同时只会有一个 -->
    <RoomMessageMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @pick="onMenuPick"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped lang="scss">
@use '../assets/css/fluid' as *;

/* ===== 页内复用骨架（%placeholder，不出本样式块）=====
 * 本页多处重复的造型收在这里：改一处即整页同步。颜色/尺寸等差异留给使用处，
 * 只抽「形状 + 过渡」这一层。若未来其它页面也要同款，再升级为 app.scss 公共类 */
%brand-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-rooms) 72%, #fff), var(--color-rooms));
}

%mini-pill {
  flex: none;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
}

%empty-block {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

%pill-tab {
  padding: fluid(3px, 4px) 12px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

/* 软标签：队伍徽标 / 本地 / 临时 / 已关闭四个状态标记共用，色相由 --tag-color 给出 */
%soft-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  color: var(--tag-color, var(--el-text-color-secondary));
  background: color-mix(in srgb, var(--tag-color, var(--el-text-color-secondary)) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tag-color, var(--el-text-color-secondary)) 30%, transparent);
}

/* 分段控件外壳：消息范围页签与频道页签共用，内部仍是 %pill-tab */
%segmented {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--el-fill-color-light);
}

/* 双栏骨架：左栏固定宽度，右栏自适应；整页不滚动，两栏各自滚（给 Dock 留底部空间）。
 * box-sizing 必须显式声明：项目没有全局 border-box 重置，.page-root 的 height:100%
 * 若按 content-box 把上下内边距算到外面，整页会高出视口，滚动被甩给 .app-content */
.rooms-page {
  display: flex;
  box-sizing: border-box;
  gap: fluid(10px, 14px);
  /* 本页无左上浮动 tab 栏，顶部内边距不走 --page-pad（那含 64px tab 预留） */
  padding: fluid(10px, 14px) 14px var(--dock-reserve);
  overflow: hidden;
}

/* ===== 登录引导（未登录居中卡片） ===== */
.gate {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  /* 背景氛围光斑：弱化空页面的「空」，把视线聚到卡片 */
  &::before,
  &::after {
    content: '';
    position: absolute;
    border-radius: 50%;
    filter: blur(72px);
    opacity: 0.45;
    pointer-events: none;
  }

  &::before {
    top: -70px;
    right: 10%;
    width: 320px;
    height: 320px;
    background: color-mix(in srgb, var(--color-rooms) 32%, transparent);
  }

  &::after {
    bottom: -50px;
    left: 10%;
    width: 260px;
    height: 260px;
    background: color-mix(in srgb, var(--el-color-primary) 24%, transparent);
  }
}

.gate-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 460px;
  padding: 40px 44px 34px;
  border-radius: 22px;
  text-align: center;
  animation: gate-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.gate-icon {
  width: 60px;
  height: 60px;
}

.gate-title {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.gate-sub {
  max-width: 400px;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

/* 功能点提要：小药丸让用户一眼知道登录后能做什么 */
.gate-points {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 4px 0 8px;
}

.gate-point {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);

  .el-icon {
    font-size: 13px;
    color: var(--color-rooms);
  }
}

.gate-card .el-button {
  padding: 12px 24px;
  height: auto;
}

@keyframes gate-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gate-card {
    animation: none;
  }
}

/* ===== 左栏：关注房间列表 ===== */
.rooms-side {
  display: flex;
  flex: none;
  flex-direction: column;
  /* 窗口 ≥1000 时稳定 300；更窄时按 30vw 收，最低 240，把余量让给消息流 */
  width: clamp(240px, 30vw, 300px);
  min-height: 0;
  border-radius: var(--radius-card);
  background: var(--glass-fill);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  backdrop-filter: var(--glass-blur);
}

.side-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: fluid(10px, 14px) 14px fluid(8px, 10px);

  .side-title-icon {
    width: 34px;
    height: 34px;

    .el-icon {
      font-size: 18px;
    }
  }
}

.side-title-text {
  flex: 1;
  min-width: 0;
}

.side-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.side-sub {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}

.side-warn {
  margin: 0 14px 8px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
}

.side-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin: 14px;
  padding: 18px 12px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);

  p {
    margin: 0;
  }
}

.room-list {
  flex: 1;
  box-sizing: border-box;
  min-height: 0;
  padding: 0 8px 12px;
}

/* 条目外层：关闭钮的定位基准（关闭钮不能嵌在 <button> 条目里） */

/* 未读数字角标：贴在头像右上角；开播时头像外圈是呼吸光环（.room-live-badge），
 * 红点叠在光环一角仍清晰可读。外观走全局 .unread-badge，这里只给落点与外描边 */

.side-empty,
.side-loading {
  @extend %empty-block;

  gap: 8px;
  padding: 24px 16px;
  color: var(--el-text-color-placeholder);

  p {
    margin: 0;
    font-size: 13px;
  }
}

/* 三处空态的次级提示行（精华弹层的同款规格收在其组件内） */
.side-empty-hint,
.msg-empty-hint,
.main-placeholder-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}

/* ===== 右栏：房间消息 ===== */
.rooms-main {
  /* 聊天列的水平内距：头部 / 工具条 / 消息区 / 输入条共用，
   * 分开写会让头像与气泡左边缘在改档后错开 */
  --chat-pad-x: #{fluid(13px, 16px)};

  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: var(--glass-fill);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  backdrop-filter: var(--glass-blur);
}

.main-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: fluid(8px, 12px);
  padding: fluid(8px, 14px) var(--chat-pad-x);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

/* 头部置顶按钮：右键菜单之外的可发现入口。
 * 未置顶是中性底（提示可操作），置顶后转房间青 + 淡底 + 细描边，与左列图钉标记同一观感。
 * min-width 固定「置顶 / 已置顶」两态的宽度，切换时不推动左侧页签 */
.head-pin-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 74px;
  padding: fluid(3px, 4px) 10px;
  border: none;
  border-radius: 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  /* 暗色主题下填充与页底差得少，靠一圈内描边把按钮边界交代清楚 */
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;

  &:hover {
    color: var(--color-rooms);
    background: color-mix(in srgb, var(--color-rooms) 10%, transparent);
  }

  &.is-on {
    color: var(--color-rooms);
    background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-rooms) 30%, transparent);
  }
}

/* 消息范围切换（只看房主 / 全部消息）：聊天区右上角，中性配色。
 * 与头部频道页签（房间青）分两层——这里是次级筛选，不抢导航的视觉权重 */
.chat-tools {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: fluid(8px, 12px);
  padding: fluid(6px, 10px) var(--chat-pad-x) 0;
}

/* 只有精华条让位：右侧两个控件定宽不压缩，否则窄栏里按钮会被挤到文字逐字换行
 * （<button> 的 min-width 是 auto，中文没有断词点，压缩后每行只剩一个字） */

/* 顶部精华条：房间置顶精华消息的入口，展示最新一条。
 * 与右侧消息范围同一行——两者都是消息区的次级控件，不额外占一行高度。
 * 整条可点，正文单行省略；没有精华时整条不渲染（见模板 v-if） */
.essence-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  min-width: 0;
  max-width: min(520px, 66%);
  /* 独占左侧，把消息范围推到右边；无精华条时 scope-tabs 仍靠右（justify-content） */
  margin-right: auto;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
  background: color-mix(in srgb, var(--color-follow) 14%, transparent);
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: color-mix(in srgb, var(--color-follow) 24%, transparent);
  }
}

.essence-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  font-weight: 600;
  /* 鎏金在浅底上对比不足，压深后才可读（与礼物金 / 总选金字同一套处理） */
  color: color-mix(in srgb, var(--color-follow) 62%, #000);
}

/* 昵称可压缩并省略：栏窄时先牺牲它，正文与标签仍完整 */
.essence-bar-nick {
  flex: 0 1 auto;
  overflow: hidden;
  min-width: 0;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.essence-bar-text {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.essence-bar-count {
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: color-mix(in srgb, var(--el-bg-color) 70%, transparent);
}

.scope-tabs {
  @extend %segmented;
}

.scope-tab {
  @extend %pill-tab;

  flex: none;
  white-space: nowrap;

  &:hover {
    color: var(--el-text-color-primary);
  }

  &.is-active {
    font-weight: 600;
    color: var(--el-text-color-primary);
    background: var(--el-bg-color);
    box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
  }
}

/* 按日期查看入口：与消息范围同一行的次级控件，用浅底与范围页签区分 */
.date-jump-btn {
  @extend %pill-tab;

  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  background: var(--el-fill-color-light);

  &:hover {
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--color-rooms) 12%, transparent);
  }
}

.main-avatar {
  flex: none;
  width: fluid(38px, 44px);
  height: fluid(38px, 44px);

  img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    background: var(--el-fill-color-light);
  }
}

.main-avatar-fallback {
  @extend %brand-avatar;

  width: 100%;
  height: 100%;
  font-size: 17px;
}

.main-head-text {
  flex: 1;
  min-width: 0;
}

.main-head-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.main-head-name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.main-live-tag {
  @extend %mini-pill;

  padding: 0 7px;
  line-height: 17px;
  color: #fff;
  background: var(--color-lives);
}

.main-head-sub {
  margin: fluid(2px, 3px) 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 右区双栏：左聊天流自适应，右侧信息栏固定宽；各自滚动 */
.main-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.main-chat {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

/* 频道页签（大房间 / 小房间）：落在头部右侧，显示服务端真实频道名。
 * 强调色用房间主题青（页面里所有房间语义都用它），不用品牌紫——
 * 这一条正是「我在哪个频道」最需要一眼看清的地方；未读走全局 .unread-badge */
.room-tabs {
  @extend %segmented;

  max-width: 340px;
  margin-left: auto;
}

.room-tab {
  @extend %pill-tab;

  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 160px;

  &:hover {
    color: var(--color-rooms);
  }

  &.is-active {
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, color-mix(in srgb, var(--color-rooms) 74%, #fff), var(--color-rooms));
    box-shadow: 0 3px 10px -4px color-mix(in srgb, var(--color-rooms) 60%, transparent);
  }

  .unread-badge {
    flex: none;
  }
}

/* 锁：这是「进去要暗号」的状态信息，非选中态用暖色提示；选中态跟白字站稳对比 */
.room-tab-lock {
  flex: none;
  color: var(--el-color-warning);
}

.room-tab.is-active .room-tab-lock {
  color: inherit;
}

/* 频道名可能很长：页签宽度封顶，超出省略 */
.room-tab-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 小房间门禁层：盖住消息区，不展示任何消息内容。
 * 卡片自成一块「门牌」：徽标 → 标题 → 成员设的条件（引用块）→ 输入行 / 说明 → 兜底提示。
 * 引用块里的都是成员或服务端给的原话（暗号题面 / 「最近30天内赠送过鸡腿礼物…」），
 * 用引用块而非正文呈现，避免与界面自己的措辞混作一类。 */
.small-lock {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.small-lock-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: min(340px, 100%);
  padding: 26px 22px 22px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-lg);
  background: var(--el-bg-color);
  box-shadow: 0 8px 28px rgb(0 0 0 / 6%);
  text-align: center;
}

/* 徽标用暖色：语义是「需要确认」而非错误，同时不跟页面导航的房间青抢权重 */
.small-lock-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.small-lock-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--el-text-color-primary);
}

/* 成员出的题：左竖线 + 底色的引用块，一眼分辨「这是别人写的」。
 * 这是用户唯一需要读懂的内容，用正文主色，不用降级灰 */
.small-lock-question {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 9px 12px;
  border-left: 3px solid var(--el-color-warning-light-3);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
  text-align: left;
  overflow-wrap: anywhere;
}

.small-lock-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
  overflow-wrap: anywhere;
}

.small-lock-form {
  display: flex;
  gap: 8px;
  width: 100%;

  .el-input {
    flex: 1;
  }
}

.small-lock-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-color-danger);
  overflow-wrap: anywhere;
}

.rooms-aside {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  /* 信息栏随窗口收：系数 = 基准 264 / 1400，1400 及更宽逐像素等于原值，
   * 更窄时先让出宽度给聊天区（相册三列等比变窄），下限 200 保证资料卡可读 */
  width: clamp(200px, 18.86vw, 264px);
  padding: 12px;
  overflow-y: auto;
  border-left: 1px solid var(--el-border-color-lighter);
}

/* 窗口不够宽时收起右侧信息栏（资料卡 + 相册），把宽度让给聊天区：
 * 固定占用 = 页面左右内距 28 + 列表 300 + 间距 14 + 信息栏 200–264，约 542–606px，
 * 低于 960px 时聊天区余量不足以舒展气泡，宁可失去信息栏也不压缩消息可读性。
 * 信息是「有更好」，相册与资料在成员页另有入口，隐藏不损失关键路径 */
@media (max-width: 960px) {
  .rooms-aside {
    display: none;
  }

  /* 窄窗才收水平留白；垂直分量归密度档，两条轴各改各的 */
  .rooms-page,
  .side-head {
    padding-inline: 10px;
  }

  /* 聊天列比设置页 / 列表页更挤：右栏资料卡与相册已收起，左列还要保住条目宽度 */
  .rooms-main {
    --chat-pad-x: 12px;
  }
}

.msg-scroll {
  flex: 1;
  box-sizing: border-box;
  min-height: 0;
  padding: fluid(8px, 12px) var(--chat-pad-x);

  /* 消息列圆角表：整列只分「大 / 小」两档 + 指向头像的收角，改这一处即整列同步。
   * --msg-radius-inner 是「大档 − 内距」的同心内角（直播卡在气泡内含 4px 内距），
   * 内部盒在收角那一侧沿用收角，否则会从外角后露出底衬缺口；
   * 媒体块（图片 / 视频 / 语音条）不带收角——它们不是「说话」 */
  --msg-radius: 14px;
  --msg-radius-sm: 6px;
  --msg-radius-inner: calc(var(--msg-radius) - 4px);

  /* 礼物金：底色保持淡金，文字压深一半 —— 原 #ffd479 / #e8b84b 是深底弹幕沿用的亮金，
   * 叠在浅色底上只有 1.4:1 / 1.9:1，粉丝送礼的昵称与正文基本读不出来 */
  --msg-gift-ink: color-mix(in srgb, var(--el-color-warning) 50%, #000);
  /* 回复类正文：正文色与次级灰的中点，比成员原创弱一档，但仍过 AA（约 4.5:1） */
  --msg-reply-ink: color-mix(in srgb, var(--el-text-color-regular) 62%, var(--el-text-color-secondary));
  /* 到达高亮时长由页面按 ARRIVE_FLASH_MS 注入：动画与类的移除同一节拍 */
  --arrive-flash: 1200ms;
}

/* 加载更早历史：贴在消息流顶部的状态行（滚动到顶自动触发，不再有按钮） */
/* 顶部占位条定高：空闲/加载中/到头布局恒定，贴顶视口不因 spinner 出入被推下抖动 */
.msg-more {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
}

.msg-more-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* ===== 聊天气泡卡片 ===== */
.msg-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: fluid(8px, 10px);
  padding: fluid(4px, 5px) 2px;
  border-radius: var(--radius-sm);
}

.msg-avatar {
  flex: none;
  width: fluid(30px, 34px);
  height: fluid(30px, 34px);
  margin-top: 2px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--el-fill-color-light);
}

.msg-avatar--fallback {
  @extend %brand-avatar;

  font-size: 14px;
}

.msg-main {
  flex: 1;
  min-width: 0;
}

.msg-meta {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-bottom: 3px;
}

.msg-nick {
  flex: none;
  max-width: 50%;
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-primary);
}

/* 作者名色调按消息类型区分（与浮窗气泡层同语义）：礼物 → 金；系统（禁言/关闭通知）→ 弱化 */
.msg-row--gift .msg-nick {
  color: var(--msg-gift-ink);
}

.msg-row--system .msg-nick {
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

/* 房主徽标：实心房间色，与普通用户拉开层级（房间留言的主人就是 xox 本人） */
.msg-member-tag {
  @extend %mini-pill;

  line-height: 15px;
  color: #fff;
  /* 随行取色：房主房间青、串门成员成员蓝（见 .msg-row--member-visitor） */
  background: var(--msg-accent, var(--color-rooms));
}

.msg-time {
  flex: none;
  margin-left: auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}

/* hover 复制按钮：绝对定位压在时间戳上，不占位（否则每行的时刻都会向左缩一格）；
 * 自身有底色与描边，盖住时刻仍看得清。默认不可点，避免点到隐形按钮 */
.msg-copy {
  position: absolute;
  top: 50%;
  right: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-xs);
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;

  &:hover {
    color: var(--brand-primary);
    border-color: color-mix(in srgb, var(--brand-primary) 40%, var(--el-border-color-lighter));
  }
}

.msg-row:hover .msg-copy,
.msg-copy:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

/* 按钮正好铺在时刻那一格上：显示时把时刻让开（保留占位），
 * 否则会从按钮边上露出半截时间戳，看着像渲染坏了 */
.msg-row:hover .msg-time,
.msg-row:focus-within .msg-time {
  visibility: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .msg-copy {
    transition: none;
  }
}

.msg-bubble {
  display: inline-block;
  /* 封顶 760：超宽屏上聊天区能有 1900px，长消息整行横跨整屏无法阅读；
   * 常规窗口下聊天区不足 760，这里不生效 */
  max-width: min(760px, 100%);
  padding: 7px 12px;
  border-radius: var(--radius-xs) var(--msg-radius) var(--msg-radius) var(--msg-radius);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  /* 普通用户正文整梯下移一档，把「正文色」那一格让给成员回复类（见 --msg-reply-ink） */
  color: color-mix(in srgb, var(--el-text-color-regular) 88%, var(--el-text-color-secondary));
  background: var(--el-fill-color-light);
}

.msg-row--gift .msg-bubble {
  color: var(--msg-gift-ink);
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}

/* 成员（xox）消息整卡提亮：房间页的主角是成员发言，与普通用户气泡拉开层级。
 * 规则放在礼物之后——成员发的礼物/翻牌同样按成员卡呈现（不再染金），
 * 系统通知走居中 pill，不经过这套样式 */
.msg-row--member {
  /* 成员身份色：房主走房间青。串门成员在下面覆写为成员蓝 */
  --msg-accent: var(--color-rooms);

  .msg-nick {
    color: var(--msg-accent);
  }

  /* 成员（xox）普通文字消息：相比普通用户气泡再微提一层，正文用主色、底色与描边更实。
   * 回复/引用类消息看 .msg-row--member-reply，不套这份强化 */
  .msg-bubble:not(.msg-bubble--media) {
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--msg-accent) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--msg-accent) 40%, transparent);
  }
}

/* 串门成员（roleId>1 但不是本房间房主）：身份色换成成员蓝，房间青留给房主本人。
 * 只改取色变量——昵称 / 气泡底色与描边 / 「成员」徽标同时换色，层级仍与房主一致 */
.msg-row--member-visitor {
  --msg-accent: var(--color-members);
}

/* 成员回复/引用类消息：顺着别人话题回的次要消息，比成员原创、也比普通用户发言弱一档
 * （中间色 + 更淡底 + 去掉描边）。字色不再用纯次级灰——那档只有约 3:1，读不清 */
.msg-row--member-reply {
  .msg-nick {
    color: var(--msg-reply-ink);
  }

  .msg-bubble:not(.msg-bubble--media) {
    color: var(--msg-reply-ink);
    background: var(--el-fill-color-lighter);
    box-shadow: none;
  }
}

/* ===== 长文折叠：成员小作文超过 10 行先收起来 ===== */
/* 收起态用 max-height 截断（而非 line-clamp）：scrollHeight 仍报完整内容高度，
 * measureLongText 才能反复量出「超长」而不来回抖动。行数由页面按 COLLAPSE_LINES 注入 */
.msg-text.is-clamped {
  max-height: calc(1.6em * var(--collapse-lines, 10));
  overflow: hidden;
  /* 末行渐隐，提示下面还有内容 */
  mask-image: linear-gradient(180deg, #000 74%, transparent);
}

.msg-text-toggle {
  display: block;
  padding: 2px 0 0;
  border: none;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  /* 房间青在浅底上太浅，压深才够读（与礼物金同一套处理） */
  color: color-mix(in srgb, var(--color-rooms) 60%, #000);
  background: none;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

/* ===== 引用块：被回复消息的摘要（昵称 + 内容），只读展示 ===== */
.msg-quote {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 4px;
  padding: 3px 10px;
  /* 左侧竖线是引用块的视觉锚点（聊天软件通用语），颜色随房间色 */
  border-left: 2px solid color-mix(in srgb, var(--color-rooms) 45%, transparent);
  border-radius: var(--radius-xs) var(--msg-radius-sm) var(--msg-radius-sm) var(--radius-xs);
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);

  /* 昵称取中性色而非品牌紫：房间青在本页专指「成员」身份（见 .msg-row--member / .msg-member-tag），
   * 而引用对象可能是任意用户，借色等于误标身份；强调色交由左侧竖线独自承担 */
  .msg-quote-nick {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    font-weight: 600;
    color: var(--el-text-color-regular);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .msg-quote-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* 被引用的是礼物消息：摘要文案用礼物金（与礼物气泡同色系） */
.msg-quote--gift .msg-quote-text {
  color: var(--msg-gift-ink);
}

/* ===== 翻牌卡：成员回答（上）+ 粉丝提问（下），中间一条分隔线 =====
   翻牌不是回复某条消息，而是成员对粉丝提问的公开回答，所以不复用引用块：
   自带卡片外壳，回答在上（主内容）、被翻提问在下（完整展开）。 */
.msg-flip {
  display: flex;
  flex-direction: column;
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
  /* 收角一侧与头像同向，其余三面取气泡大档——与同层级的消息气泡对齐 */
  border-radius: var(--radius-xs) var(--msg-radius) var(--msg-radius) var(--msg-radius);
  font-size: 13px;
  line-height: 1.6;
  text-align: left;
  background: var(--el-fill-color-lighter);
  /* 描边用 inset 阴影而非 border：配合 overflow 裁圆角不会在四角留缺口 */
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-rooms) 24%, transparent);
}

/* 上半：成员的回答（文字 / 语音条 / 视频），整宽展示 */
.msg-flip-answer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 8px 12px;
  color: var(--el-text-color-primary);

  /* 卡片宽度由内容决定（fit-content），媒体块按百分比铺满时不能再向外撑 */
  video {
    max-width: 100%;
    /* 与卡片同心：外角取同心内角，否则画面圆角会贴着卡片圆角"各转各的" */
    border-radius: var(--msg-radius-inner);
  }
}

.msg-flip-answer-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 下半：被翻的粉丝提问。原样完整展示，不截断；底衬压一档读起来是「背景信息」 */
.msg-flip-ask {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  /* 分隔线同样走 inset 阴影：border 会在卡片圆角处被裁出缺口。
   * 颜色取「房间色混进主题描边」，和卡片外圈、提问药丸同一套强调色，明暗主题都稳 */
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-rooms) 30%, var(--el-border-color-lighter));
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
}

.msg-flip-ask-tag {
  @extend %mini-pill;

  /* 提问可能占多行，标签始终贴在首行 */
  margin-top: 3px;
  line-height: 15px;
  color: var(--color-rooms);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
}

.msg-flip-ask-text {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== 直播/回放分享卡：竖排小卡（LiveItem 同构）——16:9 封面 + 角标叠封面 + 标题 + 时间/动作 ===== */
.msg-bubble--live {
  padding: 4px;
  background: var(--el-fill-color-light);
}

/* 媒体气泡：去掉外层聊天底框，媒体贴边展示（自带圆角/底色） */
.msg-bubble--media {
  padding: 0;
  background: none;
}

.msg-image {
  display: block;
  /* 宽高由组件按原图算定（见 PreviewImage 的 boxStyle）；这两行只兜窄窗与超限 */
  max-width: min(240px, 100%);
  max-height: 280px;
  border-radius: var(--msg-radius);
  /* 加载前/透明图的底色，避免空白一块再突然出图 */
  background: var(--el-fill-color-light);
  cursor: zoom-in;
}

.msg-video {
  display: block;
  /* 默认 16:9 预留兜底；bodys 带真实 w/h 时 videoBoxStyle 覆盖为真实比例
     （竖屏高度封顶）——加载前后高度都不变，滚动不抖动 */
  width: min(280px, 100%);
  aspect-ratio: 16 / 9;
  border-radius: var(--msg-radius);
  background: #000;
}

/* 语音条附带的正文（语音回复的回复语等） */

.msg-media-text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-regular);
}

/* 系统通知（禁言 / 关闭房间聊天）：居中弱化小药丸，不占头像位 */
.msg-row--system {
  justify-content: center;
  padding: 4px 0;
}

.msg-system-pill {
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-lighter);
}

/* 日期分隔线：居中药丸（.msg-scroll 非 flex 容器，用 fit-content + auto margin 居中） */
.msg-date-pill {
  width: fit-content;
  padding: 2px 10px;
  margin: fluid(8px, 10px) auto fluid(3px, 4px);
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* 未读分割线：两侧细线夹一行品牌色文案（flex 撑满行宽，线自动延伸）。
 * 比日期药丸更强——它回答的是「从哪里开始是新消息」，是进房后第一眼要找的东西 */
.msg-unread-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: fluid(10px, 14px) 0 fluid(5px, 6px);
  font-size: 11px;
  line-height: 1;
  color: var(--brand-primary, var(--el-color-primary));

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(var(--brand-rgb), 0.28);
  }
}

/* 等级徽章：金色语义对齐弹幕气泡的 Lv；房主标签与等级互斥，不并存 */
.msg-level {
  @extend %mini-pill;

  padding: 0 6px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  box-shadow: inset 0 0 0 1px var(--el-color-warning-light-5);
}

/* ===== 新消息到达：一次性高亮（只贴底时挂上）=====
 * 底色渐隐 + 左侧细条，一眼看出「刚进来这几条」；上翻浏览时不挂，交给浮标计数。
 * prefers-reduced-motion 下动画关掉、退化为静态细条 —— 不用动效也仍有位置提示 */
.msg-row.is-arriving {
  animation: msg-arrive-flash var(--arrive-flash) ease-out both;
}

.msg-row.is-arriving::before {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: -7px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--color-rooms);
  animation: msg-arrive-bar var(--arrive-flash) ease-out both;
}

@keyframes msg-arrive-flash {
  from {
    background-color: color-mix(in srgb, var(--color-rooms) 13%, transparent);
  }

  to {
    background-color: transparent;
  }
}

@keyframes msg-arrive-bar {
  0% {
    opacity: 0;
    transform: scaleY(0.4);
  }

  22% {
    opacity: 1;
    transform: none;
  }

  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg-row.is-arriving,
  .msg-row.is-arriving::before {
    animation: none;
  }
}

/* 上翻历史时收到新消息的浮标：悬在聊天区右下角 */
.new-msg-float {
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: #fff;
  background: var(--brand-primary, var(--el-color-primary));
  box-shadow: var(--el-box-shadow-light);
  cursor: pointer;

  .el-icon {
    transform: rotate(90deg);
  }

  &:hover {
    opacity: 0.9;
  }
}

/* 未读浮标指向分割线（向上）：与上面同款 ArrowRight，反向旋转。
 * 同特异度，必须定义在 .new-msg-float 之后才生效 */
.new-msg-float--up .el-icon {
  transform: rotate(-90deg);
}

/* 浮标出入场：与 BackTopButton 同款的下沉淡入淡出；reduced-motion 下瞬切 */
.msg-float-enter-active,
.msg-float-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.msg-float-enter-from,
.msg-float-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .msg-float-enter-active,
  .msg-float-leave-active {
    transition: none;
  }
}

.msg-empty,
.main-placeholder {
  @extend %empty-block;

  gap: 8px;
  color: var(--el-text-color-placeholder);

  p {
    margin: 0;
    font-size: 13px;
  }
}

.main-foot {
  flex: none;
  padding: 8px var(--chat-pad-x) calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

/* 天气标签：右栏头部（.main-head-name 旁）与本页左列条目共用同一外观。
   条目已抽到 components/rooms/RoomListItem.vue，scoped 样式跨不过去，
   那边有一份同样的定义；改形状时两处要一起改（与 %soft-tag 同步）。 */
.room-team {
  @extend %soft-tag;

  --tag-color: var(--tb-color, var(--brand-primary));

  /* 队伍色只做淡底不加描边：它是身份标识，不像下面两个是状态提示 */
  box-shadow: none;
}

.room-temp-tag {
  @extend %soft-tag;

  --tag-color: var(--color-rooms);
}
</style>

<style lang="scss">
/* 非 scoped：窗口隐藏时暂停左列条目的动效。
   条目已抽成 components/rooms/RoomListItem.vue，scoped 规则跨不过组件边界，
   而这里表达的是「整页暂停」这种页面级状态，故单独用非 scoped 块承载。 */
.rooms-page.is-paused {
  .room-live-badge,
  .room-live-badge::after,
  .room-eq i {
    animation-play-state: paused;
  }
}
</style>
