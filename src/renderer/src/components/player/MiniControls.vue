<script setup lang="ts">
import type { PropType } from 'vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { formatMediaTime } from '@renderer/utils/time-format'
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  playing: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  /** 当前音量 0..1，0 视同静音 */
  volume: { type: Number, default: 1 },
  isFullscreen: { type: Boolean, default: false },
  /** 录播必须可 seek，直播隐藏进度条 */
  showProgress: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  /** 紧凑模式：时间串只显示当前进度，总时长让位给进度条 */
  compact: { type: Boolean, default: false },
  /** 快捷键提示（调音量 / 快进快退 / 倍速时显示） */
  hint: { type: Object as PropType<{ id: number, text: string } | null>, default: null },
  /** 是否可见（无操作自动隐藏时置 false，平滑淡出） */
  visible: { type: Boolean, default: true },
  /** 录播倍速（传入 playbackRates 时才渲染倍速控件） */
  playbackRate: { type: Number, default: 1 },
  playbackRates: { type: Array as PropType<number[]>, default: () => [] },
})

const emit = defineEmits([
  'togglePlay',
  'toggleMute',
  'toggleFullscreen',
  'seek',
  'volumeChange',
  'rateChange',
  'controlEnter',
  'controlLeave',
])

// 音量 / 倍速面板与进度条预览状态
const volumeOpen = ref(false)
const rateOpen = ref(false)
const hoverVisible = ref(false)
let volumeCloseTimer: ReturnType<typeof setTimeout> | null = null
let rateCloseTimer: ReturnType<typeof setTimeout> | null = null

// 音量：点喇叭切静音，悬停展开滑块。
// 收起延迟 220ms：鼠标从钮斜着移向滑块时会先离开 .mini-volume，立即收起就够不着了。
function openVolume() {
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer)
    volumeCloseTimer = null
  }
  rateOpen.value = false
  volumeOpen.value = true
}

function scheduleCloseVolume() {
  if (volumeCloseTimer)
    clearTimeout(volumeCloseTimer)
  volumeCloseTimer = setTimeout(() => {
    volumeOpen.value = false
    volumeCloseTimer = null
  }, 220)
}

// 倍速面板：与音量面板同款悬停展开与 220ms 收起延迟

function openRate() {
  if (rateCloseTimer) {
    clearTimeout(rateCloseTimer)
    rateCloseTimer = null
  }
  volumeOpen.value = false
  rateOpen.value = true
}

function scheduleCloseRate() {
  if (rateCloseTimer)
    clearTimeout(rateCloseTimer)
  rateCloseTimer = setTimeout(() => {
    rateOpen.value = false
    rateCloseTimer = null
  }, 220)
}

/** 点击倍速钮循环切换到下一档 */
function cyclePlaybackRate() {
  if (!props.playbackRates.length)
    return
  const idx = props.playbackRates.indexOf(props.playbackRate)
  const next = props.playbackRates[(idx + 1) % props.playbackRates.length]
  emit('rateChange', next)
}

function selectPlaybackRate(rate: number) {
  rateOpen.value = false
  emit('rateChange', rate)
}

const reversedRates = computed(() => [...props.playbackRates].reverse())

// 控制条淡出时收起浮层，避免面板悬空残留
watch(() => props.visible, (vis) => {
  if (!vis) {
    volumeOpen.value = false
    rateOpen.value = false
    hoverVisible.value = false
  }
})

onUnmounted(() => {
  if (volumeCloseTimer)
    clearTimeout(volumeCloseTimer)
  if (rateCloseTimer)
    clearTimeout(rateCloseTimer)
})

const volumePercent = computed(() => Math.round(Math.min(1, Math.max(0, props.volume)) * 100))
/** 图标按「实际无声」走：静音或音量归零 */
const mutedIcon = computed(() => props.muted || props.volume <= 0)
const sliderPercent = computed(() => (mutedIcon.value ? 0 : volumePercent.value))

// 提示槽：键盘提示由宿主经 hint 传入，拖动音量滑块在本组件内合成，两者共用
const hintText = ref('')
let hintTimer: ReturnType<typeof setTimeout> | null = null
let lastHintId = 0

function showHint(text: string) {
  hintText.value = text
  if (hintTimer)
    clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    hintText.value = ''
  }, 1000)
}

watch(() => props.hint, (hint) => {
  if (!hint || hint.id === lastHintId)
    return
  lastHintId = hint.id
  showHint(hint.text)
})

onUnmounted(() => {
  if (hintTimer)
    clearTimeout(hintTimer)
})

function onVolumeInput(event: Event) {
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  if (Number.isNaN(value))
    return
  // 按拖动位置直接报：宿主解除静音是异步的，等它回报会滞后
  const percent = Math.round(Math.min(100, Math.max(0, value)))
  showHint(percent > 0 ? `音量 ${percent}%` : '静音')
  emit('volumeChange', value / 100)
}

/** 滚轮一格 5%，与键盘 ↑/↓ 同档 */
const VOLUME_WHEEL_STEP_PERCENT = 5

/** 滚轮微调：基准取滑块显示值（静音态为 0），无变化时不 emit */
function onVolumeWheel(event: WheelEvent) {
  if (event.deltaY === 0)
    return
  const base = mutedIcon.value ? 0 : volumePercent.value
  const step = event.deltaY < 0 ? VOLUME_WHEEL_STEP_PERCENT : -VOLUME_WHEEL_STEP_PERCENT
  const next = Math.round(Math.min(100, Math.max(0, base + step)))
  if (next === base)
    return
  showHint(next > 0 ? `音量 ${next}%` : '静音')
  emit('volumeChange', next / 100)
}

// 进度条：拖拽过程仅更新本地预览位置，松手（change）再真正 seek 媒体，避免长 HLS 反复切片卡顿
const dragging = ref(false)
const dragTime = ref(0)
const displayTime = computed(() => (dragging.value ? dragTime.value : props.currentTime))

const hoverTime = ref(0)
const hoverPercent = ref(0)

function onRangeInput(event: Event) {
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  if (Number.isNaN(value))
    return
  dragging.value = true
  dragTime.value = value
  if (props.duration > 0) {
    hoverTime.value = value
    hoverPercent.value = Math.min(100, Math.max(0, (value / props.duration) * 100))
  }
}

function onRangeChange(event: Event) {
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  dragging.value = false
  if (Number.isNaN(value))
    return
  emit('seek', value)
}

/** 拖出浮窗触发 pointercancel / blur 且未派发原生 change 时，按最后预览位置补交 seek 并复位 */
function commitDrag() {
  if (!dragging.value)
    return
  dragging.value = false
  emit('seek', dragTime.value)
}

function onControlFocusOut(event: FocusEvent) {
  const container = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (!container || !next || !container.contains(next))
    emit('controlLeave')
}

function onProgressMove(event: PointerEvent) {
  if (props.duration <= 0)
    return
  const el = event.currentTarget as HTMLElement | null
  if (!el)
    return
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0)
    return
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  hoverPercent.value = ratio * 100
  hoverTime.value = ratio * props.duration
  hoverVisible.value = true
}

function onProgressLeave() {
  hoverVisible.value = false
}

const previewTipText = computed(() => formatMediaTime(dragging.value ? dragTime.value : hoverTime.value))
const showPreviewTip = computed(() => props.duration > 0 && (hoverVisible.value || dragging.value))

function timeText(): string {
  const current = formatMediaTime(displayTime.value)
  return props.compact ? current : `${current} / ${formatMediaTime(props.duration)}`
}
</script>

<template>
  <!-- 全自绘控制条：直播与录播共用。直播经 #leading 插槽放状态段，录播用内置进度段 -->
  <div
    class="mini-controls player-capsule"
    :class="{ 'mini-controls--progress': showProgress, 'is-hidden': !visible }"
    :inert="!visible"
    @pointerenter="emit('controlEnter')"
    @pointerleave="emit('controlLeave')"
    @focusin="emit('controlEnter')"
    @focusout="onControlFocusOut"
  >
    <slot name="leading" />

    <button
      class="player-capsule__btn"
      :title="playing ? '暂停（空格）' : '播放（空格）'"
      :aria-label="playing ? '暂停' : '播放'"
      @click="emit('togglePlay')"
    >
      <MediaIcon :name="playing ? 'pause' : 'play'" />
    </button>

    <template v-if="showProgress">
      <div
        class="mini-progress"
        @pointermove="onProgressMove"
        @pointerleave="onProgressLeave"
      >
        <input
          type="range"
          class="mini-range"
          :min="0"
          :max="duration || 0"
          :value="displayTime"
          :style="{ '--fill': duration > 0 ? `${Math.min((displayTime / duration) * 100, 100)}%` : '0%' }"
          :aria-label="`播放进度 ${formatMediaTime(displayTime)} / ${formatMediaTime(duration)}`"
          @pointerdown.stop
          @input="onRangeInput"
          @change="onRangeChange"
          @pointercancel="commitDrag"
          @blur="commitDrag"
        >
        <span
          v-if="showPreviewTip"
          class="mini-range-tip"
          :style="{ left: `${hoverPercent}%` }"
        >{{ previewTipText }}</span>
      </div>
      <span class="mini-time" :title="timeText()">{{ timeText() }}</span>
    </template>

    <!-- 倍速（仅录播）：点击循环切换，悬停展开选单 -->
    <div
      v-if="playbackRates.length > 0"
      class="mini-rate"
      @pointerenter="openRate"
      @pointerleave="scheduleCloseRate"
    >
      <button
        class="player-capsule__btn mini-rate__btn"
        :class="{ 'is-open': rateOpen, 'is-active': playbackRate !== 1 }"
        :title="`播放倍速 ${playbackRate}x · 点击切换`"
        :aria-label="`播放倍速 ${playbackRate} 倍`"
        @click="cyclePlaybackRate"
      >
        {{ playbackRate }}x
      </button>

      <div v-if="rateOpen" class="mini-rate__panel" @dblclick.stop>
        <button
          v-for="rate in reversedRates"
          :key="rate"
          type="button"
          class="mini-rate__option"
          :class="{ 'is-current': rate === playbackRate }"
          @click="selectPlaybackRate(rate)"
        >
          {{ rate }}x
        </button>
      </div>
    </div>

    <!-- 音量：点喇叭切静音，悬停浮出滑块，滚轮可微调 -->
    <div
      class="mini-volume"
      @pointerenter="openVolume"
      @pointerleave="scheduleCloseVolume"
      @wheel.prevent="onVolumeWheel"
    >
      <button
        class="player-capsule__btn"
        :class="{ 'is-open': volumeOpen }"
        :title="mutedIcon ? '取消静音（M）' : `静音（M · 当前音量 ${volumePercent}%）`"
        :aria-label="mutedIcon ? '取消静音' : '静音'"
        @click="emit('toggleMute')"
      >
        <MediaIcon :name="mutedIcon ? 'volumeOff' : 'volumeOn'" />
      </button>

      <div v-if="volumeOpen" class="mini-volume__panel" @dblclick.stop>
        <div class="mini-volume__track">
          <input
            type="range"
            class="mini-volume__slider"
            min="0"
            max="100"
            step="1"
            :value="sliderPercent"
            :style="{ '--fill': `${sliderPercent}%` }"
            aria-label="音量"
            @pointerdown.stop
            @input="onVolumeInput"
          >
        </div>
      </div>
    </div>

    <button
      class="player-capsule__btn"
      :title="isFullscreen ? '退出全屏（F）' : '全屏（F）'"
      :aria-label="isFullscreen ? '退出全屏' : '全屏'"
      @click="emit('toggleFullscreen')"
    >
      <MediaIcon :name="isFullscreen ? 'minimize' : 'fullscreen'" />
    </button>

    <!-- 快捷键 / 音量提示：居中浮在胶囊正上方 -->
    <Transition name="mini-hint">
      <span v-if="hintText" class="mini-hint">{{ hintText }}</span>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
@use '../../assets/css/fluid' as *;

/* 全自绘控制条：不参与旋转，恒定贴在容器底部。深色玻璃胶囊骨架见全局 .player-capsule */
.mini-controls {
  /* 进度条轨道 / 滑块：随浮层曲线收放，滑块垂直居中按两者差值算 */
  --mini-track: #{fp(4px, 6px)};
  --mini-thumb: #{fp(10px, 12px)};
  --mini-gutter: #{fp(12px, 18px)};

  position: absolute;
  bottom: var(--fp-control-gap);
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 2 * var(--mini-gutter));
  min-width: 0;
  gap: 0px;
  padding: var(--fp-capsule-pad) fp(7px, 12px);
  z-index: 20;
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;

  &.is-hidden {
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 6px);
  }
}

/* 有进度段（录播/回放）：随容器拉伸，540px 封顶；直播与窄容器仍走 shrink-to-fit */
.mini-controls--progress {
  width: min(calc(100% - 2 * var(--mini-gutter)), 540px);
}

/* 进度条外框：提供悬停时间气泡的定位锚点 */
.mini-progress {
  position: relative;
  flex: 1 1000 120px;
  min-width: 0;
  display: flex;
  align-items: center;
  margin: 0 fp(4px, 6px);
}

/* 迷你进度条：优先吸收富余空间，空间不足时先收缩 */
.mini-range {
  width: 100%;
  min-width: 0;
  margin: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;

  &::-webkit-slider-runnable-track {
    height: var(--mini-track);
    border-radius: calc(var(--mini-track) / 2);
    background: linear-gradient(
      to right,
      var(--brand-secondary),
      var(--brand-primary) var(--fill, 0%),
      rgba(255, 255, 255, 0.2) var(--fill, 0%)
    );
    transition: transform 0.15s ease;
  }

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--mini-thumb);
    height: var(--mini-thumb);
    margin-top: calc((var(--mini-track) - var(--mini-thumb)) / 2);
    border-radius: 50%;
    background: var(--brand-primary);
    transition:
      transform 0.15s ease,
      box-shadow 0.15s ease;
  }

  &:hover {
    &::-webkit-slider-runnable-track {
      transform: scaleY(1.3);
    }
    &::-webkit-slider-thumb {
      transform: scaleX(1.3);
      box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.15);
    }
  }

  &:active::-webkit-slider-thumb {
    transform: scaleX(1.3);
  }
}

/* 进度条悬停 / 拖拽时间气泡 */
.mini-range-tip {
  position: absolute;
  bottom: calc(100% + #{fp(10px, 14px)});
  transform: translateX(-50%);
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  font-size: var(--fp-font-sm);
  font-variant-numeric: tabular-nums;
  color: #fff;
  white-space: nowrap;
  pointer-events: none;
  z-index: 32;
}

/* 倍速控件：与音量控件同款锚点 + 上浮面板 */
.mini-rate {
  position: relative;
  flex-shrink: 0;

  &__btn {
    width: auto;
    min-width: var(--fp-capsule-btn);
    padding: 0 fp(5px, 7px);
    border-radius: var(--radius-pill);
    font-size: var(--fp-font-sm);
    font-weight: 600;

    &.is-open {
      background: var(--player-glass-hover);
    }

    &.is-active {
      color: var(--brand-secondary);
    }
  }

  &__panel {
    position: absolute;
    bottom: calc(100% + #{fp(1px, 2px)});
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: fp(4px, 5px);
    border-radius: fp(10px, 12px);
    background: var(--player-glass-bg);
    box-shadow: inset 0 0 0 1px var(--player-glass-ring);
    z-index: 30;
  }

  &__option {
    padding: fp(3px, 4px) fp(9px, 11px);
    border: none;
    border-radius: var(--radius-pill);
    font-family: inherit;
    font-size: var(--fp-font-sm);
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.86);
    background: transparent;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      color: #fff;
      background: var(--player-glass-hover);
    }

    &.is-current {
      font-weight: 600;
      color: var(--brand-secondary);
      background: rgba(255, 255, 255, 0.1);
    }
  }
}

/* 音量：锚住喇叭钮，面板从胶囊上沿浮出 */
.mini-volume {
  position: relative;
  flex-shrink: 0;

  /* 浮层开着时喇叭钮保持高亮 */
  .player-capsule__btn.is-open {
    background: var(--player-glass-hover);
  }

  &__panel {
    position: absolute;
    /* 紧贴喇叭钮上沿，中间不留空档 */
    bottom: calc(100% + #{fp(1px, 2px)});
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    justify-content: center;
    padding: fp(4px, 5px);
    border-radius: var(--radius-pill);
    /* 与胶囊同一块玻璃；叠第二层同值半透明会发白，只补描边 */
    background: var(--player-glass-bg);
    box-shadow: inset 0 0 0 1px var(--player-glass-ring);
    z-index: 30;
  }

  /* 滑块热区：竖条很细，靠它留出左右落点 */
  &__track {
    display: flex;
    align-items: center;
    justify-content: center;
    width: fp(16px, 20px);
    height: fp(84px, 104px);
    cursor: pointer;
  }

  /* 竖向滑条：rtl 让低音量落在底端。
   * 填充方向与 thumb 相反 —— rtl 只翻转 thumb 落点，渐变仍从块起点长起，故写 to top
   * （写 to right / to left 会在小声时亮满整条） */
  &__slider {
    --vol-track: #{fp(5px, 6px)};
    --vol-thumb: #{fp(14px, 17px)};
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
        rgba(255, 255, 255, 0.22) var(--fill, 0%)
      );
    }

    /* vertical-lr 下 thumb 偏轨道左沿，用 margin-left 拉回居中 */
    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: var(--vol-thumb);
      height: var(--vol-thumb);
      margin-left: calc((var(--vol-track) - var(--vol-thumb)) / 2);
      border-radius: 50%;
      border: fp(2px, 2.5px) solid rgba(255, 255, 255, 0.92);
      background: var(--brand-primary);
      box-shadow: 0 fp(1px, 2px) fp(3px, 4px) rgba(0, 0, 0, 0.35);
      transition: transform 0.15s ease;
    }

    &:hover::-webkit-slider-thumb,
    &:active::-webkit-slider-thumb {
      transform: scale(1.12);
    }
  }
}

/* 快捷键 / 音量提示：居中浮在胶囊正上方，不参与 flex、不撑宽胶囊 */
.mini-hint {
  position: absolute;
  left: 50%;
  bottom: calc(100% + #{fp(10px, 14px)});
  transform: translateX(-50%);
  padding: fp(3px, 4px) fp(9px, 12px);
  border-radius: var(--radius-pill);
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  font-size: var(--fp-font-sm);
  font-variant-numeric: tabular-nums;
  color: #fff;
  white-space: nowrap;
  pointer-events: none;
  z-index: 31;
}

.mini-hint-enter-active,
.mini-hint-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.mini-hint-enter-from,
.mini-hint-leave-to {
  opacity: 0;
  transform: translate(-50%, 4px);
}

/* 时间串在进度条让尽后才截断 */
.mini-time {
  flex: 0 1 auto;
  min-width: 0;
  margin-right: fp(2px, 4px);
  font-size: var(--fp-font-sm);
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (prefers-reduced-motion: reduce) {
  .mini-controls {
    transition: none;
  }
}
</style>
