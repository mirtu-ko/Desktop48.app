<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { useDanmakuLayer } from '@renderer/composables/use-danmaku-layer'
import useMediaDownload from '@renderer/composables/use-media-download'
import { useMediaShortcuts } from '@renderer/composables/use-media-shortcuts'
import { usePlaybackDanmaku } from '@renderer/composables/use-playback-danmaku'
import { usePlaybackEngine } from '@renderer/composables/use-playback-engine'
import { usePlayerControlsVisibility } from '@renderer/composables/use-player-controls-visibility'
import { useSleepBlocker } from '@renderer/composables/use-sleep-blocker'
import { useVideoRotation } from '@renderer/composables/use-video-rotation'
import { loadLiveDetail } from '@renderer/services/live-detail'
import { danmakuPlacement, ensureDanmakuPlacement, setDanmakuPlacement } from '@renderer/stores/danmaku-placement'
import { debugLog } from '@renderer/utils/debug'
import { resolveCarouselImages } from '@renderer/utils/live-stream'
import { flushPlayDuration, markPlayDurationStarted } from '@renderer/utils/play-duration'
import { formatMediaTime } from '@renderer/utils/time-format'
import Tools from '@renderer/utils/tools'
import { trackEvent } from '@renderer/utils/umami'
import { useEventListener } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import DanmakuBubbles from './DanmakuBubbles.vue'
import MiniControls from './MiniControls.vue'
import PlayerLoading from './PlayerLoading.vue'
import RadioStage from './RadioStage.vue'
import RotationControls from './RotationControls.vue'

const props = defineProps({
  liveId: { type: String, required: true },
  startTime: { type: Number, required: true },
  /** 数据源：user=用户直播回放(getLiveOne)，open=开放公演回放(getOpenLiveOne) */
  source: { type: String, default: 'user' },
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatarUrl: { type: String, default: '' },
  /** 紧凑模式：缩小弹幕字号与玻璃条尺寸，适配小尺寸独立播放窗 */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['avatar', 'aspect', 'playing'])

const playStreamPath = ref('')
const isRadio = ref(false)
const nativeVideo = ref<HTMLVideoElement | null>(null)
// 电台模式的 audio 元素由 RadioStage 挂载/卸载时经 @audio 事件回传
const nativeAudio = ref<HTMLAudioElement | null>(null)
const carousels = ref<string[]>([])
const carouselTime = ref(5000)
const realName = ref('')
const userAvatar = ref('')
// 观看人数：取自回放详情 onlineNum，供「全部弹幕」面板头部展示（公演回放无此数据）
const onlineNumber = ref(0)

let playbackTracked = false
let disposed = false
const detailLoading = ref(false)
const detailError = ref('')

// 弹幕展示模式：实时堆叠 | 全部面板
type DanmakuMode = 'live' | 'all'
const danmakuMode = ref<DanmakuMode>('live')

// 「全部」面板的搜索词：命中全量弹幕（含尚未播放的部分）
const keyword = ref('')
const trimmedKeyword = computed(() => keyword.value.trim().toLowerCase())

const videoBoxRef = ref<HTMLElement | null>(null)

// 录播页只做两类事情：
// 1. 按播放地址选择 HLS 或原生 MP4 播放（use-playback-engine）
// 2. 按录播资源加载弹幕，并在回退/重播时重置弹幕状态
function getActiveMediaElement() {
  return isRadio.value ? nativeAudio.value : nativeVideo.value
}

// =========== 画面旋转 / 容器全屏 / 迷你控制条（与 LivePlayer 共用 useVideoRotation） ===========
// 旋转只作用于 video wrapper，弹幕叠加层与之同级不参与旋转；
// 但其锚点取自 videoRect（已含 90/270° 的显示宽高交换），全屏下也贴住画面左下角。
const {
  rotationAngle,
  videoRect,
  videoWrapperStyle,
  videoStyle,
  rotateHint,
  shortcutHint,
  showShortcutHint,
  rotateLeft,
  rotateRight,
  resetRotation,
  onBoxDblClick,
  isFullscreen,
  toggleFullscreen,
  playing,
  muted,
  volume,
  togglePlay,
  toggleMute,
  applySavedVolume,
  onVolumeSliderInput,
  adjustVolume,
  VOLUME_STEP,
  onVolumeChange,
  updateVideoDimensions,
} = useVideoRotation({
  videoBoxRef,
  getMedia: () => (isRadio.value ? nativeAudio.value : nativeVideo.value),
  getVideo: () => nativeVideo.value,
  isRadio,
  onAspect: aspect => emit('aspect', aspect),
})
// =========== 画面旋转结束 ===========

// 播放/暂停上报父级：独立播放窗据此决定是否置顶（播放中才置顶）。
// 只上报「变化」而不带上初值：窗口刚打开时还在加载，此刻保持创建时的置顶态，
// 免得视频还没出画面就先掉到别的窗口后面。
watch(playing, value => emit('playing', value))

// 弹幕以「左下角玻璃条」呈现
const danmaku = usePlaybackDanmaku({
  getMedia: getActiveMediaElement,
})
const {
  currentTime,
  barrageUrl,
  hasBarrage,
  barrageLoaded,
  barrageEntries,
  danmakuOverlayItems,
  seekBarragesTo,
  onTimeUpdate: onDanmakuTimeUpdate,
  ensureBarragesLoaded,
  resetBarrageSource,
} = danmaku

// 「全部」面板条目：无关键词直接引用全量数组，否则按内容 / 用户名过滤（忽略大小写）
const displayEntries = computed(() => {
  const kw = trimmedKeyword.value
  if (!kw)
    return barrageEntries.value
  return barrageEntries.value.filter(item =>
    item.content.toLowerCase().includes(kw)
    || item.username.toLowerCase().includes(kw),
  )
})

// 开播时间，与观看人数同处面板头部 meta 行
const startDate = computed(() => dayjs(props.startTime).format('YYYY-MM-DD HH:mm'))

// 切换弹幕展示模式：实时 ⇄ 全部
function toggleDanmakuMode() {
  if (!hasBarrage.value)
    return
  const next = danmakuMode.value === 'live' ? 'all' : 'live'
  // 只在切到「全部」时计数
  if (next === 'all')
    trackEvent('danmaku:mode')
  danmakuMode.value = next
}

// ── 录播倍速（记忆上次选择） ────────────────────────────────────
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2]
const PLAYBACK_RATE_STORAGE_KEY = 'desktop48:playback:rate'
function loadSavedPlaybackRate(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(PLAYBACK_RATE_STORAGE_KEY))
    if (PLAYBACK_RATES.includes(raw))
      return raw
  }
  catch {
    // 忽略存储读取失败
  }
  return 1
}
const playbackRate = ref(loadSavedPlaybackRate())
function applyPlaybackRate(target?: HTMLMediaElement | null) {
  const el = target ?? getActiveMediaElement()
  if (el)
    el.playbackRate = playbackRate.value
}
function onRateChange(rate: number) {
  if (!PLAYBACK_RATES.includes(rate))
    return
  playbackRate.value = rate
  applyPlaybackRate()
  showShortcutHint(`倍速 ${rate}x`)
  try {
    globalThis.localStorage?.setItem(PLAYBACK_RATE_STORAGE_KEY, String(rate))
  }
  catch {
    // 忽略存储写入失败
  }
}

// 摆放偏好是全局单例，读一次即可（两个播放器并发调用共用同一次 IPC）
void ensureDanmakuPlacement()

// 播放防休眠（use-sleep-blocker，与 LivePlayer 共用）
const { acquire: acquireSleepBlocker, release: releaseSleepBlocker } = useSleepBlocker()

// =========== 播放引擎接线（HLS/原生选择、三态与播放源 watch 在 use-playback-engine） ===========
const {
  loading: mediaLoading,
  buffering: mediaBuffering,
  error: lastPlaybackError,
  mediaDuration,
  retryPlayback,
  destroy: destroyPlayer,
} = usePlaybackEngine({
  sourcePath: playStreamPath,
  getMediaElement: getActiveMediaElement,
  getManagedElements: () => [nativeVideo.value, nativeAudio.value],
  onTimeUpdate: onDanmakuTimeUpdate,
  onSeeking: time => seekBarragesTo(time),
  onMetadataLoaded: async (media) => {
    // 换清晰度 / 重试重挂也会触发 loadedmetadata，用标记只计首播
    if (!playbackTracked) {
      playbackTracked = true
      markPlayDurationStarted()
      trackEvent('playback:play', {
        title: realName.value,
        media: isRadio.value ? 'radio' : 'video',
        source: props.source === 'open' ? 'open' : 'user',
      })
    }
    applySavedVolume(media)
    applyPlaybackRate(media)
    debugLog('playback', `④元数据就绪: 刷新画面尺寸${isRadio.value ? '（电台无尺寸）' : ''} → 加载弹幕`)
    // 记录源尺寸供旋转缩放计算，并按（可能旋转后的）画面比例上报浮窗
    if (!isRadio.value)
      updateVideoDimensions()
    await ensureBarragesLoaded()
  },
  onPlaying: () => void acquireSleepBlocker(),
  onIdle: releaseSleepBlocker,
})

// 合并详情拉取态与播放引擎加载态，避免组件直接改写 usePlaybackEngine 内部 ref
const isLoading = computed(() => detailLoading.value || mediaLoading.value)
// 合并详情拉取失败与播放引擎错误：任一出错都结束加载态并展示重试遮罩
const playbackError = computed(() => detailError.value || lastPlaybackError.value)

function handleRetry() {
  if (!playStreamPath.value) {
    void getLiveOne()
    return
  }
  retryPlayback()
}

// 录播播放错误（引擎内 notifyError 已按文案去重）
watch(lastPlaybackError, (message) => {
  if (message)
    trackEvent('player:error', { type: 'playback', starName: realName.value, liveId: props.liveId })
})

// ── 无操作自动隐藏控件 ──────────────────────────────────────────
const {
  controlsVisible,
  cursorHidden,
  reveal: revealControls,
  onControlEnter,
  onControlLeave,
  onContainerLeave,
} = usePlayerControlsVisibility({
  isFullscreen,
  keepVisible: () => !playing.value || danmakuMode.value === 'all' || isLoading.value,
})

function onActionsFocusOut(event: FocusEvent) {
  const container = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (!container || !next || !container.contains(next))
    onControlLeave()
}

const {
  fontSize: danmakuFontSize,
  position: danmakuPosition,
  canFloatLeft: canFloatDanmaku,
  floating: danmakuFloating,
} = useDanmakuLayer({
  videoRect: () => videoRect.value,
  compact: () => props.compact,
  fullscreen: () => isFullscreen.value,
  // 「全部弹幕」面板是气泡层的子元素（宽度随它），面板展开时强制回画面内，
  // 否则窄黑边里塞不下列表。气泡此时本就隐藏，看不见这次位置切换
  placement: () => (danmakuMode.value === 'live' ? danmakuPlacement.value : 'video'),
  controlsVisible: () => controlsVisible.value,
})

/** 摆放只在「左侧黑边够宽」时开放：按钮只在此时出现，状态由 is-on 表示（不用 disabled） */
function toggleDanmakuPlacement() {
  const next = danmakuFloating.value ? 'video' : 'left'
  void setDanmakuPlacement(next)
  trackEvent('danmaku:placement', { placement: next })
}

function onVideoPointerDown(event: PointerEvent) {
  revealControls()
  if (danmakuMode.value !== 'all')
    return
  const target = event.target as HTMLElement | null
  if (target?.closest('.danmaku-all, .mini-controls, .player-actions'))
    return
  danmakuMode.value = 'live'
}

watch(shortcutHint, (hint) => {
  if (hint)
    revealControls()
})

watch(nativeAudio, (el) => {
  if (!el)
    return
  applySavedVolume(el)
  applyPlaybackRate(el)
})

function seekBy(deltaSeconds: number) {
  const mediaElement = getActiveMediaElement()
  if (!mediaElement)
    return
  const max = mediaDuration.value > 0 ? mediaDuration.value : Number.POSITIVE_INFINITY
  const next = Math.min(max, Math.max(0, mediaElement.currentTime + deltaSeconds))
  mediaElement.currentTime = next
  currentTime.value = next
  showShortcutHint(deltaSeconds > 0 ? `快进 ${deltaSeconds}s` : `快退 ${Math.abs(deltaSeconds)}s`)
}

// =========== 键盘快捷键（窗口级监听，见 use-media-shortcuts） ===========
useMediaShortcuts({
  getMedia: getActiveMediaElement,
  actions: {
    togglePlay,
    toggleMute,
    toggleFullscreen,
    seekBackward: () => seekBy(-5),
    seekForward: () => seekBy(5),
    rotateLeft: () => {
      if (!isRadio.value)
        rotateLeft()
    },
    rotateRight: () => {
      if (!isRadio.value)
        rotateRight()
    },
    resetRotation: () => {
      if (!isRadio.value)
        resetRotation()
    },
    // ↑/↓ 调音量：与迷你条音量滑块走同一条通道（静音态下自动解除静音）
    volumeUp: () => adjustVolume(VOLUME_STEP),
    volumeDown: () => adjustVolume(-VOLUME_STEP),
  },
})

// 按 Esc 收起「全部弹幕」面板（含搜索框聚焦时，跳过输入法组词态）
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.isComposing)
    return
  if (event.key === 'Escape' && danmakuMode.value === 'all')
    danmakuMode.value = 'live'
})

// 迷你条拖进度 / 「全部」面板点击跳转共用此 seek 通道：
// 立即回写 currentTime 让进度条跟手，弹幕游标仍由引擎的 seeking 事件统一重置
function onMiniSeek(value: number) {
  const mediaElement = getActiveMediaElement()
  if (!mediaElement)
    return
  mediaElement.currentTime = value
  currentTime.value = value
}

/**
 * 获取回放详情。
 * 拉取与归一交给 services/live-detail.ts（与直播链路共用），这里只处理回放特有的分支：
 * 开放公演选流为空、录播尚未生成、弹幕源变化需重载。
 */
async function getLiveOne() {
  detailError.value = ''
  detailLoading.value = true
  try {
    debugLog('playback', `②拉详情: source=${props.source} → ${props.source === 'open' ? 'getOpenLiveOne' : 'getLiveOne'}, props:`, props)
    const view = await loadLiveDetail({
      liveId: props.liveId,
      source: props.source === 'open' ? 'open' : 'user',
      stream: 'vod',
      avatarUrl: props.avatarUrl,
      startTime: props.startTime,
    })
    if (disposed)
      return
    debugLog('playback', `②拉详情: 归一结果 streamType=${view.streamType ?? '单档'} cover=${view.coverUrl ? '有' : '无'}`, view)

    // 开放公演回放选流为空：没有可播地址，结束加载并展示重试遮罩
    if (props.source === 'open' && !view.playStreamPath) {
      debugLog('playback', '②拉详情: 公演回放选流为空，无法播放')
      detailError.value = '未获取到公演回放地址'
      return
    }

    // 录播尚未生成：不进播放引擎
    if (!view.review) {
      debugLog('playback', `②拉详情: liveId=${props.liveId} 暂无回放（review=false）`)
      detailError.value = '录播回放尚未生成，请稍后重试'
      return
    }

    if (!view.playStreamPath) {
      debugLog('playback', `②拉详情: liveId=${props.liveId} 未返回播放地址`)
      detailError.value = '未获取到录播播放地址'
      return
    }

    isRadio.value = view.liveType === 2
    // 公演回放详情不含在线人数，面板头部显示 0
    onlineNumber.value = view.onlineNum ?? 0
    realName.value = view.realName
    userAvatar.value = view.userAvatar
    emit('avatar', userAvatar.value)
    // 电台无轮播图时回退封面单张展示（与直播链路同一契约）
    carousels.value = resolveCarouselImages(
      isRadio.value,
      view.carouselImages,
      view.coverUrl,
      url => Tools.sourceUrl(url),
    )
    carouselTime.value = view.carouselTime

    const barrageSourceChanged = barrageUrl.value !== view.barrageUrl
    barrageUrl.value = view.barrageUrl
    playStreamPath.value = view.playStreamPath

    if (barrageSourceChanged) {
      debugLog('playback', '②拉详情: 播放地址与弹幕源已更新（弹幕源变化 → 重新加载）')
      resetBarrageSource()
    }
  }
  catch (error: any) {
    if (disposed)
      return
    console.error('PlaybackPlayer.vue, 获取录播信息失败:', error.message)
    detailError.value = '获取录播信息失败，请重试'
  }
  finally {
    if (!disposed)
      detailLoading.value = false
  }
}

// 下载发起流程由 useMediaDownload 统一处理（目录校验 / 文件名 / 任务下发与直播录制共用）。
// 回放地址用当前已解析的 playStreamPath（VOD 地址稳定，无需重新拉详情）
const { running: downloading, onActionClick: onDownloadClick } = useMediaDownload({
  kind: 'download',
  liveId: () => props.liveId,
  getRealName: () => realName.value,
  startTime: () => props.startTime,
  ext: () => 'mp4',
  getUrl: async () => playStreamPath.value,
})

onMounted(async () => {
  debugLog('playback', `①录播会话开始（liveId=${props.liveId}, source=${props.source}）: 拉详情`)
  await getLiveOne()
})

onUnmounted(() => {
  disposed = true
  flushPlayDuration()
  debugLog('playback', `⑤录播会话结束（liveId=${props.liveId}）: 销毁播放引擎 → 释放防休眠`)
  destroyPlayer()
  releaseSleepBlocker()
})
</script>

<template>
  <div class="playback-player">
    <div class="playback-content">
      <div class="video-box">
        <div
          ref="videoBoxRef"
          class="video-box-inner"
          :class="{ 'is-cursor-hidden': cursorHidden }"
          @pointermove="revealControls"
          @pointerleave="onContainerLeave"
          @pointerdown="onVideoPointerDown"
          @dblclick="onBoxDblClick"
        >
          <RadioStage
            v-if="isRadio"
            :carousels="carousels"
            :interval="carouselTime"
            @audio="nativeAudio = $event"
            @play="playing = true"
            @pause="playing = false"
            @volumechange="onVolumeChange"
          />
          <div v-else class="video-wrapper" :style="videoWrapperStyle">
            <video
              ref="nativeVideo"
              class="video-player"
              :style="videoStyle"
              @play="playing = true"
              @pause="playing = false"
              @volumechange="onVolumeChange"
            />
          </div>

          <div
            v-show="hasBarrage"
            class="danmaku-list"
            :class="{ 'is-compact': compact }"
            :style="{ fontSize: `${danmakuFontSize}px`, ...danmakuPosition }"
          >
            <!-- 实时层必须常驻：v-if 会重建 TransitionGroup 导致整摞堆叠重播入场动画，
                 v-show 的 display:none 又会让 CSS 动画停摆（详见 DanmakuBubbles 的 .is-hidden 说明） -->
            <DanmakuBubbles
              :items="danmakuOverlayItems"
              :compact="compact"
              :hidden="danmakuMode !== 'live'"
              :plain="danmakuFloating"
            />
            <!-- 全部模式：外壳常驻（同上），内部行用 v-if 懒渲染，避免上千行长期挂在 DOM 上 -->
            <div
              v-show="danmakuMode === 'all'"
              class="danmaku-all"
            >
              <template v-if="danmakuMode === 'all'">
                <div class="danmaku-all__head">
                  <div class="danmaku-all__title">
                    <span>全部弹幕</span>
                    <span class="danmaku-all__count">{{ displayEntries.length }} 条</span>
                  </div>
                  <div class="danmaku-all__meta">
                    观看人数：{{ onlineNumber }} · {{ startDate }}
                  </div>
                  <label class="danmaku-all__search">
                    <MediaIcon name="search" :size="13" />
                    <input
                      v-model="keyword"
                      type="text"
                      placeholder="搜索内容或用户名，点击结果可跳转"
                    >
                  </label>
                </div>
                <div class="danmaku-all__body">
                  <div
                    v-for="(item, index) in displayEntries"
                    :key="index"
                    class="danmaku-all__row"
                    @click="onMiniSeek(item.seconds)"
                  >
                    <template v-if="item.username">
                      <span class="danmaku-author">{{ item.username }}</span>
                      <span class="danmaku-text">{{ item.content }}</span>
                    </template>
                    <span v-else class="danmaku-text">{{ item.content }}</span>
                    <span class="danmaku-all__time">{{ formatMediaTime(item.seconds) }}</span>
                  </div>
                  <div v-if="!barrageLoaded" class="danmaku-all__hint">
                    弹幕加载中…
                  </div>
                  <div v-else-if="displayEntries.length === 0" class="danmaku-all__hint">
                    {{ trimmedKeyword ? '没有匹配的弹幕' : '暂无弹幕' }}
                  </div>
                </div>
              </template>
            </div>
          </div>

          <PlayerLoading
            v-if="isLoading && !playbackError"
            label="正在加载录播"
            hint="连接回放源中，请稍候"
          />
          <div v-else-if="mediaBuffering" class="video-mask buffering">
            <span>缓冲中…</span>
          </div>
          <!-- 录播加载失败卡：与直播失败卡同款深色卡片视觉 -->
          <div v-if="playbackError" class="playback-error" :class="{ 'is-compact': compact }">
            <div class="playback-error__title">
              录播加载失败
            </div>
            <div v-if="realName" class="playback-error__name" :title="realName">
              {{ realName }}
            </div>
            <div class="playback-error__hint">
              {{ playbackError }}
            </div>
            <div class="playback-error__actions">
              <button type="button" class="playback-error__btn playback-error__btn--primary" @click="handleRetry">
                重试
              </button>
              <button
                v-if="playStreamPath"
                type="button"
                class="playback-error__btn playback-error__btn--secondary"
                @click="onDownloadClick"
              >
                {{ downloading ? '取消下载' : '去下载' }}
              </button>
            </div>
          </div>

          <div
            v-show="!playbackError"
            class="player-actions"
            :class="{ 'is-hidden': !controlsVisible, 'has-active': downloading }"
            :inert="!controlsVisible && !downloading"
            @pointerenter="onControlEnter"
            @pointerleave="onControlLeave"
            @focusin="onControlEnter"
            @focusout="onActionsFocusOut"
          >
            <!-- 旋转控制（分段胶囊交互见 RotationControls.vue 头部注释） -->
            <RotationControls
              v-if="!isRadio && !isLoading && !playbackError"
              :angle="rotationAngle"
              :inert="!controlsVisible"
              @rotate-left="rotateLeft"
              @rotate-right="rotateRight"
              @reset="resetRotation"
            />
            <button
              v-if="playStreamPath"
              class="action-btn action-btn--download"
              :class="{ 'is-active': downloading }"
              :title="downloading ? '下载中，点击取消' : '下载'"
              :aria-label="downloading ? '取消下载' : '下载'"
              @click="onDownloadClick"
            >
              <MediaIcon name="download" />
            </button>
          </div>

          <!-- 控制条：录播与电台回放都保留拖动进度 seek 与倍速切换；出错时不渲染 -->
          <MiniControls
            v-if="!isLoading && !playbackError && playStreamPath"
            :playing="playing"
            :muted="muted"
            :volume="volume"
            :hint="shortcutHint"
            :visible="controlsVisible"
            :is-fullscreen="isFullscreen"
            :show-progress="true"
            :current-time="currentTime"
            :duration="mediaDuration"
            :compact="compact"
            :playback-rate="playbackRate"
            :playback-rates="PLAYBACK_RATES"
            @toggle-play="togglePlay"
            @toggle-mute="toggleMute"
            @volume-change="onVolumeSliderInput"
            @toggle-fullscreen="toggleFullscreen"
            @seek="onMiniSeek"
            @rate-change="onRateChange"
            @control-enter="onControlEnter"
            @control-leave="onControlLeave"
          >
            <!-- 弹幕模式切换（实时 ⇄ 全部）：最左端，有弹幕时显示 -->
            <template v-if="hasBarrage" #leading>
              <button
                class="player-capsule__btn danmaku-mode-btn"
                :class="{ 'is-active': danmakuMode === 'all' }"
                :title="danmakuMode === 'live' ? '切换为全部弹幕' : '切换为实时弹幕'"
                :aria-label="danmakuMode === 'live' ? '切换为全部弹幕' : '切换为实时弹幕'"
                @click="toggleDanmakuMode"
              >
                <MediaIcon name="chat" />
              </button>

              <!-- 摆放切换：左侧黑边够宽时出现（窗口态竖屏回放同样适用）。
                   「全部弹幕」面板展开时黑边用不上（面板本身是宽列表），一并隐藏 -->
              <button
                v-if="canFloatDanmaku && danmakuMode === 'live'"
                class="player-capsule__btn danmaku-float-toggle"
                :class="{ 'is-on': danmakuFloating }"
                :title="danmakuFloating ? '弹幕移回画面内' : '弹幕移到左侧黑边'"
                :aria-label="danmakuFloating ? '弹幕移回画面内' : '弹幕移到左侧黑边'"
                @click="toggleDanmakuPlacement"
              >
                <MediaIcon name="panelLeft" />
              </button>
            </template>
          </MiniControls>

          <div v-if="rotateHint" class="rotate-hint">
            {{ rotateHint }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.playback-player {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 悬浮按钮（下载）与右上角容器样式为全局 .player-actions / .action-btn，见 app.scss */

/* 画面占满主区域，弹幕以绝对定位浮在画面左下角；min-height/min-width 为 0 让高度链正确收缩 */
.playback-content {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.video-box {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  background: #000;
}

.video-box-inner {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* 弹幕模式激活态：仅换图标颜色；按钮尺寸与 hover 白纱见全局 .player-capsule__btn */
.danmaku-mode-btn.is-active {
  color: var(--brand-secondary);
}

.danmaku-float-toggle.is-on {
  color: var(--brand-secondary);
}

/* ===== 全部弹幕大玻璃面板：内部滚动 =====
 * 高度上限交给父容器（.danmaku-list 因双约束有确定高度），不用 min(60vh,480px) 这类绝对值；
 * 字号固定，不跟随实时气泡缩放；
 * 无 backdrop-filter：面板悬在视频上，每帧模糊在 DWM 合成退化时成本翻倍 */
.danmaku-all {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  max-height: 90%;
  font-size: 13px;
  border-radius: 14px;
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  overflow: hidden;
  /* 弹幕区整体 pointer-events:none，面板单独恢复交互 */
  pointer-events: auto;
}

.danmaku-all__head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.danmaku-all__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.danmaku-all__count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

/* 搜索框用原生 input：深色玻璃面板里 Element Plus 的浅色皮肤会跳色 */
.danmaku-all__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.92);
  font-family: inherit;
  font-size: 12px;
}

.danmaku-all__search input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.danmaku-all__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}

/* 整行可点：点击跳转到该条弹幕出现的时刻 */
.danmaku-all__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 14px;
  font-size: 1em;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
}

.danmaku-all__row:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* 面板行是满宽固定宽度，可以给正文留固定额度（气泡宽度由内容撑出，留不得） */
.danmaku-all__row .danmaku-author {
  max-width: calc(100% - 140px);
}

/* 发送时间：margin-left:auto 收在行尾，flex-shrink:0 防止被压缩；等宽数字让右边界不抖动 */
.danmaku-all__time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__hint {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-list.is-compact .danmaku-all {
  font-size: 12px;
}

/* 迷你窗视频区只有百余像素，面板要收住就得压缩头部：meta 行让位给搜索框与列表 */
.danmaku-list.is-compact .danmaku-all__head {
  gap: 4px;
  padding: 7px 9px;
  font-size: 12px;
}

.danmaku-list.is-compact .danmaku-all__meta {
  display: none;
}

/* video-wrapper / video-player 公共样式见 app.scss */

.video-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #fff;
  font-size: 14px;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.video-mask.buffering {
  background: transparent;
}

/* 录播加载失败卡：与 LivePlayer 的 .live-end / .live-load-failed 同套深色卡片视觉 */
.playback-error {
  position: absolute;
  inset: 0;
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(var(--fp-gap) * 2);
  padding: 18px;
  background: #0c0c0c;
  color: #fff;
  text-align: center;
  user-select: none;
}

.playback-error__title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 1px;
}

.playback-error__name {
  max-width: 100%;
  font-size: 14px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playback-error__hint {
  max-width: 320px;
  font-size: var(--fp-font);
  line-height: 1.6;
  opacity: 0.58;
}

.playback-error__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 4px;
}

.playback-error__btn {
  padding: 6px 20px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: var(--fp-font);
  color: #fff;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background-color 0.15s ease;

  &:hover {
    filter: brightness(1.12);
  }
}

.playback-error__btn--primary {
  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
}

.playback-error__btn--secondary {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.playback-error.is-compact {
  gap: 6px;
  padding: 12px;
}

.playback-error.is-compact .playback-error__title {
  font-size: 15px;
}
</style>
