<script setup lang="ts">
// 口袋「房间」页：左栏关注成员房间列表，右栏房间消息流（成员在房间频道的留言，非直播间弹幕）。
// 数据与连接编排见 composables/use-pocket-rooms.ts（本页只做展示与交互）。

import type { PocketRoom } from '@renderer/composables/use-pocket-rooms'
import type { PocketRoomCopyKey, PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import type { Component } from 'vue'
import { ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'
import { ArrowRight, ChatDotRound, Close, DocumentCopy, Lock, Microphone, Picture, Refresh, StarFilled, VideoCamera } from '@element-plus/icons-vue'
import ImageViewerToolbar from '@renderer/components/rooms/ImageViewerToolbar.vue'
import RoomAlbum from '@renderer/components/rooms/RoomAlbum.vue'
import RoomMessageMenu from '@renderer/components/rooms/RoomMessageMenu.vue'
import RoomProfileCard from '@renderer/components/rooms/RoomProfileCard.vue'

import RoomVoiceBar from '@renderer/components/rooms/RoomVoiceBar.vue'
import { usePocketRooms } from '@renderer/composables/use-pocket-rooms'
import { markRoomRead, unreadChannelOf, unreadCountOf } from '@renderer/stores/pocket-unread'
import { copyText } from '@renderer/utils/clipboard'
import { debugLog } from '@renderer/utils/debug'
import { isPlaceholderText, liveShareTitle, pocketRoomCopyTargets } from '@renderer/utils/pocket-room-message'
import Tools from '@renderer/utils/tools'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onDeactivated, onMounted, ref, watch } from 'vue'
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
  chatStatus,
  chatStatusText,
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

  loadMoreHistory,
  openSharedLive,
  isSharedLiveOnAir,
} = usePocketRooms()

const router = useRouter()
const route = useRoute()

/** 精华消息弹层是否打开 */
const essenceOpen = ref(false)
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

/** 口袋关注 / 取关：只动账号侧关注，不改本地名单；结果就地更新当前房间来源 */
const pocketFollowBusy = ref(false)

async function togglePocketFollow() {
  const room = selectedRoom.value
  if (!room || pocketFollowBusy.value)
    return
  const willFollow = !isPocketFollowed(room.followSource)
  // 取关是账号级破坏性操作：二次确认，避免手滑把口袋侧关注摘掉
  if (!willFollow) {
    const ok = await ElMessageBox.confirm(
      `确定在口袋账号取消关注「${room.nickname}」吗？`,
      '取消口袋关注',
      { type: 'warning', confirmButtonText: '取消关注', cancelButtonText: '再想想' },
    ).then(() => true).catch(() => false)
    if (!ok)
      return
  }
  pocketFollowBusy.value = true
  try {
    if (willFollow)
      await window.mainAPI.pocketFollowMember(room.userId)
    else
      await window.mainAPI.pocketUnfollowMember(room.userId)
    room.followSource = willFollow
      ? (room.followSource === 'local' ? 'both' : 'pocket')
      : (room.followSource === 'both' ? 'local' : undefined)
    ElMessage({ message: willFollow ? '已在口袋账号关注该成员' : '已在口袋账号取消关注该成员', type: 'success' })
  }
  catch (error) {
    ElMessage.error(willFollow ? '口袋关注失败，请稍后重试' : '口袋取关失败，请稍后重试')
    debugLog('pocket-rooms', '口袋关注/取关失败', error)
  }
  finally {
    pocketFollowBusy.value = false
  }
}

/**
 * 频道切换（页签）：切到哪个频道就清当前频道的未读。
 */
async function onViewModeChange(mode: 'room' | 'small') {
  const userId = selectedUserId.value
  if (mode !== 'room') {
    void setViewMode(mode)
    if (userId !== null && unreadChannelOf(userId).small > 0)
      void markRoomRead(userId, 'small')
    return
  }
  const hadUnread = userId !== null && unreadChannelOf(userId).big > 0
  await setViewMode(mode)
  if (userId !== null)
    await settleBigRoomEnter(userId, hadUnread)
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
}, { immediate: true })

watch([selectedUserId, chatStatus], ([userId, status]) => {
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
  if (status !== 'ready')
    return
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
  lastSeenScrollTop = el.scrollTop
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  // scrollTop 相对上次变小才是用户真的上滚，才允许退出钉底；
  // 仅 scrollHeight 变大（媒体撑高、追加消息）保持钉底，由媒体回调继续补贴底
  if (!nearBottom && prevSeen >= 0 && el.scrollTop < prevSeen - 1)
    atBottom.value = false
  else if (nearBottom)
    atBottom.value = true
  // 回到底部即清空新消息计数
  if (atBottom.value)
    newCount.value = 0
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
 * 进入大房间视图的公共收尾（点左列条目、点大房间页签共用）：
 * 与官方客户端一致，进房即清该成员**大房间**的未读（Tab 级计数职责移交房间页），
 * 小房间未读保留——它有自己的页签入口，用户点开小房间时才清。
 * 清零的前提是用户确实看得到消息：进入前大房间已有未读时，加载完成后强制回底，
 * 否则会出现「角标没了但新消息还在上面」的漏读。未读为 0 时不额外动作，
 * 交给消息流自身的贴底逻辑（同房重进不重拉，位置得以保留）。
 */
async function settleBigRoomEnter(userId: number, hadUnread: boolean) {
  void markRoomRead(userId, 'room')
  if (!hadUnread)
    return
  await nextTick()
  scrollToBottom()
}

/** 点进房间（左列条目）：选中 → 清大房间未读（有未读则回底） */
async function enterRoom(userId: number) {
  const hadUnread = unreadChannelOf(userId).big > 0
  await selectRoom(userId)
  await settleBigRoomEnter(userId, hadUnread)
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
  if (!result.ok)
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
  // 贴底浏览即已读：主进程清掉当前视图频道（大房间/小房间）的未读并对齐基线，
  // 广播回来后左列与 Dock 角标同步消失。上翻浏览时不标记，未读保留
  if (selectedUserId.value !== null && messages.value.length)
    void markRoomRead(selectedUserId.value, viewMode.value)
  await nextTick()
  scrollToBottom()
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
}

/** 头像 URL：口袋扩展给的是相对/完整路径混杂，统一过 sourceUrl */
function avatarUrl(avatar: string) {
  return avatar ? Tools.sourceUrl(avatar) : ''
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

// ===== 复制（hover 按钮 + 右键菜单）=====
/** 右键菜单的定位与目标消息；null = 未打开 */
const menu = ref<{ x: number, y: number, message: PocketRoomMessageView } | null>(null)

/** 复制项的文案与图标：清单本身（有哪些可复制）在归一层，这里只贴 UILabel */
const COPY_ITEMS: Record<PocketRoomCopyKey, { label: string, icon: Component }> = {
  text: { label: '复制文字', icon: DocumentCopy },
  image: { label: '复制图片链接', icon: Picture },
  audio: { label: '复制语音链接', icon: Microphone },
  video: { label: '复制视频链接', icon: VideoCamera },
}

function copyMenuItems(message: PocketRoomMessageView) {
  return pocketRoomCopyTargets(message).map(item => ({ key: item.key, ...COPY_ITEMS[item.key] }))
}

const menuItems = computed(() => (menu.value ? copyMenuItems(menu.value.message) : []))

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

function openMessageMenu(event: MouseEvent, message: PocketRoomMessageView) {
  if (!pocketRoomCopyTargets(message).length)
    return
  menu.value = { x: event.clientX, y: event.clientY, message }
}

function closeMenu() {
  menu.value = null
}

function onMenuPick(key: string) {
  const target = menu.value
  menu.value = null
  if (target)
    void runCopy(key as PocketRoomCopyKey, target.message)
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
 * 图片占位样式：归一层解析到原始尺寸时按 aspect-ratio 预留空间，
 * 图片加载前后布局零变化（滚动历史不再抖动）；未知尺寸回退自然加载（仅轻微抖动）。
 * 宽度压到容器上限，fit=cover 裁切超出 max-height 的极端比例。
 * maxWidth：消息流 240（气泡内），精华弹层 300（弹层更宽，同款占位放大一档）。
 */
function imageBoxStyle(message: PocketRoomMessageView, maxWidth = 240) {
  if (!message.imageWidth || !message.imageHeight)
    return undefined
  return {
    width: `min(${maxWidth}px, 100%)`,
    aspectRatio: `${message.imageWidth} / ${message.imageHeight}`,
  }
}

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

/** 短时刻（MM-DD HH:mm）：直播分享卡的时刻行与精华列表共用 */
function shortTime(ts: number | string) {
  return ts ? dayjs(ts).format('MM-DD HH:mm') : ''
}

/** 日期分隔线：与上一条不同天时插一枚；首页第一条也是分界 */
function isDayBoundary(index: number): boolean {
  const current = messages.value[index]
  const prev = messages.value[index - 1]
  if (!current?.msgTime)
    return !!prev?.msgTime
  if (!prev?.msgTime)
    return true
  return !dayjs(current.msgTime).isSame(dayjs(prev.msgTime), 'day')
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

/**
 * 直播分享卡角标（类型语义对齐 LiveItem）：回放 > 录屏 > 电台 > 直播。
 * 在播与否优先于 liveType：分享消息本身不带可靠回放标记（yaya_msg 同款），
 * 以当前直播列表判定——liveId 不在播即回放；列表未拉到（null）时按 liveType 兜底展示。
 */
function liveCardBadge(message: PocketRoomMessageView) {
  if (message.liveIsPlayback || isSharedLiveOnAir(message.liveId) === false)
    return { text: '回放', type: 'playback' }
  if (message.liveType === 1)
    return message.liveMode === 1 ? { text: '录屏', type: 'screen' } : { text: '直播', type: 'live' }
  if (message.liveType === 2)
    return { text: '电台', type: 'radio' }
  return { text: '直播', type: 'live' }
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

onMounted(() => {
  debugLog('rooms-page', 'Rooms 页面挂载，开始获取频道列表', { loggedIn: loggedIn.value })
  void load()
})
</script>

<template>
  <div class="page-root rooms-page">
    <!-- 未登录：整页登录引导（房间依赖账号关注关系） -->
    <div v-if="!loggedIn && !loading" class="gate">
      <span class="gate-icon icon-tile" :style="{ '--tile-color': 'var(--color-rooms)' }">
        <el-icon :size="26"><ChatDotRound /></el-icon>
      </span>
      <h2 class="gate-title">
        登录后查看关注房间
      </h2>
      <p class="gate-sub">
        房间列表来自口袋48账号的关注成员，右侧显示 TA 们房间里成员发送的消息（文字 / 图片 / 语音 / 回复等）。
      </p>
      <el-button type="primary" @click="router.push('/setting')">
        去设置页登录
      </el-button>
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
              @click="load()"
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
          <div
            v-for="room in rooms"
            :key="room.userId"
            class="room-wrap"
            :class="{ 'is-temp': room.temporary }"
            @dblclick="onRoomWrapDblClick(room, $event)"
          >
            <button
              type="button"
              class="room-item"
              :class="{ 'is-active': selectedRoom?.userId === room.userId, 'is-live': !!room.live }"
              @click="enterRoom(room.userId)"
            >
              <span class="room-avatar">
                <img v-if="room.avatar" :src="room.avatar" :alt="room.nickname" referrerpolicy="no-referrer">
                <span v-else class="room-avatar-fallback">{{ room.nickname.slice(0, 1) }}</span>
                <span v-if="room.live" class="room-live-badge">LIVE</span>
                <!-- 未读数字角标（主进程未读检测 → stores/pocket-unread 镜像）：右上角，与右下 LIVE 点错开 -->
                <span
                  v-if="unreadCountOf(room.userId)"
                  class="unread-badge room-unread"
                >{{ roomUnreadText(room.userId) }}</span>
              </span>
              <span class="room-meta">
                <span class="room-name-row">
                  <span class="room-name ellipsis">{{ room.nickname }}</span>
                  <!-- 临时房间：本次会话临时打开的，不属于关注房间 -->
                  <span v-if="room.temporary" class="room-temp-tag">临时</span>
                </span>

                <span v-if="room.preview" class="room-preview ellipsis">{{ room.preview }}</span>
              </span>
              <!-- 右缘竖排小标签：星星在上（口袋关注），队伍徽标在下 -->
              <span
                v-if="room.teamName || isPocketFollowed(room.followSource)"
                class="room-side-tags"
              >
                <el-tooltip
                  v-if="isPocketFollowed(room.followSource)"
                  content="口袋账号关注（可在设置页拉取同步）"
                  placement="top"
                >
                  <el-icon class="room-follow-ico"><StarFilled /></el-icon>
                </el-tooltip>
                <span
                  v-if="room.teamName"
                  class="room-team"
                  :style="Tools.colorVarStyle('--tb-color', room.teamColor)"
                >{{ Tools.shortTeamName(room.teamName) }}</span>
              </span>
            </button>

            <!-- 关闭临时房间（悬浮显示；正看着时常驻，否则鼠标移开就找不到出口） -->
            <button
              v-if="room.temporary"
              type="button"
              class="room-temp-close"
              :aria-label="`关闭「${room.nickname}」的临时房间`"
              title="关闭临时房间"
              @click="closeTempRoom"
            >
              <el-icon :size="12">
                <Close />
              </el-icon>
            </button>
          </div>
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
                  v-if="selectedRoom.teamName"
                  class="room-team"
                  :style="Tools.colorVarStyle('--tb-color', selectedRoom.teamColor)"
                >{{ Tools.shortTeamName(selectedRoom.teamName) }}</span>
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
                :title="tab.locked ? `${tab.name} · 需要暗号` : tab.name"
                @click="onViewModeChange(tab.mode)"
              >
                <el-icon v-if="tab.locked" :size="12" class="room-tab-lock">
                  <Lock />
                </el-icon>
                <span class="room-tab-name">{{ tab.name }}</span>
                <span v-if="tab.unread" class="unread-badge">{{ unreadText(tab.unread) }}</span>
              </button>
            </div>
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
                <div class="scope-tabs" role="tablist" aria-label="消息范围">
                  <button
                    type="button"
                    role="tab"
                    class="scope-tab"
                    :class="{ 'is-active': messageScope === 'member' }"
                    :aria-selected="messageScope === 'member'"
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
                <!-- 聊天气泡卡片：日期分隔 + 头像 + 昵称行 + 气泡；系统通知居中弱化 -->
                <template v-for="(message, index) in messages" :key="message.id">
                  <div v-if="isDayBoundary(index)" class="msg-date-pill">
                    {{ dayLabel(message.msgTime) }}
                  </div>
                  <div
                    class="msg-row"
                    :class="[`msg-row--${message.kind}`, { 'msg-row--member': message.isMember, 'is-arriving': arrivingIds.has(message.id) }]"
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
                          <span v-if="message.isMember" class="msg-member-tag">房主</span>
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
                          <!-- 图片：el-image 自带点击放大预览 -->

                          <el-image
                            v-if="message.imageUrl"
                            class="msg-image"
                            :style="imageBoxStyle(message)"
                            :src="message.imageUrl"
                            :preview-src-list="[message.imageUrl]"
                            preview-teleported
                            lazy
                            fit="cover"
                            hide-on-click-modal
                            referrerpolicy="no-referrer"
                            @load="onMediaLoad"
                            @error="onMediaLoad"
                          >
                            <!-- 预览工具条：EP 默认那排没有下载，整排自绘后追加一项（见 ImageViewerToolbar） -->
                            <template #toolbar="{ actions, reset, activeIndex }">
                              <ImageViewerToolbar
                                :actions="actions"
                                :reset="reset"
                                :urls="[message.imageUrl]"
                                :active-index="activeIndex"
                              />
                            </template>
                          </el-image>
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
                          <button
                            v-else-if="message.kind === 'live'"
                            type="button"
                            class="msg-live"
                            :class="{ 'is-clickable': !!message.liveId }"
                            :disabled="!message.liveId"
                            :aria-label="`${liveCardBadge(message).text}：${liveShareTitle(message.text) || '快来看看吧'}`"
                            @click="openSharedLive(message)"
                          >
                            <span class="msg-live-cover">
                              <el-image
                                v-if="message.liveCover"
                                class="msg-live-cover-img"
                                :src="message.liveCover"
                                fit="cover"
                                lazy
                              >
                                <template #error>
                                  <span class="msg-live-cover-ph">
                                    <el-icon :size="22">
                                      <VideoCamera />
                                    </el-icon>
                                  </span>
                                </template>
                              </el-image>
                              <span v-else class="msg-live-cover-ph">
                                <el-icon :size="22">
                                  <VideoCamera />
                                </el-icon>
                              </span>
                              <!-- 封面蒙层与播放入口：强化分享卡的视频语义，同时保持角标在最上层 -->
                              <span class="msg-live-cover-mask" aria-hidden="true">
                                <span class="msg-live-play">
                                  <el-icon :size="24">
                                    <VideoCamera />
                                  </el-icon>
                                </span>
                              </span>
                              <span
                                class="msg-live-badge"
                                :class="`msg-live-badge--${liveCardBadge(message).type}`"
                              >{{ liveCardBadge(message).text }}</span>
                            </span>
                            <span class="msg-live-text">
                              <span class="msg-live-title">{{ liveShareTitle(message.text) || '快来看看吧' }}</span>
                              <span class="msg-live-meta">
                                <span v-if="message.liveStartTime">{{ shortTime(message.liveStartTime) }}</span>
                                <span v-if="message.liveId" class="msg-live-action">
                                  {{ liveCardBadge(message).type === 'playback' ? '观看回放' : '进入直播' }}
                                  <el-icon :size="12">
                                    <ArrowRight />
                                  </el-icon>
                                </span>
                              </span>
                            </span>
                          </button>
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

              <!-- 小房间暗号锁定层：不展示消息内容，仅在暗号校验通过后进房 -->
              <div v-else-if="smallLocked" class="small-lock">
                <div class="small-lock-card">
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
                <template v-else>
                  <p>暂无消息</p>
                  <p class="msg-empty-hint">
                    成员在房间里发送的文字、图片、语音与回复会显示在这里
                  </p>
                </template>
              </div>

              <footer v-if="statusText" class="main-foot">
                {{ statusText }}
              </footer>

              <!-- 上翻历史时收到新消息的浮标：点击回底 -->
              <button
                v-if="newCount > 0 && !atBottom"
                type="button"
                class="new-msg-float"
                @click="scrollToBottom"
              >
                <el-icon :size="12">
                  <ArrowRight />
                </el-icon>
                {{ newCount }} 条新消息
              </button>

              <!-- 消息右键菜单（Teleport 到 body 定位在光标处）：复制正文 / 媒体直链 -->
              <RoomMessageMenu
                v-if="menu"
                :x="menu.x"
                :y="menu.y"
                :items="menuItems"
                @pick="onMenuPick"
                @close="closeMenu"
              />
            </section>

            <aside class="rooms-aside detail-scroll">
              <RoomProfileCard
                :user-id="selectedRoom.userId"
                :nickname="selectedRoom.nickname"
                :avatar="selectedRoom.avatar"
                :team-name="selectedRoom.teamName"
                :team-color="selectedRoom.teamColor"
                :live="selectedRoom.live"
                :pocket-followed="isPocketFollowed(selectedRoom.followSource)"
                :pocket-follow-busy="pocketFollowBusy"
                @toggle-follow="togglePocketFollow"
              />
              <RoomAlbum :messages="messages" />
            </aside>
          </div>

          <!-- 精华消息弹层：外壳 / 标题头 / 滚动列复用 app.scss 的「详情卡片共用」，单栏列表；
               图片走 el-image 的预览（全屏查看 + 下载），与消息流同一套工具条 -->
          <el-dialog
            v-model="essenceOpen"
            class="detail-card-dialog essence-dialog"
            modal-class="detail-card-overlay"
            :show-close="false"
            align-center
            append-to-body
          >
            <div class="detail-card essence-card">
              <div class="detail-pane">
                <div class="detail-pane-head">
                  <span class="detail-pane-title">精华消息</span>
                  <span class="detail-pane-sub">{{ essenceMessages.length }} 条</span>
                  <span class="essence-hint">房间置顶 · 按时间倒序</span>
                </div>

                <div v-if="essenceMessages.length" class="essence-list detail-scroll">
                  <article
                    v-for="(item, index) in essenceMessages"
                    :key="item.id"
                    class="essence-item detail-pane-row"
                    :style="{ '--i': index }"
                  >
                    <img
                      v-if="item.avatar"
                      class="essence-avatar"
                      :src="avatarUrl(item.avatar)"
                      :alt="item.nick"
                      referrerpolicy="no-referrer"
                    >
                    <span v-else class="essence-avatar essence-avatar--fallback">{{ item.nick.slice(0, 1) }}</span>

                    <div class="essence-body">
                      <div class="essence-meta">
                        <span class="essence-nick" :class="{ 'is-member': item.isMember }">{{ item.nick }}</span>
                        <span v-if="item.isMember" class="essence-owner">房主</span>
                        <span class="essence-time">
                          {{ item.msgTime ? shortTime(item.msgTime) : '' }}
                        </span>
                      </div>

                      <!-- 媒体消息的正文只是「[图片消息]」这类占位，有图时不再重复一行 -->
                      <p v-if="!isPlaceholderText(item.text)" class="essence-text">
                        {{ item.text }}
                      </p>

                      <el-image
                        v-if="item.imageUrl"
                        class="essence-image"
                        :style="imageBoxStyle(item, 300)"
                        :src="item.imageUrl"
                        :preview-src-list="[item.imageUrl]"
                        preview-teleported
                        hide-on-click-modal
                        fit="cover"
                        referrerpolicy="no-referrer"
                      >
                        <template #toolbar="{ actions, reset, activeIndex }">
                          <ImageViewerToolbar
                            :actions="actions"
                            :reset="reset"
                            :urls="[item.imageUrl]"
                            :active-index="activeIndex"
                          />
                        </template>
                      </el-image>
                    </div>
                  </article>
                </div>

                <div v-else class="essence-empty">
                  <el-icon :size="26">
                    <StarFilled />
                  </el-icon>
                  <p>{{ essenceLoading ? '正在加载精华消息…' : '这个房间还没有精华消息' }}</p>
                  <p class="essence-empty-hint">
                    房主或管理员设为精华的消息会出现在这里
                  </p>
                </div>

                <div v-if="essenceMessages.length" class="essence-foot">
                  <el-button
                    v-if="!essenceExhausted"
                    size="small"
                    :loading="essenceLoading"
                    @click="loadMoreEssence"
                  >
                    加载更早的精华
                  </el-button>
                  <span v-else class="essence-end">没有更多了</span>
                </div>
              </div>

              <button class="detail-close" title="关闭" @click="essenceOpen = false">
                <el-icon :size="15">
                  <Close />
                </el-icon>
              </button>
            </div>
          </el-dialog>
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
  </div>
</template>

<style scoped lang="scss">
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
  padding: 4px 12px;
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

/* 双栏骨架：左栏固定宽度，右栏自适应；整页不滚动，两栏各自滚（给 Dock 留底部空间）。
 * box-sizing 必须显式声明：项目没有全局 border-box 重置，.page-root 的 height:100%
 * 若按 content-box 把上下内边距算到外面，整页会高出视口，滚动被甩给 .app-content */
.rooms-page {
  display: flex;
  box-sizing: border-box;
  gap: 14px;
  /* 本页无左上浮动 tab 栏，顶部内边距不走 --page-pad（那含 64px tab 预留） */
  padding: 14px 14px var(--dock-reserve);
  overflow: hidden;
}

/* ===== 登录引导（未登录整页占位） ===== */
.gate {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;

  .gate-icon {
    width: 56px;
    height: 56px;

    .el-icon {
      font-size: 26px;
    }
  }

  .gate-title {
    margin: 4px 0 0;
    font-size: 17px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .gate-sub {
    max-width: 420px;
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }
}

/* ===== 左栏：关注房间列表 ===== */
.rooms-side {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 300px;
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
  padding: 14px 14px 10px;

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
.room-wrap {
  position: relative;

  /* 临时条目右侧留出关闭钮的位置，昵称与预览不会压到按钮底下 */
  &.is-temp .room-meta {
    padding-right: 18px;
  }
}

/* 关闭临时房间：压在条目右上，悬浮显示、正看着时常驻。
 * 用 visibility 而非只靠 opacity：不可见时同时屏蔽命中，不留点得到的隐形按钮 */
.room-temp-close {
  position: absolute;
  top: 7px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.18s ease,
    visibility 0s linear 0.18s,
    color 0.15s ease,
    background-color 0.15s ease;

  .room-wrap:hover &,
  .room-wrap:focus-within &,
  .room-item.is-active ~ & {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }

  &:hover {
    color: #fff;
    background: var(--el-color-danger);
  }
}

.room-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  border: none;
  border-radius: 12px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s ease;

  &:hover {
    background: var(--el-fill-color-light);
  }

  &.is-active {
    background: color-mix(in srgb, var(--color-rooms) 14%, transparent);

    .room-name {
      color: var(--color-rooms);
      font-weight: 600;
    }
  }
}

.room-avatar {
  position: relative;
  flex: none;
  width: 42px;
  height: 42px;

  img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    background: var(--el-fill-color-light);
  }
}

.room-avatar-fallback {
  @extend %brand-avatar;

  width: 100%;
  height: 100%;
  font-size: 16px;
}

/* 开播角标：贴在头像右下角的 LIVE 小点 */
.room-live-badge {
  position: absolute;
  right: -3px;
  bottom: -2px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  color: #fff;
  background: var(--color-lives);
  box-shadow: 0 0 0 2px var(--el-bg-color);
}

/* 未读数字角标：贴在头像右上角（LIVE 点在右下角，两者不打架）；
 * 外观走全局 .unread-badge，这里只给落点与外描边（把角标从头像上抬出来） */
.room-unread {
  position: absolute;
  top: -5px;
  right: -5px;
  box-shadow: 0 0 0 2px var(--el-bg-color);
}

.room-meta {
  flex: 1;
  min-width: 0;
}

.room-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.room-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.room-team {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  color: var(--tb-color, var(--brand-primary));
  background: color-mix(in srgb, var(--tb-color, var(--brand-primary)) 12%, transparent);
}

/* 「临时」标记（左列条目与右栏头部共用）：造型与 .room-team 同规格，换房间主题青 + 描边，
 * 一眼与「关注房间」区分开——它不会在下次进页面时还在 */
.room-temp-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  color: var(--color-rooms);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-rooms) 34%, transparent);
}

/* 条目右缘竖排小标签列：口袋关注星标在上、队伍徽标在下。
 * 固定列宽：队伍徽标宽窄不一时，各行星星仍横向对齐（过长的队名截断省略） */
.room-side-tags {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 38px;
  margin-left: 6px;
}

.room-side-tags .room-team {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 口袋关注星标：11px 品牌色（语义：已关注），详情看 tooltip 与资料卡 */
.room-follow-ico {
  flex: none;
  font-size: 11px;
  color: var(--brand-primary);
  opacity: 0.8;
}

/* 左列预览：频道最新一条消息（批量接口一次拉全，选中房间轮询到时本地即时补） */
.room-preview {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-placeholder);
}

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

/* 四处空态的次级提示行（.essence-empty 里带父选择器是为压过其 p 的 13px） */
.side-empty-hint,
.msg-empty-hint,
.main-placeholder-hint,
.essence-empty .essence-empty-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}

/* ===== 右栏：房间消息 ===== */
.rooms-main {
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
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

/* 消息范围切换（只看房主 / 全部消息）：聊天区右上角，中性配色。
 * 与头部频道页签（房间青）分两层——这里是次级筛选，不抢导航的视觉权重 */
.chat-tools {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 16px 0;
}

/* 顶部精华条：房间置顶精华消息的入口，展示最新一条。
 * 与右侧消息范围同一行——两者都是消息区的次级控件，不额外占一行高度。
 * 整条可点，正文单行省略；没有精华时整条不渲染（见模板 v-if） */
.essence-bar {
  display: flex;
  align-items: center;
  gap: 6px;
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

.essence-bar-nick {
  flex: none;
  color: var(--el-text-color-secondary);
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

/* ===== 精华消息弹层（外壳 / 标题头 / 滚动列见 app.scss「详情卡片共用」，这里只留列表与条目） ===== */
/* 关闭钮落在浅色标题头上：按专辑卡的口径给深色图标（几何与悬停态在全局） */
.essence-card {
  /* 投影跟着房间主题青走，与页面语义色一致 */
  --accent: var(--color-rooms);
  --detail-close-bg: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
  --detail-close-ink: var(--el-text-color-secondary);
}

/* 标题头右侧提示：左推靠关闭钮，与曲目卡的「↑ ↓ 切换专辑」同一位置 */
.essence-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* 列表自持滚动，撑满标题头与底部翻页条之间的空间 */
.essence-list {
  flex: 1;
  padding: 6px 10px 14px;
}

.essence-item {
  display: flex;
  gap: 10px;
  padding: 12px 10px;
  border-radius: var(--radius-md);
  transition: background-color 0.18s ease;

  &:hover {
    background: color-mix(in srgb, var(--color-rooms) 6%, transparent);
  }

  & + .essence-item {
    border-top: 1px solid var(--el-border-color-extra-light);
  }
}

.essence-avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--el-fill-color-light);
  box-shadow: 0 0 0 1px var(--el-border-color-extra-light);
}

.essence-avatar--fallback {
  @extend %brand-avatar;

  font-size: 13px;
}

.essence-body {
  flex: 1;
  min-width: 0;
}

.essence-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.essence-nick {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &.is-member {
    color: color-mix(in srgb, var(--color-rooms) 78%, #000);
  }
}

/* 房主标：与消息流的「房主」小标同义，靠房间青区分 */
.essence-owner {
  flex: none;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
  color: color-mix(in srgb, var(--color-rooms) 72%, #000);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
}

.essence-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.essence-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 图片可点开全屏预览（el-image 内置 viewer），与消息流一样给 zoom-in 光标 */
.essence-image {
  display: block;
  max-width: min(300px, 100%);
  max-height: 260px;
  margin-top: 8px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--el-fill-color-light);
  cursor: zoom-in;
}

/* 底部翻页条：固定在栏底，列表再长也不用来回滚到底找按钮 */
.essence-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.essence-end {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* 空态：占满标题头以下的整块区域，与消息区的空态同一套语言 */
.essence-empty {
  @extend %empty-block;

  gap: 6px;
  padding: 24px;
  color: var(--el-text-color-secondary);

  .el-icon {
    color: color-mix(in srgb, var(--color-follow) 62%, var(--el-text-color-secondary));
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

.scope-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--el-fill-color-light);
}

.scope-tab {
  @extend %pill-tab;

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

.main-avatar {
  flex: none;
  width: 44px;
  height: 44px;

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
  margin: 3px 0 0;
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
  display: flex;
  flex: none;
  gap: 2px;
  max-width: 340px;
  margin-left: auto;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--el-fill-color-light);
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

/* 小房间暗号锁定层：盖住消息区，不展示任何消息内容。
 * 卡片自成一块「门牌」：徽标 → 标题 → 成员出的题（引用块）→ 输入行 → 兜底提示。
 * 题目是成员手写的原话，用引用块而非正文呈现，避免与界面自己的措辞混作一类。 */
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
  width: 264px;
  padding: 12px;
  overflow-y: auto;
  border-left: 1px solid var(--el-border-color-lighter);
}

.msg-scroll {
  flex: 1;
  box-sizing: border-box;
  min-height: 0;
  padding: 12px 16px;

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
  /* 到达高亮时长由页面按 ARRIVE_FLASH_MS 注入：动画与类的移除同一节拍 */
  --arrive-flash: 1200ms;
}

/* 加载更早历史：贴在消息流顶部的状态行（滚动到顶自动触发，不再有按钮） */
.msg-more {
  display: flex;
  justify-content: center;
  padding-bottom: 8px;
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
  gap: 10px;
  padding: 5px 2px;
  border-radius: var(--radius-sm);
}

.msg-avatar {
  flex: none;
  width: 34px;
  height: 34px;
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
  background: var(--color-rooms);
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
  max-width: 100%;
  padding: 7px 12px;
  border-radius: var(--radius-xs) var(--msg-radius) var(--msg-radius) var(--msg-radius);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-regular);
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
  .msg-avatar {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-rooms) 55%, transparent);
  }

  .msg-nick {
    color: var(--color-rooms);
  }

  .msg-bubble:not(.msg-bubble--media) {
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--color-rooms) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-rooms) 30%, transparent);
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

.msg-live {
  display: flex;
  flex-direction: column;
  width: 272px;
  min-width: 0;
  padding: 0;
  border: none;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  /* 与气泡内壁同心：外角取同心内角，收角一侧与气泡收角对齐 */
  border-radius: var(--radius-xs) var(--msg-radius-inner) var(--msg-radius-inner) var(--msg-radius-inner);

  &.is-clickable {
    cursor: pointer;

    &:hover {
      .msg-live-cover-img {
        transform: scale(1.04);
      }

      .msg-live-action {
        color: var(--color-lives);
      }

      .msg-live-play {
        transform: translateY(-1px) scale(1.08);
        background: color-mix(in srgb, var(--color-lives) 82%, #000);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--color-lives) 42%, transparent);
      }
    }
  }
}

.msg-live-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  /* 与卡片同角（卡片 padding 为 0，内角不再递减），左上咬合气泡收角 */
  border-radius: var(--radius-xs) var(--msg-radius-inner) var(--msg-radius-inner) var(--msg-radius-inner);
  background: var(--el-fill-color);
}

.msg-live-cover-img {
  display: block;
  width: 100%;
  height: 100%;
  transition: transform 0.3s ease;
}

/* 直播封面蒙层：底部稍深，保证中央播放入口与页面底色之间总有足够对比 */
.msg-live-cover-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, 18%), rgba(0, 0, 0, 46%));
}

.msg-live-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border: 1px solid rgba(255, 255, 255, 50%);
  border-radius: 50%;
  color: #fff;
  background: rgba(0, 0, 0, 42%);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 28%);
  backdrop-filter: blur(8px);
  transition:
    transform 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

/* 封面兜底：解析不到封面或加载失败时回退类型图标（直播色渐变块，与 LiveItem error 槽同思路） */
.msg-live-cover-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-lives) 70%, #fff), var(--color-lives));
}

/* 类型角标叠封面左上角（LiveItem 同位）；配色对齐 LiveItem（直播玫红 / 电台绿 / 录屏琥珀），回放中性灰 */
.msg-live-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  padding: 1px 7px;
  border-radius: var(--msg-radius-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
  color: #fff;

  &.msg-live-badge--live {
    background: var(--color-lives);
  }

  &.msg-live-badge--radio {
    background: var(--color-downloads);
  }

  &.msg-live-badge--screen {
    background: var(--color-shows);
  }

  &.msg-live-badge--playback {
    background: var(--el-color-info);
  }
}

.msg-live-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 10px 6px 5px;
}

.msg-live-title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  color: var(--el-text-color-primary);
}

.msg-live-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}

/* 动作提示：可点时才渲染，文案按回放/直播区分（观看回放 / 进入直播） */
.msg-live-action {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  color: var(--el-text-color-secondary);
  transition: color 0.18s ease;
}

/* 媒体气泡：去掉外层聊天底框，媒体贴边展示（自带圆角/底色） */
.msg-bubble--media {
  padding: 0;
  background: none;
}

.msg-image {
  display: block;
  max-width: 240px;
  max-height: 280px;
  border-radius: var(--msg-radius);
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
  margin: 10px auto 4px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--el-text-color-placeholder);
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
  padding: 8px 16px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
