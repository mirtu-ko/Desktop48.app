<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { useDanmakuLayer } from '@renderer/composables/use-danmaku-layer'
import { DANMAKU_DELAY_DEFAULT, DANMAKU_DELAY_LIMIT, useLiveDanmaku } from '@renderer/composables/use-live-danmaku'
import { useLivePlayer } from '@renderer/composables/use-live-player'
import { useLivePolling } from '@renderer/composables/use-live-polling'
import { useLiveSession } from '@renderer/composables/use-live-session'
import useMediaDownload from '@renderer/composables/use-media-download'
import { dispatchMediaShortcut } from '@renderer/composables/use-media-shortcuts'
import { useSleepBlocker } from '@renderer/composables/use-sleep-blocker'
import { useStreamRetry } from '@renderer/composables/use-stream-retry'
import { useVideoRotation } from '@renderer/composables/use-video-rotation'
import EventBus from '@renderer/services/event-bus'
import { debugLog } from '@renderer/utils/debug'
import { isUnavailableLiveMessage } from '@renderer/utils/live-stream'

import { useEventListener } from '@vueuse/core'

import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import DanmakuBubbles from './DanmakuBubbles.vue'
import MiniControls from './MiniControls.vue'
import PlayerLoading from './PlayerLoading.vue'
import RadioStage from './RadioStage.vue'
import RotationControls from './RotationControls.vue'

const props = defineProps({
  liveTitle: { type: String, required: true },
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
// 鼠标悬浮才响应快捷键：同屏可能有多个浮窗播放器，否则一次按键会把它们全部转一遍。
// 触发策略与 PlaybackPlayer 不同（它走根节点焦点制），但按键分派共用 use-media-shortcuts。
const hovered = ref(false)
// 卸载标记：置位后所有在途异步回包直接丢弃
const isManuallyUnmounted = ref(false)

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
  isVerticalRotation,
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

// ── B 站弹幕（公演专用）──────────────────────────────────────────
// 房间号由 payload 携带（Shows.vue 按团体映射），个人直播没有对应房间故为空
const danmakuRoomId = computed(() => (props.bilibiliRoomId > 0 ? props.bilibiliRoomId : undefined))
const danmakuEnabled = ref(true)
const danmakuDelay = ref(DANMAKU_DELAY_DEFAULT)
/** 个人直播没有对应的 B 站房间：连开关都不给 */
const hasDanmakuRoom = computed(() => danmakuRoomId.value !== undefined)
const showDanmaku = computed(() => hasDanmakuRoom.value && danmakuEnabled.value)

const { danmakuItems } = useLiveDanmaku({
  roomId: () => danmakuRoomId.value,
  enabled: () => danmakuEnabled.value,
  delaySeconds: () => danmakuDelay.value,
})

const { fontSize: danmakuFontSize, position: danmakuPosition } = useDanmakuLayer({
  videoRect: () => videoRect.value,
  compact: () => props.compact,
})

/** 补偿只在「弹幕早于画面」这个方向上可修：弹幕到得比画面晚时无从提前，0 即最优 */
function adjustDanmakuDelay(delta: number) {
  danmakuDelay.value = Math.min(DANMAKU_DELAY_LIMIT, Math.max(0, danmakuDelay.value + delta))
}

// ── 直播轮询：已播时长 + 在线人数 ────────────────────────────────
const polling = useLivePolling({
  startTime: () => props.startTime,
  liveId: () => props.liveId,
  skipOnlineNum: () => props.source === 'open',
  onUnavailable: closeUnavailableLive,
})
const { liveElapsedText, onlineNum } = polling

// ── 直播会话：详情获取 + 本地 HTTP-FLV 生命周期 ──────────────────
const session = useLiveSession({
  liveId: () => props.liveId,
  source: () => props.source,
  avatarUrl: () => props.avatarUrl,
  isRadio: () => isRadio.value,
  isDisposed: isManuallyUnmounted,
  onAvatar: avatarUrl => emit('avatar', avatarUrl),
  onOnlineNum: (num) => {
    polling.onlineNum.value = num
  },
  // 详情都取不到通常意味着直播已下架：广播通知列表页刷新
  onUnavailable: closeUnavailableLive,
  // 回调依赖 retry/player，创建顺序成环，统一走提升的函数声明（见文件末尾）
  onBeforeRebuild: rebuildMedia,
  onSessionStart: beginSession,
})

// 详情展示状态直接解构给模板（解构出的仍是 ref，不丢响应性）。
// localPlaybackUrl = 本地 HTTP-FLV 地址，下方 watch 盯着它重建播放器
const { localPlaybackUrl, coverImage, realName, carousels, carouselTime } = session

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
  isDisposed: () => isManuallyUnmounted.value,
  mediaLoading,
  attempt: recoverStream,
  onExhausted: handleRetryExhausted,
})

/** 单次恢复尝试：拉详情 → 重建流（节奏由重试状态机安排） */
async function recoverStream() {
  debugLog('live', `①直播:重试恢复尝试（第 ${retry.retryCount.value + 1} 次）`)
  try {
    const data = await session.fetchLiveDetail()
    if (isManuallyUnmounted.value)
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

/** 重试耗尽视为直播结束：停流、广播下架、关闭 tab */
function handleRetryExhausted() {
  debugLog('live', `①直播:重试耗尽（${retry.retryCount.value} 次），视为直播结束：停流 → 广播下架 → 关闭浮窗`)
  session.stopStreamNow()
  EventBus.emit('live-unavailable', props.liveId)
  emit('close')
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
  polling.startElapsedTimer()
  polling.startOnlineNumTimer()
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

  window.addEventListener('keydown', onKeyDown)

  // 迷你窗存在即启动播放会话
  resumeLive()
})

onUnmounted(() => {
  // 先 dispose：所有在途异步回包（详情响应、开会话响应）立即失效
  session.dispose()
  retry.clearTimer()
  polling.stopAll()
  if (playerWatchStopHandle) {
    playerWatchStopHandle()
    playerWatchStopHandle = null
  }
  player.destroyPlayer()
  player.resetMediaElement()
  releaseSleepBlocker()
})
</script>

<template>
  <div class="live-player">
    <div
      ref="videoBoxRef"
      class="video-box"
      :class="{ 'vertical-rotation': !isRadio && isVerticalRotation, 'video-box-background': !isRadio }"
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
      <!-- B 站弹幕：与 video-wrapper 同级，故不参与画面旋转；left/bottom 由脚本锚画面左下角 -->
      <div
        v-show="showDanmaku"
        class="danmaku-list"
        :class="{ 'is-compact': compact }"
        :style="{ fontSize: `${danmakuFontSize}px`, ...danmakuPosition }"
      >
        <DanmakuBubbles :items="danmakuItems" :compact="compact" />
      </div>

      <PlayerLoading
        v-if="mediaLoading"
        :masked="isRadio"
        :background="coverImage"
        label="正在加载直播"
        hint="连接直播源中，请稍候"
      />
      <div class="player-actions">
        <RotationControls
          v-if="liveType === 1 && !mediaLoading"
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

      <!-- 控制条：LIVE 状态段走 #leading 插槽；加载期间整条隐藏（连接中不显示 LIVE 状态） -->
      <MiniControls
        v-if="!mediaLoading"
        :playing="playing"
        :muted="muted"
        :is-fullscreen="isFullscreen"
        @toggle-play="togglePlay"
        @toggle-mute="toggleMute"
        @toggle-fullscreen="toggleFullscreen"
      >
        <template #leading>
          <span class="live-status">
            <span class="live-dot" />
            <span class="live-label">LIVE</span>
            <span class="live-elapsed">{{ liveElapsedText }}</span>
            <span v-if="!compact && onlineNum > 0" class="live-online">在线 {{ onlineNum }}</span>
          </span>
          <button
            v-if="hasDanmakuRoom"
            class="player-capsule__btn danmaku-toggle"
            :class="{ 'is-on': danmakuEnabled }"
            :title="danmakuEnabled ? '关闭 B 站弹幕' : '开启 B 站弹幕'"
            :aria-label="danmakuEnabled ? '关闭 B 站弹幕' : '开启 B 站弹幕'"
            @click="danmakuEnabled = !danmakuEnabled"
          >
            <MediaIcon name="chat" :size="16" />
          </button>
          <!-- 延迟补偿：弹幕实时推送，画面要过 FFmpeg 转封装 + MSE 缓冲，默认落后数秒 -->
          <span
            v-if="showDanmaku"
            class="danmaku-delay"
            :class="{ 'is-compact': compact }"
            title="弹幕延迟补偿：画面比弹幕慢几秒就调几秒"
          >
            <button
              class="player-capsule__btn danmaku-delay__btn"
              :class="{ 'is-bound': danmakuDelay <= 0 }"
              aria-label="减少弹幕延迟补偿"
              @click="adjustDanmakuDelay(-1)"
            >
              <MediaIcon name="minus" :size="14" />
            </button>
            <span class="danmaku-delay__value">{{ danmakuDelay }}s</span>
            <button
              class="player-capsule__btn danmaku-delay__btn"
              :class="{ 'is-bound': danmakuDelay >= DANMAKU_DELAY_LIMIT }"
              aria-label="增加弹幕延迟补偿"
              @click="adjustDanmakuDelay(1)"
            >
              <MediaIcon name="plus" :size="14" />
            </button>
          </span>
        </template>
      </MiniControls>

      <div v-if="rotateHint" class="rotate-hint">
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

.video-box.vertical-rotation {
  overflow: hidden;
}

/* LIVE 状态段：内嵌在 MiniControls 胶囊最左段的芯片（样式作用于插槽内容）。
   可收缩：空间不足时从右往左裁掉在线人数/时长尾巴，保住圆点与 LIVE 标识，
   绝不把右侧按钮挤出胶囊条 */
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

.live-online {
  margin-left: 1px;
  font-size: 11px;
  opacity: 0.85;
}

/* 弹幕开关：开启时图标转品牌色（按钮尺寸 / hover 白纱见全局 .player-capsule__btn） */
.danmaku-toggle.is-on {
  color: var(--brand-secondary);
}

/* 延迟补偿步进器：弹幕开着才出现 */
.danmaku-delay {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 1px;
}

/* 等宽数字 + 定宽：数值从 9s 跳到 10s 时两侧按钮不位移 */
.danmaku-delay__value {
  min-width: 2.4em;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.9);
  user-select: none;
}

/* 触到上下限的按钮压暗：值已调不动，用颜色说明而不禁用 */
.danmaku-delay__btn.is-bound {
  color: rgba(255, 255, 255, 0.3);
}

/* 窄窗（240px）下控制条宽度是硬预算，步进器整组收紧，把宽度让给 LIVE 状态段 */
.danmaku-delay.is-compact {
  gap: 0;
}

.danmaku-delay.is-compact .danmaku-delay__btn {
  width: 22px;
  height: 22px;
}

.danmaku-delay.is-compact .danmaku-delay__value {
  min-width: 1.7em;
  font-size: 10px;
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
