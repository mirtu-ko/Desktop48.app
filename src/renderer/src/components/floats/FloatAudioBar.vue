<script setup lang="ts">
import CoverImage from '@renderer/components/ui/CoverImage.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import useAudioPlayerStore from '@renderer/stores/audio-player'
import { formatMediaTime } from '@renderer/utils/time-format'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

const {
  playlist,
  currentIndex,
  currentTrack,
  playing,
  currentTime,
  duration,
  volume,
  muted,
  playAt,
  togglePlay,
  next,
  prev,
  seek,
  setVolume,
  toggleMute,
  removeAt,
  clearAll,
  isCurrent,
  isBroken,
} = useAudioPlayerStore()

/** 队列面板展开态 */
const panelVisible = ref(false)
/** 折叠为左下角迷你黑胶圆球 */
const collapsed = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const progressRef = ref<HTMLElement | null>(null)

// 进度条拖拽 / 悬停预览状态
const dragging = ref(false)
const dragRatio = ref(0)
const hovering = ref(false)
const hoverRatio = ref(0)

// 音量浮层：悬停展开竖向滑块，220ms 延迟收起防斜移误关；拖动期间锁定不收起
const VOLUME_WHEEL_STEP = 0.05
const volumeOpen = ref(false)
const volumeDragging = ref(false)
const volumePointerInside = ref(false)
let volumeCloseTimer: ReturnType<typeof setTimeout> | null = null
const volumeHint = ref('')
let volumeHintTimer: ReturnType<typeof setTimeout> | null = null

const volumePercent = computed(() => Math.round(Math.min(1, Math.max(0, volume.value)) * 100))
const isMutedVisual = computed(() => muted.value || volume.value <= 0)
const sliderPercent = computed(() => (isMutedVisual.value ? 0 : volumePercent.value))

function showVolumeHint(text: string) {
  volumeHint.value = text
  if (volumeHintTimer)
    clearTimeout(volumeHintTimer)
  volumeHintTimer = setTimeout(() => {
    volumeHint.value = ''
    volumeHintTimer = null
  }, 1000)
}

function clearVolumeCloseTimer() {
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer)
    volumeCloseTimer = null
  }
}

function openVolume() {
  volumePointerInside.value = true
  clearVolumeCloseTimer()
  volumeOpen.value = true
}

function scheduleCloseVolume() {
  volumePointerInside.value = false
  if (volumeDragging.value)
    return
  clearVolumeCloseTimer()
  volumeCloseTimer = setTimeout(() => {
    volumeOpen.value = false
    volumeCloseTimer = null
  }, 220)
}

function onVolumeSliderPointerDown() {
  volumeDragging.value = true
  clearVolumeCloseTimer()
}

function onVolumeInput(event: Event) {
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  if (Number.isNaN(value))
    return
  const percent = Math.round(Math.min(100, Math.max(0, value)))
  setVolume(percent / 100)
  showVolumeHint(percent > 0 ? `音量 ${percent}%` : '静音')
}

function onToggleMute() {
  toggleMute()
  showVolumeHint(isMutedVisual.value ? '静音' : `音量 ${volumePercent.value}%`)
}

function onVolumeWheel(event: WheelEvent) {
  const base = isMutedVisual.value ? 0 : volume.value
  const delta = event.deltaY < 0 ? VOLUME_WHEEL_STEP : -VOLUME_WHEEL_STEP
  const next = Math.round(Math.min(1, Math.max(0, base + delta)) * 100) / 100
  setVolume(next)
  const percent = Math.round(next * 100)
  showVolumeHint(percent > 0 ? `音量 ${percent}%` : '静音')
}

useEventListener(window, 'pointerup', () => {
  if (!volumeDragging.value)
    return
  volumeDragging.value = false
  if (!volumePointerInside.value)
    scheduleCloseVolume()
})

useEventListener(window, 'pointercancel', () => {
  if (!volumeDragging.value)
    return
  volumeDragging.value = false
  if (!volumePointerInside.value)
    scheduleCloseVolume()
})

const progress = computed(() => {
  if (!duration.value)
    return 0
  return Math.min(1, Math.max(0, currentTime.value / duration.value))
})

const displayProgress = computed(() => (dragging.value ? dragRatio.value : progress.value))
const canSeek = computed(() => duration.value > 0)
const previewRatio = computed(() => (dragging.value ? dragRatio.value : hoverRatio.value))
const showProgressTip = computed(() => canSeek.value && (dragging.value || hovering.value))
const previewTimeText = computed(() => formatMediaTime(previewRatio.value * (duration.value || 0)))

const hasPlayableTrack = computed(() => playlist.value.some(track => !isBroken(track.url)))
const hasPrevPlayable = computed(() => {
  for (let i = currentIndex.value - 1; i >= 0; i--) {
    if (!isBroken(playlist.value[i].url))
      return true
  }
  return false
})
const hasNextPlayable = computed(() => {
  for (let i = currentIndex.value + 1; i < playlist.value.length; i++) {
    if (!isBroken(playlist.value[i].url))
      return true
  }
  return false
})
/** 上一首可用条件：存在更早的可用曲目，或当前曲目已播超 3 秒（点击可回到开头） */
const canPrev = computed(() => currentIndex.value >= 0 && (currentTime.value > 3 || hasPrevPlayable.value))

const barTitle = computed(() => currentTrack.value?.name || '播放列表')
const barSubTitle = computed(() =>
  currentTrack.value
    ? `${currentTrack.value.singer} · ${currentTrack.value.albumTitle}`
    : `${playlist.value.length} 首待播`,
)

const coverStyle = computed(() => ({
  '--cover': currentTrack.value?.cover ? `url(${currentTrack.value.cover})` : 'none',
}))

function getRatioFromPointer(event: PointerEvent): number {
  const el = progressRef.value
  if (!el)
    return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0)
    return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

function onProgressPointerDown(event: PointerEvent) {
  if (!canSeek.value || event.button !== 0)
    return
  const el = progressRef.value
  el?.setPointerCapture?.(event.pointerId)
  dragging.value = true
  dragRatio.value = getRatioFromPointer(event)
}

function onProgressPointerMove(event: PointerEvent) {
  if (!canSeek.value)
    return
  const ratio = getRatioFromPointer(event)
  if (dragging.value) {
    dragRatio.value = ratio
    return
  }
  hovering.value = true
  hoverRatio.value = ratio
}

function finishProgressDrag(event: PointerEvent, commit: boolean) {
  if (!dragging.value)
    return
  const el = progressRef.value
  if (el?.hasPointerCapture?.(event.pointerId))
    el.releasePointerCapture(event.pointerId)
  const ratio = getRatioFromPointer(event)
  dragging.value = false
  if (commit && canSeek.value)
    seek(ratio * duration.value)
}

function onProgressPointerLeave() {
  hovering.value = false
}

function onTrackClick(index: number, url: string) {
  if (isBroken(url))
    return
  playAt(index)
}

function onInfoKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    panelVisible.value = !panelVisible.value
  }
}

/** 切换折叠态（折叠时同步收起队列面板与音量浮层） */
function toggleCollapsed() {
  collapsed.value = !collapsed.value
  if (collapsed.value) {
    panelVisible.value = false
    volumeOpen.value = false
  }
}

/** 一键停止播放并关闭浮窗 */
function onCloseBar() {
  clearVolumeCloseTimer()
  volumeOpen.value = false
  panelVisible.value = false
  collapsed.value = false
  clearAll()
}

// 列表被逐首移除清空时复位折叠态，下次起播默认以完整条出现
watch(() => playlist.value.length, (length) => {
  if (length === 0) {
    panelVisible.value = false
    collapsed.value = false
  }
})

// 展开面板时自动滚动到当前播放行
watch(panelVisible, async (visible) => {
  if (!visible)
    return
  await nextTick()
  panelRef.value?.querySelector('.panel-row.is-current')?.scrollIntoView({ block: 'nearest' })
})

// 点面板与播放条外部区域自动收起
useEventListener(document, 'pointerdown', (event: PointerEvent) => {
  if (!panelVisible.value)
    return
  if (rootRef.value && !rootRef.value.contains(event.target as Node))
    panelVisible.value = false
})

// 按 Esc 收起队列面板（跳过输入法组词态）
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.isComposing)
    return
  if (event.key === 'Escape' && panelVisible.value)
    panelVisible.value = false
})

onUnmounted(() => {
  clearVolumeCloseTimer()
  if (volumeHintTimer)
    clearTimeout(volumeHintTimer)
})
</script>

<template>
  <!-- 播放列表为空时整体隐藏（清空队列必已停止播放） -->
  <div v-if="playlist.length" ref="rootRef" class="float-audio">
    <!-- 队列面板：向上展开 -->
    <transition name="panel-pop">
      <div v-if="panelVisible" ref="panelRef" class="audio-panel frosted-surface">
        <div class="panel-head">
          <span class="panel-title">播放列表</span>
          <span class="panel-count">{{ playlist.length }} 首</span>
        </div>
        <el-scrollbar max-height="300px" class="panel-scroll">
          <div
            v-for="(track, index) in playlist"
            :key="track.key"
            class="panel-row"
            :class="{ 'is-current': isCurrent(track.key), 'is-broken': isBroken(track.url) }"
            @click="onTrackClick(index, track.url)"
          >
            <span class="row-index">
              <!-- 当前播放：均衡器跳动动效 -->
              <span v-if="isCurrent(track.key)" class="eq" :class="{ paused: !playing }">
                <i /><i /><i />
              </span>
              <template v-else>{{ index + 1 }}</template>
            </span>
            <CoverImage class="row-cover" :src="track.cover" :alt="track.name" loading="lazy">
              <span class="row-cover-ph"><MediaIcon name="playlistFilled" :size="14" /></span>
            </CoverImage>
            <div class="row-info">
              <div class="row-name ellipsis" :title="isBroken(track.url) ? `${track.name}（音频不可用）` : track.name">
                {{ track.name }}
              </div>
              <div class="row-album ellipsis" :title="`${track.singer} · ${track.albumTitle}`">
                {{ track.singer }} · {{ track.albumTitle }}
              </div>
            </div>
            <button class="row-remove" title="移除" @click.stop="removeAt(index)">
              <MediaIcon name="close" :size="13" />
            </button>
          </div>
        </el-scrollbar>
      </div>
    </transition>

    <!-- 折叠态：外层定位容器 + 同级圆球按钮与关闭徽章，避免交互元素嵌套截获键盘事件 -->
    <div v-if="collapsed" class="audio-orb-wrap">
      <button
        type="button"
        class="audio-orb frosted-surface"
        :class="{ 'is-playing': playing }"
        :style="{ '--orb-progress': `${displayProgress * 360}deg` }"
        :title="currentTrack ? `展开播放条 · ${currentTrack.name}` : '展开播放条'"
        :aria-label="currentTrack ? `展开播放条 · ${currentTrack.name}` : '展开播放条'"
        @click="toggleCollapsed"
      >
        <span class="bar-vinyl" :class="{ 'is-playing': playing }" :style="coverStyle" />
      </button>
      <button
        type="button"
        class="bar-close bar-close--orb"
        title="停止并关闭"
        aria-label="停止并关闭"
        @click="onCloseBar"
      >
        <MediaIcon name="close" :size="11" />
      </button>
    </div>

    <!-- 展开态迷你播放条：小旋转黑胶 + 进度 + 控制键；悬停右上角浮出关闭徽章 -->
    <div v-else class="audio-bar frosted-surface" :class="{ 'is-playing': playing }">
      <button
        class="bar-close"
        title="停止并关闭"
        aria-label="停止并关闭"
        @click.stop="onCloseBar"
      >
        <MediaIcon name="close" :size="11" />
      </button>

      <div
        ref="progressRef"
        class="bar-progress"
        :class="{ 'is-dragging': dragging, 'is-disabled': !canSeek }"
        @pointerdown="onProgressPointerDown"
        @pointermove="onProgressPointerMove"
        @pointerup="finishProgressDrag($event, true)"
        @pointercancel="finishProgressDrag($event, false)"
        @pointerleave="onProgressPointerLeave"
      >
        <div class="bar-progress-fill" :class="{ 'is-playing': playing }" :style="{ width: `${displayProgress * 100}%` }">
          <span v-if="canSeek" class="bar-progress-thumb" />
        </div>
        <span
          v-if="showProgressTip"
          class="bar-progress-tip"
          :style="{ left: `${previewRatio * 100}%` }"
        >
          {{ previewTimeText }}
        </span>
      </div>

      <span
        class="bar-vinyl"
        :class="{ 'is-playing': playing }"
        :style="coverStyle"
        role="button"
        tabindex="0"
        title="收起为迷你黑胶"
        @click="toggleCollapsed"
        @keydown.enter.space.prevent="toggleCollapsed"
      />

      <div
        class="bar-info"
        role="button"
        tabindex="0"
        :aria-expanded="panelVisible"
        :title="panelVisible ? '收起播放列表' : `${barTitle} · 点击展开播放列表`"
        @click="panelVisible = !panelVisible"
        @keydown="onInfoKeydown"
      >
        <div class="bar-name-row">
          <span v-if="playing" class="eq bar-eq" aria-hidden="true">
            <i /><i /><i />
          </span>
          <div class="bar-name ellipsis">
            {{ barTitle }}
          </div>
        </div>
        <div class="bar-sub-row" :title="barSubTitle">
          <span v-if="currentTrack" class="bar-time">{{ formatMediaTime(currentTime) }} / {{ formatMediaTime(duration) }}</span>
          <span v-else class="bar-sub ellipsis">{{ barSubTitle }}</span>
        </div>
      </div>

      <div class="bar-actions">
        <button
          class="ctrl-btn"
          :title="currentTime > 3 ? '重新播放本曲' : '上一首'"
          :disabled="!canPrev"
          @click="prev"
        >
          <MediaIcon name="prevFilled" :size="14" />
        </button>
        <button
          class="ctrl-btn ctrl-main"
          :title="playing ? '暂停' : '播放'"
          :disabled="!hasPlayableTrack"
          @click="togglePlay"
        >
          <MediaIcon :name="playing ? 'pauseFilled' : 'playFilled'" :size="15" />
        </button>
        <button
          class="ctrl-btn"
          title="下一首"
          :disabled="!hasNextPlayable"
          @click="next"
        >
          <MediaIcon name="nextFilled" :size="14" />
        </button>

        <!-- 音量：点喇叭切静音，悬停浮出竖向滑块，支持滚轮微调 -->
        <div
          class="bar-volume"
          @pointerenter="openVolume"
          @pointerleave="scheduleCloseVolume"
          @wheel.prevent="onVolumeWheel"
        >
          <button
            class="ctrl-btn"
            :class="{ 'is-active': volumeOpen }"
            :title="isMutedVisual ? '取消静音' : `音量 ${volumePercent}%`"
            :aria-label="isMutedVisual ? '取消静音' : '静音'"
            @click="onToggleMute"
          >
            <MediaIcon :name="isMutedVisual ? 'volumeOff' : 'volumeOn'" :size="14" />
          </button>

          <div v-if="volumeOpen" class="bar-volume-panel frosted-surface">
            <div class="bar-volume-track">
              <input
                type="range"
                class="bar-volume-slider"
                min="0"
                max="100"
                step="1"
                :value="sliderPercent"
                :style="{ '--fill': `${sliderPercent}%` }"
                aria-label="音量"
                @pointerdown.stop="onVolumeSliderPointerDown"
                @input="onVolumeInput"
              >
            </div>
          </div>

          <Transition name="vol-hint">
            <span v-if="volumeHint" class="bar-volume-hint" :class="{ 'is-above-panel': volumeOpen }">
              {{ volumeHint }}
            </span>
          </Transition>
        </div>

        <button
          class="ctrl-btn ctrl-list"
          :class="{ 'is-active': panelVisible }"
          :title="panelVisible ? '收起播放列表' : '播放列表'"
          @click="panelVisible = !panelVisible"
        >
          <MediaIcon name="playlistFilled" :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 左下角浮动播放条：与底部 Dock 同层的磨砂玻璃质感 */
.float-audio {
  position: fixed;
  left: 14px;
  bottom: 14px;
  z-index: 99;
}

/* ===== 队列面板 ===== */
.audio-panel {
  --glass-fill: color-mix(in srgb, var(--el-bg-color) 90%, transparent);
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  width: min(340px, calc(100vw - 28px));
  border: 1px solid color-mix(in srgb, var(--brand-primary) 20%, var(--el-border-color-lighter));
  border-radius: var(--radius-lg);
  box-shadow:
    0 14px 36px -10px rgba(var(--brand-rgb), 0.26),
    var(--shadow-lg),
    var(--glass-lip);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--el-border-color-lighter) 70%, transparent);

  .panel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .panel-count {
    flex: 1;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }
}

.panel-scroll {
  :deep(.el-scrollbar__view) {
    padding: 4px 6px 8px;
  }
}

.panel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);

    .row-remove {
      opacity: 1;
    }
  }

  &.is-current {
    background: color-mix(in srgb, var(--brand-primary) 10%, transparent);

    .row-name {
      color: var(--brand-primary);
      font-weight: 600;
    }
  }

  /* 失效曲目：置灰不可播 */
  &.is-broken {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.row-index {
  flex: none;
  width: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.row-cover {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  box-shadow: var(--shadow-xs);
}

/* 破图占位：与 img 同尺寸的图标底座 */
.row-cover-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-sm);
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.row-info {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.row-album {
  margin-top: 2px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.row-remove {
  flex: none;
  display: inline-flex;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;

  &:hover {
    background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
    color: var(--el-color-danger);
  }
}

/* ===== 折叠态迷你黑胶圆球 ===== */
.audio-orb-wrap {
  position: relative;
  display: inline-flex;
}

.audio-orb {
  --glass-fill: color-mix(in srgb, var(--el-bg-color) 90%, transparent);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 50px;
  padding: 0;
  border: none;
  border-radius: 50%;
  box-shadow:
    0 10px 26px -6px rgba(var(--brand-rgb), 0.34),
    0 4px 10px -2px rgba(var(--shadow-rgb), 0.16),
    var(--glass-lip);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.25s ease;

  /* 外圈实时进度环：品牌紫→玫瑰粉渐变 */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    padding: 2.5px;
    background: conic-gradient(
      var(--brand-primary) 0deg,
      var(--brand-secondary) var(--orb-progress, 0deg),
      rgba(var(--brand-rgb), 0.16) var(--orb-progress, 0deg)
    );
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  &.is-playing {
    animation: audio-orb-pulse 2.2s ease-in-out infinite;
  }

  &:hover {
    transform: translateY(-2px) scale(1.04);
  }

  &:active {
    transform: scale(0.96);
  }
}

/* ===== 迷你播放条 ===== */
.audio-bar {
  --glass-fill: color-mix(in srgb, var(--el-bg-color) 88%, transparent);
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 320px;
  padding: 7px 8px 7px 10px;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 26%, var(--el-border-color-lighter));
  border-radius: var(--radius-pill);
  background:
    radial-gradient(110% 160% at 0% 50%, rgba(var(--brand-rgb), 0.15), transparent 56%),
    radial-gradient(90% 150% at 100% 50%, rgba(255, 143, 184, 0.1), transparent 52%), var(--glass-sheen),
    var(--glass-fill);
  box-shadow:
    0 12px 30px -8px rgba(var(--brand-rgb), 0.3),
    0 4px 12px -2px rgba(var(--shadow-rgb), 0.16),
    var(--glass-lip);
  transition:
    border-color 0.25s ease,
    box-shadow 0.25s ease;

  &.is-playing {
    border-color: color-mix(in srgb, var(--brand-primary) 44%, transparent);
    box-shadow:
      0 14px 34px -8px rgba(var(--brand-rgb), 0.4),
      0 4px 14px -2px rgba(var(--shadow-rgb), 0.18),
      0 0 0 1px rgba(var(--brand-rgb), 0.1),
      var(--glass-lip);
  }
}

/* 右上角悬浮关闭徽章：默认隐藏不占空间，hover 播放条或黑胶球时浮出 */
.bar-close {
  position: absolute;
  top: -7px;
  right: -5px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 50%;
  background: var(--el-bg-color);
  color: var(--el-text-color-secondary);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.8);
  transition:
    opacity 0.16s ease,
    transform 0.2s ease,
    background-color 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;

  .audio-bar:hover &,
  .audio-bar:focus-within &,
  .audio-orb-wrap:hover &,
  .audio-orb-wrap:focus-within & {
    opacity: 1;
    pointer-events: auto;
    transform: scale(1);
  }

  &:hover {
    border-color: var(--el-color-danger);
    background: var(--el-color-danger);
    color: #fff;
    transform: scale(1.06) rotate(90deg);
  }
}

.bar-close--orb {
  top: -4px;
  right: -4px;
}

/* 顶部细进度条：支持点击与按住拖拽，悬停展示圆点与时间预览。
 * 线浮在胶囊顶边（y≈0），该高度圆弧肩部内缩约 20px，
 * 左右端收到 22px 起止，避免越过上下圆弧 */
.bar-progress {
  position: absolute;
  top: -5px;
  left: 22px;
  right: 22px;
  height: 10px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  touch-action: none;

  &.is-disabled {
    cursor: default;
  }

  /* 可点击热区，视觉上只显示 2px，悬停/拖拽时增粗到 4px */
  &::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 4px;
    height: 2px;
    border-radius: inherit;
    background: color-mix(in srgb, var(--el-border-color) 60%, transparent);
    transition:
      top 0.15s ease,
      height 0.15s ease;
  }

  &:not(.is-disabled):hover::before,
  &.is-dragging::before {
    top: 3px;
    height: 4px;
  }
}

.bar-progress-fill {
  position: relative;
  height: 2px;
  margin-top: 4px;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--brand-primary), var(--brand-secondary));
  box-shadow: 0 0 8px -1px rgba(var(--brand-rgb), 0.65);
  transition:
    height 0.15s ease,
    margin-top 0.15s ease;
  pointer-events: none;
  overflow: hidden;

  /* 播放中进度条柔和流光 */
  &.is-playing::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
    animation: audio-bar-shimmer 2.4s linear infinite;
  }

  .bar-progress:not(.is-disabled):hover &,
  .bar-progress.is-dragging & {
    height: 4px;
    margin-top: 3px;
    overflow: visible;
  }
}

.bar-progress-thumb {
  position: absolute;
  right: 0;
  top: 50%;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--brand-primary);
  box-shadow:
    0 0 0 2px #fff,
    0 1px 4px rgba(var(--brand-rgb), 0.55);
  transform: translate(50%, -50%) scale(0);
  opacity: 0;
  transition:
    transform 0.15s ease,
    opacity 0.15s ease;

  .bar-progress:not(.is-disabled):hover &,
  .bar-progress.is-dragging & {
    transform: translate(50%, -50%) scale(1);
    opacity: 1;
  }
}

.bar-progress-tip {
  position: absolute;
  bottom: calc(100% + 4px);
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  background: rgba(15, 17, 26, 0.82);
  color: #fff;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}

/* 小黑胶：纹理由类样式绘制，外圈反光与封面盘标同步旋转，播放时亮起呼吸光环 */
.bar-vinyl {
  position: relative;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: repeating-radial-gradient(circle at 50% 50%, #191920 0 1.5px, #23232c 1.5px 2.5px);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  cursor: pointer;

  /* 黑胶盘面高光反光：随盘标同步旋转，播放时肉眼可见整张黑胶在转 */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from 20deg,
      transparent 0deg 55deg,
      rgba(255, 255, 255, 0.22) 80deg,
      transparent 115deg 235deg,
      rgba(255, 255, 255, 0.14) 260deg,
      transparent 295deg 360deg
    );
    animation: spin 8s linear infinite;
    animation-play-state: paused;
    pointer-events: none;
  }

  /* 封面盘标层：播放时旋转 */
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    background-image: var(--cover);
    background-size: cover;
    background-position: center;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
    /* 旋转动画见全局 @keyframes spin */
    animation: spin 8s linear infinite;
    animation-play-state: paused;
  }

  &.is-playing {
    animation: audio-vinyl-pulse 2.2s ease-in-out infinite;

    &::before,
    &::after {
      animation-play-state: running;
    }
  }
}

.bar-info {
  flex: 1;
  min-width: 0;
  margin: -3px -4px;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.16s ease;

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 8%, transparent);

    .bar-name {
      color: var(--brand-primary);
    }
  }
}

.bar-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.bar-eq {
  flex: none;
  height: 10px;
}

.bar-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  transition: color 0.16s ease;
}

.bar-sub-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-top: 2px;
}

.bar-sub {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.bar-time {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.bar-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex: none;
}

.ctrl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
    color: var(--brand-primary);
  }

  &:active:not(:disabled) {
    transform: scale(0.92);
  }

  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* 主播放键：品牌渐变实心圆 */
  &.ctrl-main {
    width: 32px;
    height: 32px;
    margin: 0 2px;
    background: var(--gradient-brand);
    color: #fff;
    box-shadow: var(--shadow-glow);

    &:hover:not(:disabled) {
      color: #fff;
      background: linear-gradient(135deg, var(--brand-primary-dark), var(--brand-primary));
    }
  }

  &.is-active {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  }
}

/* 音量：锚住喇叭钮，向上浮出浅色磨砂竖向滑块，交互与 MiniControls 一致 */
.bar-volume {
  position: relative;
  flex: none;
}

.bar-volume-panel {
  --glass-fill: color-mix(in srgb, var(--el-bg-color) 92%, transparent);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  justify-content: center;
  padding: 8px 6px;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 22%, var(--el-border-color-lighter));
  border-radius: var(--radius-pill);
  box-shadow:
    0 10px 24px -8px rgba(var(--brand-rgb), 0.28),
    var(--shadow-md),
    var(--glass-lip);
  z-index: 4;
}

.bar-volume-track {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 92px;
  cursor: pointer;
}

.bar-volume-slider {
  --vol-track: 5px;
  --vol-thumb: 14px;
  width: 100%;
  height: 100%;
  margin: 0;
  writing-mode: vertical-lr;
  direction: rtl;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  cursor: pointer;

  &::-webkit-slider-runnable-track {
    width: var(--vol-track);
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(
      to top,
      var(--brand-secondary),
      var(--brand-primary) var(--fill, 0%),
      color-mix(in srgb, var(--el-border-color) 60%, transparent) var(--fill, 0%)
    );
  }

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--vol-thumb);
    height: var(--vol-thumb);
    margin-left: calc((var(--vol-track) - var(--vol-thumb)) / 2);
    border-radius: 50%;
    border: 2px solid #fff;
    background: var(--brand-primary);
    box-shadow: 0 1px 4px rgba(var(--brand-rgb), 0.5);
    transition: transform 0.15s ease;
  }

  &:hover::-webkit-slider-thumb,
  &:active::-webkit-slider-thumb {
    transform: scale(1.12);
  }
}

.bar-volume-hint {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: rgba(15, 17, 26, 0.82);
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;

  &.is-above-panel {
    bottom: calc(100% + 124px);
  }
}

.vol-hint-enter-active,
.vol-hint-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.vol-hint-enter-from,
.vol-hint-leave-to {
  opacity: 0;
  transform: translate(-50%, 4px);
}

/* 窄窗口收窄播放条，避免与底部居中 AppDock 重叠 */
@media (max-width: 1120px) {
  .audio-bar {
    width: clamp(260px, 25vw, 292px);
    gap: 6px;
  }
}

@keyframes audio-vinyl-pulse {
  0%,
  100% {
    box-shadow:
      var(--shadow-sm),
      0 0 0 0 rgba(var(--brand-rgb), 0.42),
      inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  }

  50% {
    box-shadow:
      var(--shadow-sm),
      0 0 0 6px rgba(var(--brand-rgb), 0),
      inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  }
}

@keyframes audio-orb-pulse {
  0%,
  100% {
    box-shadow:
      0 10px 26px -6px rgba(var(--brand-rgb), 0.34),
      0 0 0 0 rgba(var(--brand-rgb), 0.36),
      var(--glass-lip);
  }

  50% {
    box-shadow:
      0 10px 26px -6px rgba(var(--brand-rgb), 0.34),
      0 0 0 8px rgba(var(--brand-rgb), 0),
      var(--glass-lip);
  }
}

@keyframes audio-bar-shimmer {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bar-vinyl.is-playing,
  .audio-orb.is-playing,
  .bar-progress-fill.is-playing::after {
    animation: none;
  }
}

/* 面板弹出动画 */
.panel-pop-enter-active,
.panel-pop-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.panel-pop-enter-from,
.panel-pop-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.96);
}
</style>
