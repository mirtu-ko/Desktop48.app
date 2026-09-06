<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLivePlayer } from '../../composables/live/use-live-player'
import { useLivePolling } from '../../composables/live/use-live-polling'
import { useLiveSession } from '../../composables/live/use-live-session'
import { useStreamRetry } from '../../composables/live/use-stream-retry'
import { dispatchMediaShortcut } from '../../composables/media/use-media-shortcuts'
import { useSleepBlocker } from '../../composables/media/use-sleep-blocker'
import { useVideoRotation } from '../../composables/media/use-video-rotation'
import useMediaDownload from '../../composables/tasks/use-media-download'
import EventBus from '../../services/event-bus'

import { debugLog } from '../../utils/debug'

import MediaIcon from '../ui/MediaIcon.vue'
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
  /** 迷你窗紧凑模式：隐藏次要信息，适配小尺寸画中画窗口 */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'avatar', 'aspect'])

const nativeVideo = ref<HTMLVideoElement | null>(null)
// 电台模式的 audio 元素由 RadioStage 挂载/卸载时经 @audio 事件回传
const nativeAudio = ref<HTMLAudioElement | null>(null)
const videoBoxRef = ref<HTMLElement | null>(null)
const mediaLoading = ref(true)
// 鼠标悬浮才响应快捷键：同屏可能有多个浮窗播放器，否则一次按键会把它们全部转一遍。
// 触发策略与 ReviewPlayer 不同（它走根节点焦点制），但按键分派共用 use-media-shortcuts。
const hovered = ref(false)
// 卸载标记：置位后所有在途异步回包直接丢弃
const isManuallyUnmounted = ref(false)

const isRadio = computed(() => props.liveType !== 1)

// 播放防休眠（use-sleep-blocker，与 ReviewPlayer 共用）
const { acquire: acquireSleepBlocker, release: releaseSleepBlocker } = useSleepBlocker()

// 旋转 / 容器全屏 / 迷你控制条状态：与 ReviewPlayer 共用同一套实现（useVideoRotation）
const {
  rotationAngle,
  isVerticalRotation,
  videoWrapperStyle,
  videoStyle,
  rotateHint,
  rotateLeft,
  rotateRight,
  resetRotation,
  onBoxDblClick,
  isFullscreen,
  toggleFullscreen,
  isPip,
  togglePip,
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

// ── 直播轮询：已播时长 + 在线人数 ────────────────────────────────
const polling = useLivePolling({
  startTime: () => props.startTime,
  liveId: () => props.liveId,
  skipOnlineNum: () => props.source === 'open',
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
  // 详情都取不到通常意味着直播已下架：广播通知列表页刷新，并关闭当前 tab
  onUnavailable: () => {
    EventBus.emit('live-unavailable', props.liveId)
    emit('close')
  },
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
  debugLog('live', `编排:重试恢复尝试（第 ${retry.retryCount.value + 1} 次）`)
  const data = await session.fetchLiveDetail()
  if (isManuallyUnmounted.value)
    return
  session.applyLiveDetail(data)
  await session.restartLiveStream(data.playStreamPath)
}

/** 会话启动（getOne 开始）：复位 loading 与重试计数 */
function beginSession() {
  debugLog('live', `编排:会话开始（liveId=${props.liveId}, source=${props.source}），复位 loading 与重试计数`)
  mediaLoading.value = true
  retry.reset()
}

/** canplay：加载完成，复位恢复态并刷新视频尺寸 */
function onPlayerCanPlay() {
  debugLog('live', '编排:播放就绪（canplay），复位恢复态')
  retry.isRecoveringStream.value = false
  if (!isRadio.value)
    updateVideoDimensions()
}

/** 重建流之前：清重试计时器、销毁播放器、复位媒体元素 */
function rebuildMedia() {
  debugLog('live', '编排:重建流前清理（重试计时器/播放器实例/媒体元素）')
  retry.clearTimer()
  player.destroyPlayer()
  player.resetMediaElement()
}

/** 媒体元素/FLV 错误统一处理：网络错误保持 loading 重试，致命错误先销毁播放器 */
function handleStreamError(reason: string, isNetwork: boolean) {
  console.error('[LivePlayer.vue] 直播播放异常:', reason)
  if (isNetwork) {
    debugLog('live', `编排:网络错误（${reason}），保持 loading 并安排重试`)
    mediaLoading.value = true
  }
  else {
    debugLog('live', `编排:致命错误（${reason}），先销毁播放器再安排重试`)
    player.destroyPlayer()
    mediaLoading.value = false
  }
  retry.schedule()
}

/** 重试耗尽视为直播结束：停流、广播下架、关闭 tab */
function handleRetryExhausted() {
  debugLog('live', `编排:重试耗尽（${retry.retryCount.value} 次），视为直播结束：停流 → 广播下架 → 关闭浮窗`)
  session.stopStreamNow()
  EventBus.emit('live-unavailable', props.liveId)
  emit('close')
}

// ── 录制 ─────────────────────────────────────────────────────────
// 录制发起流程收口在 useMediaDownload（目录校验/文件名/任务下发与回放下载共用）；
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
      // 失败原因已由 Apis.request 统一弹窗提示（直播已下架/网络错误）
      console.error('[LivePlayer.vue] 获取录制源地址失败:', error)
      return null
    }
  },
})

// ── 键盘快捷键（悬浮制：仅视频模式、鼠标悬浮时响应） ─────────────────────────
// 按键分派与 ReviewPlayer 共用 dispatchMediaShortcut（键位单源）；
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
    await session.getOne()
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
  window.removeEventListener('keydown', onKeyDown)
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
        :show-pip="!isRadio"
        :is-pip="isPip"
        @toggle-play="togglePlay"
        @toggle-mute="toggleMute"
        @toggle-fullscreen="toggleFullscreen"
        @toggle-pip="togglePip"
      >
        <template #leading>
          <span class="live-status">
            <span class="live-dot" />
            <span class="live-label">LIVE</span>
            <span class="live-elapsed">{{ liveElapsedText }}</span>
            <span v-if="!compact && onlineNum > 0" class="live-online">在线 {{ onlineNum }}</span>
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
  border-radius: 999px;
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
