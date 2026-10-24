<script setup lang="ts">
import type { LiveResultView } from '@renderer/services/live-result'
import type { PocketDisableNotice, PocketRankUser } from '@renderer/utils/pocket-chat-message'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { useDanmakuLayer } from '@renderer/composables/use-danmaku-layer'
import { useLiveDanmaku } from '@renderer/composables/use-live-danmaku'
import { useLivePlayer } from '@renderer/composables/use-live-player'
import { useLiveSession } from '@renderer/composables/use-live-session'
import useMediaDownload from '@renderer/composables/use-media-download'
import { dispatchMediaShortcut } from '@renderer/composables/use-media-shortcuts'
import { useSleepBlocker } from '@renderer/composables/use-sleep-blocker'
import { useStreamRetry } from '@renderer/composables/use-stream-retry'
import { useVideoRotation } from '@renderer/composables/use-video-rotation'
import EventBus from '@renderer/services/event-bus'
import { loadLiveResult } from '@renderer/services/live-result'
import { danmakuPlacement, ensureDanmakuPlacement, setDanmakuPlacement } from '@renderer/stores/danmaku-placement'
import { pocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'
import { isUnavailableLiveMessage } from '@renderer/utils/live-stream'
import { formatMediaTime } from '@renderer/utils/time-format'
import Tools from '@renderer/utils/tools'
import { durationBucket, trackEvent } from '@renderer/utils/umami'
import { formatViewNum } from '@renderer/utils/view-num'

import { useEventListener, useIntervalFn } from '@vueuse/core'

import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import DanmakuBubbles from './DanmakuBubbles.vue'
import MiniControls from './MiniControls.vue'
import PlayerLoading from './PlayerLoading.vue'
import RadioStage from './RadioStage.vue'
import RotationControls from './RotationControls.vue'

const props = defineProps({
  liveId: { type: String, required: true },
  /** 开演时间（毫秒时间戳），用于计算已播时长 */
  startTime: { type: Number, required: true },
  /** 1=视频直播（走 <video>），其它=电台（纯音频，走 RadioStage 的 <audio>） */
  liveType: { type: Number, required: true },
  liveMode: { type: Number, required: true },
  /** 数据源：user=用户直播(getLiveOne)，open=开放公演(getOpenLiveOne) */
  source: { type: String, default: 'user' },
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatarUrl: { type: String, default: '' },
  /** 紧凑模式：隐藏次要信息，适配小尺寸独立播放窗 */
  compact: { type: Boolean, default: false },
  /** 该公演在 B 站的直播间号；0 = 没有对应房间（个人直播），不显示弹幕入口 */
  bilibiliRoomId: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'avatar', 'aspect', 'playing'])

const nativeVideo = ref<HTMLVideoElement | null>(null)
// 电台模式的 audio 元素由 RadioStage 挂载/卸载时经 @audio 事件回传
const nativeAudio = ref<HTMLAudioElement | null>(null)
const videoBoxRef = ref<HTMLElement | null>(null)
const mediaLoading = ref(true)
// 下播结束态：停流后画面切复盘卡片（官方 LiveCloseFragment 同构），用户点关闭才关窗
const liveEnded = ref(false)
/** 复盘数据（live/result）；null = 没拉到（未登录 / 接口失败），结束卡降级简版 */
const liveResult = ref<LiveResultView | null>(null)
/** 结束卡头像加载失败记账（按 userId）：回退用户名首字母 */
const failedEndAvatars = reactive(new Set<string>())
// 鼠标悬浮才响应快捷键：同屏可能有多个浮窗播放器，否则一次按键会把它们全部转一遍。
// 触发策略与 PlaybackPlayer 不同（它走根节点焦点制），但按键分派共用 use-media-shortcuts。
const hovered = ref(false)
// 卸载标记：置位后所有在途异步回包直接丢弃
const isManuallyUnmounted = ref(false)

// Umami：一场直播只计一次成功播放（首次 canplay）；观看时长以首次出画为起点，
// 卸载时按分桶上报（durationBucket），不打精确秒数
let livePlayTracked = false
let livePlayStartedAt = 0

const isRadio = computed(() => props.liveType !== 1)

/** 详情/轮询明确反馈直播已终结：广播下架 + 关闭浮窗 */
function closeUnavailableLive() {
  debugLog('live', `①直播:直播反馈不可用，关闭浮窗（liveId=${props.liveId}）`)
  ElMessage.error('直播不存在')
  EventBus.emit('live-unavailable', props.liveId)
  emit('close')
}

// 播放防休眠（use-sleep-blocker，与 PlaybackPlayer 共用）
const { acquire: acquireSleepBlocker, release: releaseSleepBlocker } = useSleepBlocker()

// 旋转 / 容器全屏 / 迷你控制条状态：与 PlaybackPlayer 共用同一套实现（useVideoRotation）
const {
  rotationAngle,
  videoRect,
  videoWrapperStyle,
  videoStyle,
  rotateHint,
  rotateLeft,
  rotateRight,
  resetRotation,
  onBoxDblClick,
  isFullscreen,
  toggleFullscreen,
  playing,
  muted,
  togglePlay,
  toggleMute,
  onVolumeChange,
  updateVideoDimensions,
} = useVideoRotation({
  videoBoxRef,
  getMedia: () => (isRadio.value ? nativeAudio.value : nativeVideo.value),
  getVideo: () => nativeVideo.value,
  isRadio,
  onAspect: aspect => emit('aspect', aspect),
})

// 播放/暂停上报父级：独立播放窗据此决定是否置顶（播放中才置顶）。
// 只上报「变化」而不带上初值：窗口刚打开时还在加载，此刻保持创建时的置顶态，
// 免得视频还没出画面就先掉到别的窗口后面。
watch(playing, value => emit('playing', value))

// ── 弹幕（双源按直播类型分流）────────────────────────────────────
// 公演（open）只用 B 站弹幕（房间号由 payload 携带）；个人直播（user）只用口袋48互动消息
// （聊天室 ID 由详情接口携带，需登录且直播进行中）。两类互不混用。
const danmakuRoomId = computed(() => (props.source === 'open' && props.bilibiliRoomId > 0 ? props.bilibiliRoomId : undefined))
const danmakuEnabled = ref(true)
// 摆放偏好是全局单例，读一次即可（两个播放器并发调用共用同一次 IPC）
void ensureDanmakuPlacement()

const {
  fontSize: danmakuFontSize,
  position: danmakuPosition,
  topLeft: rankPosition,
  canFloatLeft: canFloatDanmaku,
  floating: danmakuFloating,
} = useDanmakuLayer({
  videoRect: () => videoRect.value,
  compact: () => props.compact,
  fullscreen: () => isFullscreen.value,
  // 黑边不够宽（videoRect.left < 60）时由 computeDanmakuLayout 自行回落画面内，
  // 与全屏无关：窗口态下竖屏直播同样留得出左侧栏
  placement: () => danmakuPlacement.value,
  // 公演 B 站弹幕可能很长；限制在窗口宽度的 33%，避免单条横跨整块画面
  maxWidth: () => (props.source === 'open' ? '33vw' : undefined),
})

/** 摆放只在「左侧黑边够宽」时开放：按钮只在此时出现，状态由 is-on 表示（不用 disabled） */
function toggleDanmakuPlacement() {
  const next = danmakuFloating.value ? 'video' : 'left'
  void setDanmakuPlacement(next)
  trackEvent('danmaku:placement', { placement: next })
}

// ── 已播时长（在线人数不走轮询，见下方 LIVEUPDATE）──────────────
const elapsedTime = ref(0)
const elapsedTimer = useIntervalFn(() => {
  elapsedTime.value = Date.now() - props.startTime
}, 1000, { immediate: false, immediateCallback: true })
const liveElapsedText = computed(() => {
  const totalSeconds = Math.max(0, Math.floor(elapsedTime.value / 1000))
  return formatMediaTime(totalSeconds)
})

// 在线人数：首帧来自会话详情，实时值来自口袋 LIVEUPDATE 推送（与官方 App 同构）；
// 未登录 / 开放公演无 IM 会话时保持首帧值，open 接口恒不带故显示为空
const onlineNum = ref(0)
/** 累计礼物流水（LIVEUPDATE.allMoney）：0 = 未收到，榜单面板不显示该段 */
const liveAllMoney = ref(0)

// ── 直播会话：详情获取 + 本地 HTTP-FLV 生命周期 ──────────────────
const session = useLiveSession({
  liveId: () => props.liveId,
  source: () => props.source,
  avatarUrl: () => props.avatarUrl,
  isRadio: () => isRadio.value,
  isDisposed: isManuallyUnmounted,
  onAvatar: avatarUrl => emit('avatar', avatarUrl),
  onOnlineNum: (num) => {
    onlineNum.value = num
  },
  // 详情都取不到通常意味着直播已下架：广播通知列表页刷新
  onUnavailable: closeUnavailableLive,
  // 回调依赖 retry/player，创建顺序成环，统一走提升的函数声明（见文件末尾）
  onBeforeRebuild: rebuildMedia,
  onSessionStart: beginSession,
})

// 详情展示状态直接解构给模板（解构出的仍是 ref，不丢响应性）。
// localPlaybackUrl = 本地 HTTP-FLV 地址，下方 watch 盯着它重建播放器
const { localPlaybackUrl, coverImage, realName, carousels, carouselTime, chatroomId, ownerUserId, activeRtmpUrl } = session

// 弹幕订阅须在 session 之后创建：口袋源读 session.chatroomId，同步时立即求值
const pocketChatroomId = computed(() => (props.source === 'user' ? chatroomId.value : ''))
/** 有任一弹幕源才显示气泡层与开关（个人直播未登录时两边都没有，连开关都不给） */
const hasDanmakuRoom = computed(() => danmakuRoomId.value !== undefined || !!pocketChatroomId.value)
const showDanmaku = computed(() => hasDanmakuRoom.value && danmakuEnabled.value)

/** 弹幕开关：翻转并上报使用率（只记用户主动切换，不记初始状态） */
function toggleDanmaku() {
  danmakuEnabled.value = !danmakuEnabled.value
  trackEvent('danmaku:toggle', { enabled: danmakuEnabled.value ? 1 : 0 })
}

// ── 互动榜单（口袋 LIVEUPDATE 消息）─────────────────────────────
// 榜单不进气泡层，独立显示在画面右上角（.player-actions 下方）；可由胶囊开关收起。
// 同报文的 online / allMoney 路由到胶囊在线人数与榜单面板的礼物流水段
const rankUsers = ref<PocketRankUser[]>([])
const rankVisible = ref(true)
/** 加载失败的榜单头像（按 userId 记账）：回退首字母占位 */
const failedRankAvatars = reactive(new Set<string>())

// ── 结束卡三围（复盘权威值优先，回落本地已采集的数据）────────────────
/** 本场时长：复盘 liveTime（毫秒）优先，回落本地已播时长 */
const endDurationText = computed(() => {
  const liveTime = liveResult.value?.liveTime ?? 0
  return liveTime > 0 ? formatMediaTime(Math.floor(liveTime / 1000)) : liveElapsedText.value
})
/** 总观看：只有复盘有（口径见 live-result 注释，0 = 没拉到，不显示该段） */
const endOnline = computed(() => liveResult.value?.liveOnline ?? 0)
/** 总礼物：复盘 totalMoney 优先，回落 LIVEUPDATE 累计流水 */
const endGift = computed(() => liveResult.value?.totalMoney || liveAllMoney.value)
/** 榜单前三：与互动榜同构，头像/昵称/贡献值 */
const endTopUsers = computed(() => liveResult.value?.topUsers.slice(0, 3) ?? [])

/**
 * 被禁言/拉黑/踢出（DISABLE_SPEAK，官方 LiveStreamV2Fragment 同构）：
 * 踢出（官方消息版唯一动作）——targetId==本人才关播，非本人（含自己 ID 缺失）不动；
 * 禁言/拉黑（官方通知版语义，服务端若双发则经消息版到达）——门控后提示，
 * 禁言重取详情（刷新失败静默，不影响播放），拉黑关浮窗（不重取）
 */
async function handleDisableSpeak(notice: PocketDisableNotice) {
  if (notice.op === 3) {
    if (notice.targetId && notice.targetId !== pocketAuthState.value.userId)
      return
    ElMessage.warning('你已经被踢出直播间')
    emit('close')
    return
  }
  // 门控：成员操作直接放行，管理员须是房主本人，其余不放行
  if (notice.operatorType === 2) {
    if (!ownerUserId.value || notice.operatorId !== ownerUserId.value)
      return
  }
  else if (notice.operatorType !== 1) {
    return
  }
  if (notice.op === 2) {
    ElMessage.warning('你已被拉黑')
    emit('close')
    return
  }
  ElMessage.warning('你已被禁言')
  try {
    const data = await session.fetchLiveDetail()
    if (isManuallyUnmounted.value || liveEnded.value)
      return
    session.applyLiveDetail(data)
  }
  catch (error) {
    debugLog('live', `①直播:禁言后重取详情失败 ${error}`)
  }
}

const { danmakuItems, stop: stopDanmaku } = useLiveDanmaku({
  roomId: () => danmakuRoomId.value,
  liveId: () => props.liveId,
  pocketRoomId: () => pocketChatroomId.value,
  enabled: () => danmakuEnabled.value,
  onRank: (users) => {
    rankUsers.value = users
    debugLog('rankUsers', users)
    // 换场清榜时一并清头像失败记录，下一场从头加载
    if (!users.length)
      failedRankAvatars.clear()
  },
  onLiveUpdate: ({ online, allMoney }) => {
    // 0 视为无效值不采纳：人数不会瞬间泄为 0，接了只会让显示消失
    if (online !== undefined && online > 0)
      onlineNum.value = online
    if (allMoney !== undefined)
      liveAllMoney.value = allMoney
  },
  onDisableSpeak: handleDisableSpeak,
  onLiveEnd: closeLiveEnded,
  onLiveRestream: handleLiveRestream,
})

// ── mpegts 播放器实例 ────────────────────────────────────────────
const player = useLivePlayer({
  getMedia: () => (isRadio.value ? nativeAudio.value : nativeVideo.value),
  isRadio: () => isRadio.value,
  isDisposed: () => isManuallyUnmounted.value,
  mediaLoading,
  onCanPlay: onPlayerCanPlay,
  onLoadedMetadata: () => updateVideoDimensions(),
  onError: handleStreamError,
})

// ── 断流重试状态机 ───────────────────────────────────────────────
const retry = useStreamRetry({
  // 结束态后不再安排任何重试：停流触发的错误事件与在途 attempt 都必须失效
  isDisposed: () => isManuallyUnmounted.value || liveEnded.value,
  mediaLoading,
  attempt: recoverStream,
  onExhausted: handleRetryExhausted,
})

/** 单次恢复尝试：拉详情 → 重建流（节奏由重试状态机安排） */
async function recoverStream() {
  debugLog('live', `①直播:重试恢复尝试（第 ${retry.retryCount.value + 1} 次）`)
  try {
    const data = await session.fetchLiveDetail()
    // 拉详情期间可能已进结束态（CLOSELIVE 与断流常结伴而来）：此时再重建就是把停掉的流拉回来
    if (isManuallyUnmounted.value || liveEnded.value)
      return
    session.applyLiveDetail(data)
    await session.restartLiveStream(data.playStreamPath)
  }
  catch (error) {
    // 详情明确返回直播已终结（已删除/回放生成中）：跳过剩余重试，直接关闭
    if (error instanceof Error && isUnavailableLiveMessage(error.message)) {
      debugLog('live', `①直播:重试时详情反馈「${error.message}」，立即关闭直播窗口`)
      session.stopStreamNow()
      closeUnavailableLive()
      return
    }
    throw error
  }
}

/** 会话启动（getLiveOne 开始）：复位 loading 与重试计数 */
function beginSession() {
  debugLog('live', `①直播会话开始（liveId=${props.liveId}, source=${props.source}），复位 loading 与重试计数`)
  mediaLoading.value = true
  retry.reset()
}

/** canplay：加载完成，复位恢复态与重试预算并刷新视频尺寸 */
function onPlayerCanPlay() {
  debugLog('live', '①直播:播放就绪（canplay），复位恢复态与重试预算')
  retry.markRecovered()
  // Umami 事件：首次出画才算成功播放；断流重连后的 canplay 不重复计数
  if (!livePlayTracked) {
    livePlayTracked = true
    livePlayStartedAt = Date.now()
    trackEvent('live:play', { source: props.source, media: isRadio.value ? 'radio' : 'video', title: realName.value })
  }
  if (!isRadio.value)
    updateVideoDimensions()
}

/** 重建流之前：清重试计时器、销毁播放器、复位媒体元素 */
function rebuildMedia() {
  debugLog('live', '①直播:重建流前清理（重试计时器/播放器实例/媒体元素）')
  retry.clearTimer()
  player.destroyPlayer()
  player.resetMediaElement()
}

/** 媒体元素/FLV 错误统一处理：网络错误保持 loading 重试，致命错误先销毁播放器 */
function handleStreamError(reason: string, isNetwork: boolean) {
  // 结束态后停流必然触发错误事件：不再进重试链，否则会把已结束的直播反复重拉
  if (liveEnded.value)
    return
  // Umami 事件：播放器错误（网络类会自动进重试，这里记的是发生频率而非后果）
  trackEvent('player:error', { type: 'live', network: isNetwork ? 1 : 0 })
  if (isNetwork) {
    debugLog('live', `①直播:网络错误（${reason}），保持 loading 并重试`)
    mediaLoading.value = true
  }
  else {
    debugLog('live', `①直播:致命错误（${reason}），先销毁播放器再重试`)
    player.destroyPlayer()
    mediaLoading.value = false
  }
  retry.schedule()
}

/**
 * 进入下播结束态（官方 LiveCloseFragment 同构：停流后画面切结束卡，用户点关闭才关窗）。
 * 两个入口：CLOSELIVE 快路径（服务端推送即达）与重试耗尽兜底（未登录 / 公演 / 消息丢失）。
 * 去重：两条路径可能结伴到达（下播时推流中断必触发错误）。
 */
async function enterLiveEnded() {
  if (liveEnded.value)
    return
  liveEnded.value = true
  debugLog('live', `①直播:进入结束态（liveId=${props.liveId}），停流并拉复盘`)
  // 先收摊再拉复盘：计时 / 重试 / 弹幕会话全部停掉，停流触发的错误事件被 liveEnded 拦下
  elapsedTimer.pause()
  retry.reset()
  stopDanmaku()
  session.stopStreamNow()
  player.destroyPlayer()
  player.resetMediaElement()
  mediaLoading.value = false
  EventBus.emit('live-unavailable', props.liveId)
  try {
    const result = await loadLiveResult(props.liveId)
    if (isManuallyUnmounted.value)
      return
    liveResult.value = result
  }
  catch (error) {
    // 未登录 / 接口失败都降级简版卡：本地已有的主播名 + 已播时长也够交代这一场
    debugLog('live', `①直播:复盘拉取失败，降级简版结束卡 ${error}`)
  }
}

/** 重试耗尽视为直播结束（兜底路径）：进结束态展示复盘，不再直接关窗 */
function handleRetryExhausted() {
  debugLog('live', `①直播:重试耗尽（${retry.retryCount.value} 次），视为直播结束，进入结束态`)
  void enterLiveEnded()
}

/** 主播下播（CLOSELIVE，官方收到即切结束态）：进结束态展示复盘，不再直接关窗 */
function closeLiveEnded() {
  debugLog('live', `①直播:收到 CLOSELIVE，直播结束（liveId=${props.liveId}）`)
  void enterLiveEnded()
}

/**
 * 连麦/PK 换流信号（INFORM_PULL_STREAM）：推流地址主体不变、token 变，
 * 拉详情拿新 token 重建本地会话；地址没变则跳过（服务端推了信号但详情未变）。
 * 不走重试计数——重建失败才转重试链兜底；下播判决归 CLOSELIVE 与重试耗尽
 */
async function handleLiveRestream() {
  debugLog('live', '①直播:收到换流信号（连麦/PK），拉详情换 token 重建流')
  mediaLoading.value = true
  try {
    const data = await session.fetchLiveDetail()
    if (isManuallyUnmounted.value || liveEnded.value)
      return
    session.applyLiveDetail(data)
    if (data.playStreamPath === activeRtmpUrl.value) {
      debugLog('live', '①直播:换流信号但详情地址未变，跳过重建')
      mediaLoading.value = false
      return
    }
    await session.restartLiveStream(data.playStreamPath)
  }
  catch (error) {
    // 换流期间详情失败不关窗（可能是瞬时抖动）：交给断流重试链兜底
    debugLog('live', `①直播:换流重建失败，转重试链兜底 ${error}`)
    retry.schedule()
  }
}

// ── 录制 ─────────────────────────────────────────────────────────
// 录制发起流程由 useMediaDownload 统一处理（目录校验 / 文件名 / 任务下发与回放下载共用）；
// 录制走原始 RTMP 地址直存文件，和页面播放的 HTTP-FLV 链路保持解耦。
// 状态查询与停止取共享任务 store：任务由谁发起、下载页是否挂载都不影响这里
const { running: recording, onActionClick: onRecordClick } = useMediaDownload({
  kind: 'record',
  liveId: () => props.liveId,
  getRealName: () => realName.value,
  startTime: () => props.startTime,
  ext: () => 'flv',
  separator: () => ' ',
  // 每次录制都拉最新详情：直播的 RTMP 地址会随推流变化，用缓存的旧地址可能拉不到流
  getUrl: async () => {
    try {
      const detail = await session.fetchLiveDetail()
      return detail.playStreamPath
    }
    catch (error) {
      // 失败原因已由 apis.ts 的 request() 统一弹窗提示（直播已下架/网络错误）
      debugLog('live', `①直播:获取录制源地址失败 ${error}`)
      return null
    }
  },
})

// ── 键盘快捷键（悬浮制：仅视频模式、鼠标悬浮时响应） ─────────────────────────
// 按键分派与 PlaybackPlayer 共用 dispatchMediaShortcut（键位单源）；
// 直播场景只接旋转族快捷键（seek/音量对直播流无意义，不传对应 action 即不响应）
function onKeyDown(event: KeyboardEvent) {
  if (isRadio.value || !hovered.value || event.ctrlKey || event.metaKey || event.altKey)
    return
  const consumed = dispatchMediaShortcut(event, {
    rotateLeft,
    rotateRight,
    resetRotation,
  }, null)
  if (consumed)
    event.preventDefault()
}

useEventListener(window, 'keydown', onKeyDown)

/** 挂载播放器；环境不支持 HTTP-FLV 时统一在此提示 */
function mountPlayer(path: string) {
  if (!player.setupPlayer(path))
    ElMessage.error('当前环境不支持 HTTP-FLV 直播播放')
}

/** 续播：浮窗回到前台 / 重新挂载时按播放器现存状态恢复 */
async function resumeLive() {
  if (isManuallyUnmounted.value)
    return
  await acquireSleepBlocker()
  elapsedTimer.resume()
  // 播放器仍在则直接续播，否则按缓存地址重建或全量拉流
  if (player.hasPlayer()) {
    player.play()
  }
  else if (localPlaybackUrl.value) {
    mountPlayer(localPlaybackUrl.value)
  }
  else {
    await session.getLiveOne()
  }
}

let playerWatchStopHandle: (() => void) | null = null

onMounted(() => {
  // 播放器实例跟随播放地址：地址一变就重建。
  // 首次播放 / 断流重试 / 恢复播放都只是「写 localPlaybackUrl」，
  // 重建播放器的逻辑收敛在这一处（immediate 让首挂载也走同一条路径）。
  playerWatchStopHandle = watch(
    () => localPlaybackUrl.value,
    (newPath) => {
      if (isManuallyUnmounted.value)
        return
      mountPlayer(newPath)
    },
    { immediate: true },
  )

  // 迷你窗存在即启动播放会话
  resumeLive()
})

onUnmounted(() => {
  // 先 dispose：所有在途异步回包（详情响应、开会话响应）立即失效
  session.dispose()
  retry.clearTimer()
  elapsedTimer.pause()
  if (playerWatchStopHandle) {
    playerWatchStopHandle()
    playerWatchStopHandle = null
  }
  player.destroyPlayer()
  player.resetMediaElement()
  // Umami 事件：观看时长分桶。浮窗整体关闭时组件同步卸载，
  // umami script 走 sendBeacon / keepalive，正常网络下能送达
  if (livePlayTracked) {
    trackEvent('play:duration', { type: 'live', bucket: durationBucket((Date.now() - livePlayStartedAt) / 1000) })
  }
  releaseSleepBlocker()
})
</script>

<template>
  <div class="live-player">
    <div
      ref="videoBoxRef"
      class="video-box"
      :class="{ 'video-box-background': !isRadio }"
      @dblclick="onBoxDblClick"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
    >
      <RadioStage
        v-if="isRadio"
        :carousels="carousels"
        :interval="carouselTime"
        autoplay
        @audio="nativeAudio = $event"
        @play="playing = true"
        @pause="playing = false"
        @volumechange="onVolumeChange"
      />
      <div v-else class="video-wrapper" :style="videoWrapperStyle">
        <video
          ref="nativeVideo"
          autoplay
          class="video-player"
          :class="{ 'media-hidden': mediaLoading }"
          :style="videoStyle"
          :poster="coverImage"
          @play="playing = true"
          @pause="playing = false"
          @volumechange="onVolumeChange"
        />
      </div>
      <!-- 直播弹幕（B 站公演源 + 口袋互动消息）：与 video-wrapper 同级，故不参与画面旋转；left/bottom 由脚本锚画面左下角。
           加载中一并隐藏：加载蒙层要盖住全部浮层，气泡不悬在加载态上 -->
      <div
        v-show="showDanmaku && !mediaLoading && !liveEnded"
        class="danmaku-list"
        :class="{ 'is-compact': compact }"
        :style="{ fontSize: `${danmakuFontSize}px`, ...danmakuPosition }"
      >
        <DanmakuBubbles :items="danmakuItems" :compact="compact" :plain="danmakuFloating" />
      </div>

      <!-- 下播结束态：复盘卡片盖住画面（官方 LiveCloseFragment 同构）——停流后仍停留，
           用户点关闭才关窗；复盘没拉到（未登录/接口失败）时退化为简版卡（标题+时长+关闭） -->
      <div v-if="liveEnded" class="live-end" :class="{ 'is-compact': compact }">
        <div class="live-end__title">
          直播已结束
        </div>
        <div class="live-end__name" :title="realName">
          {{ realName }}
        </div>
        <div class="live-end__stats">
          <span class="live-end__stat">时长 {{ endDurationText }}</span>
          <span v-if="endOnline > 0" class="live-end__stat">总观看 {{ formatViewNum(endOnline) }}</span>
          <span v-if="endGift > 0" class="live-end__stat">礼物 {{ formatViewNum(endGift) }}</span>
        </div>
        <div v-if="endTopUsers.length" class="live-end__tops">
          <div v-for="(item, index) in endTopUsers" :key="item.user.userId || index" class="live-end__top">
            <img
              v-if="item.user.userAvatar && !failedEndAvatars.has(item.user.userId || String(index))"
              class="live-end__avatar"
              :src="Tools.sourceUrl(item.user.userAvatar)"
              referrerpolicy="no-referrer"
              alt=""
              @error="failedEndAvatars.add(item.user.userId || String(index))"
            >
            <span v-else class="live-end__avatar live-end__avatar--fallback">{{ (item.user.userName || '神')[0] }}</span>
            <span class="live-end__top-name" :title="item.user.userName">{{ item.user.userName }}</span>
            <span class="live-end__top-money">{{ item.money.toLocaleString() }}</span>
          </div>
        </div>
        <button class="live-end__close" @click="emit('close')">
          关闭
        </button>
      </div>

      <PlayerLoading
        v-if="mediaLoading && !liveEnded"
        :masked="isRadio"
        :background="coverImage"
        label="正在加载直播"
        hint="连接直播源中，请稍候"
      />
      <!-- 悬浮按钮整组随加载隐藏：蒙层盖住全部浮层，且流就绪前录制无从谈起 -->
      <div v-show="!mediaLoading && !liveEnded" class="player-actions">
        <RotationControls
          v-if="liveType === 1"
          :angle="rotationAngle"
          @rotate-left="rotateLeft"
          @rotate-right="rotateRight"
          @reset="resetRotation"
        />
        <el-tooltip :content="recording ? '录制中，点击结束' : '录制'" placement="bottom" :show-after="400">
          <button
            class="action-btn action-btn--record"
            :class="{ 'is-active': recording }"
            :aria-label="recording ? '结束录制' : '录制'"
            @click="onRecordClick"
          >
            <MediaIcon name="videoCamera" :size="16" />
          </button>
        </el-tooltip>
      </div>

      <!-- 互动榜单：口袋 LIVEUPDATE 消息驱动，锚画面渲染区左上角 —— 悬于弹幕气泡层正上方并左对齐 -->
      <div
        v-if="rankUsers.length && !mediaLoading && !liveEnded"
        v-show="rankVisible"
        class="rank-panel"
        :style="rankPosition"
      >
        <div class="rank-panel__title">
          <MediaIcon name="trophy" :size="13" />
          <span>互动榜</span>
          <!-- 累计礼物流水（LIVEUPDATE.allMoney）：标题行右端，未收到时不占位 -->
          <span v-if="liveAllMoney > 0" class="rank-panel__gift" :title="`本场累计礼物 ${liveAllMoney.toLocaleString()}`">
            礼物 {{ formatViewNum(liveAllMoney) }}
          </span>
        </div>
        <div
          v-for="(user, index) in rankUsers.slice(0, 10)"
          :key="user.userId || index"
          class="rank-panel__row"
        >
          <span class="rank-panel__index" :class="{ 'is-top': index < 3 }">{{ index + 1 }}</span>
          <!-- 头像：加载失败或服务端未给时回退用户名首字母 -->
          <img
            v-if="user.avatar && !failedRankAvatars.has(user.userId || String(index))"
            class="rank-panel__avatar"
            :src="Tools.sourceUrl(user.avatar)"
            referrerpolicy="no-referrer"
            loading="lazy"
            alt=""
            @error="failedRankAvatars.add(user.userId || String(index))"
          >
          <span v-else class="rank-panel__avatar rank-panel__avatar--fallback">{{ (user.userName || '神')[0] }}</span>
          <span class="rank-panel__name" :title="user.userName || '神秘用户'">{{ user.userName || '神秘用户' }}</span>
          <!-- 等级 + 贡献值：右对齐贴尾，任一缺失时只展示另一项 -->
          <span v-if="user.level || user.money" class="rank-panel__meta">
            <span v-if="user.level" class="rank-panel__level">Lv.{{ user.level }}</span>
            <span v-if="user.money" class="rank-panel__money">{{ user.money.toLocaleString() }}</span>
          </span>
        </div>
      </div>

      <!-- 控制条：LIVE 状态段走 #leading 插槽；加载期间整条隐藏（连接中不显示 LIVE 状态） -->
      <MiniControls
        v-if="!mediaLoading && !liveEnded"
        :playing="playing"
        :muted="muted"
        :is-fullscreen="isFullscreen"
        @toggle-play="togglePlay"
        @toggle-mute="toggleMute"
        @toggle-fullscreen="toggleFullscreen"
      >
        <template #leading>
          <!-- 弹幕开关排在最左：与录播窗口的弹幕入口同位，跨两种播放器位置一致 -->
          <button
            v-if="hasDanmakuRoom"
            class="player-capsule__btn danmaku-toggle"
            :class="{ 'is-on': danmakuEnabled }"
            :title="danmakuEnabled ? '关闭弹幕' : '开启弹幕'"
            :aria-label="danmakuEnabled ? '关闭弹幕' : '开启弹幕'"
            @click="toggleDanmaku"
          >
            <MediaIcon name="chat" :size="16" />
          </button>

          <!-- 摆放切换：左侧黑边够宽时出现（窗口态竖屏直播同样适用）。
               不挡画面是刚需，故与弹幕开关并排常驻在胶囊最左段 -->
          <button
            v-if="canFloatDanmaku"
            class="player-capsule__btn danmaku-float-toggle"
            :class="{ 'is-on': danmakuFloating }"
            :title="danmakuFloating ? '弹幕移回画面内' : '弹幕移到左侧黑边'"
            :aria-label="danmakuFloating ? '弹幕移回画面内' : '弹幕移到左侧黑边'"
            @click="toggleDanmakuPlacement"
          >
            <MediaIcon name="panelLeft" :size="16" />
          </button>

          <!-- 榜单开关：有榜单数据才给入口（个人直播的 LIVEUPDATE 才会驱动） -->
          <button
            v-if="rankUsers.length"
            class="player-capsule__btn rank-toggle"
            :class="{ 'is-on': rankVisible }"
            :title="rankVisible ? '收起互动榜' : '展开互动榜'"
            :aria-label="rankVisible ? '收起互动榜' : '展开互动榜'"
            @click="rankVisible = !rankVisible"
          >
            <MediaIcon name="trophy" :size="16" />
          </button>

          <span class="live-status">
            <span class="live-dot" />
            <span class="live-label">LIVE</span>
            <span class="live-elapsed">{{ liveElapsedText }}</span>
            <span v-if="onlineNum > 0" class="live-online">在线 {{ onlineNum }}</span>
          </span>
        </template>
      </MiniControls>

      <div v-if="rotateHint && !liveEnded" class="rotate-hint">
        {{ rotateHint }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-player {
  width: 100%;
  height: 100%;
  display: flex;
}

.video-box {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  overflow: hidden;
  min-height: 200px;
}

/* 加载期间隐藏媒体元素本体，避免浏览器原生 buffering 转圈与自定义 overlay 叠加 */
.video-box .media-hidden {
  opacity: 0;
}

.video-box-background {
  background: #0c0c0c;
}

/* 下播结束卡：盖住整块画面（官方 LiveCloseFragment 同构）——停流后仍停留，点关闭才关窗。
   实色深底不用磨砂：悬在视频上的 backdrop-filter 每帧成本高（与榜单面板同一理由） */
.live-end {
  position: absolute;
  inset: 0;
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  background: #0c0c0c;
  color: #fff;
  text-align: center;
  user-select: none;
}

.live-end__title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 1px;
}

.live-end__name {
  max-width: 100%;
  font-size: 14px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 三围（时长 / 总观看 / 礼物）：芯片横排，空间不够整组换行 */
.live-end__stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.live-end__stat {
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.1);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 榜单前三：头像 + 昵称 + 贡献值，金色贡献值与互动榜同语言 */
.live-end__tops {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  max-width: 260px;
  margin-top: 2px;
}

.live-end__top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.live-end__avatar {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.live-end__avatar--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  font-weight: 600;
}

.live-end__top-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  opacity: 0.9;
}

.live-end__top-money {
  flex: none;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #f7ba2a;
}

/* 关闭：品牌渐变胶囊；纯动作按钮，无状态语义 */
.live-end__close {
  margin-top: 4px;
  padding: 6px 20px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 13px;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
  cursor: pointer;
}

.live-end__close:hover {
  filter: brightness(1.12);
}

/* compact 小浮窗：收紧间距与字号，榜单同步缩小保留（窄窗高度够，只省横向） */
.live-end.is-compact {
  gap: 6px;
  padding: 10px;
}

.live-end.is-compact .live-end__title {
  font-size: 16px;
}

.live-end.is-compact .live-end__name {
  font-size: 13px;
}

.live-end.is-compact .live-end__stat {
  padding: 3px 10px;
  font-size: 12px;
}

.live-end.is-compact .live-end__tops {
  gap: 3px;
  max-width: 100%;
}

.live-end.is-compact .live-end__top {
  gap: 6px;
  font-size: 12px;
}

.live-end.is-compact .live-end__avatar {
  width: 20px;
  height: 20px;
}

/* LIVE 状态段：内嵌在 MiniControls 胶囊最左段的芯片（样式作用于插槽内容）。
   整条胶囊里唯一可收缩的就是它：放不下时先由在线人数自己让位（见 .live-online），
   圆点、LIVE 标识与已播时长始终完整，右侧按钮也不会被挤出胶囊条 */
.live-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 0;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  user-select: none;
}

/* 在线人数是胶囊里优先级最低的一段：位置不够时只有它收缩并省略（空间真让出去，
   不是「留着空档只是不画字」），宽度够就完整显示 */
.live-online {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: 1px;
  font-size: 11px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 弹幕开关：开启时图标转品牌色（按钮尺寸 / hover 白纱见全局 .player-capsule__btn） */
.danmaku-toggle.is-on {
  color: var(--brand-secondary);
}

.danmaku-float-toggle.is-on {
  color: var(--brand-secondary);
}

/* 榜单开关与面板：开关同弹幕语言；面板挂操作按钮（.player-actions 高约 36px）下方 */
.rank-toggle.is-on {
  color: #f7ba2a;
}

.rank-panel {
  position: absolute;
  /* left / top 由脚本锚画面渲染区左上角（useDanmakuLayer.topLeft，与气泡层同一内缩量） */
  z-index: 29;
  min-width: 132px;
  max-width: 248px;
  max-height: 45%;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 10px;
  /* 实色深底（非磨砂）：悬在视频上的 backdrop-filter 每帧成本高，加深底色压画面 */
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 12px;
  user-select: none;
}

.rank-panel__title {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-bottom: 6px;
  margin-bottom: 4px;
  font-weight: 600;
  color: #f7ba2a;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

/* 累计礼物流水（LIVEUPDATE.allMoney）：推到标题行右端，金色与贡献值列同语言 */
.rank-panel__gift {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #f7ba2a;
}

.rank-panel__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  line-height: 1.4;
}

.rank-panel__index {
  flex: none;
  min-width: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.rank-panel__index.is-top {
  font-weight: 700;
  color: #f7ba2a;
  opacity: 1;
}

/* 头像：20px 圆形；无图 / 加载失败时回退用户名首字母占位 */
.rank-panel__avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.rank-panel__avatar--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  font-weight: 600;
}

.rank-panel__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 尾部元信息（等级 + 贡献值）：flex:none 贴右，不随昵称伸缩 */
.rank-panel__meta {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

/* 等级徽标：小胶囊；min-width 定宽让各行徽标纵向对齐 */
.rank-panel__level {
  flex: none;
  min-width: 32px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
}

/* 贡献值：金色数字列，定宽右对齐 + tabular-nums */
.rank-panel__money {
  flex: none;
  min-width: 34px;
  font-size: 11px;
  font-weight: 600;
  line-height: 15px;
  color: #f7ba2a;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 悬浮按钮（录制）与右上角容器样式为全局 .player-actions / .action-btn，见 app.scss */

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f56c6c;
  animation: live-pulse 1.2s ease-in-out infinite;
}

.live-label {
  font-weight: 600;
  letter-spacing: 0.5px;
}

.live-elapsed {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.5);
  }
  50% {
    opacity: 0.6;
    box-shadow: 0 0 0 4px rgba(245, 108, 108, 0);
  }
}
</style>
