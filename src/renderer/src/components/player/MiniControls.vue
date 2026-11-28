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
  /** 快捷键提示（调音量时显示当前音量） */
  hint: { type: Object as PropType<{ id: number, text: string } | null>, default: null },
})

const emit = defineEmits(['togglePlay', 'toggleMute', 'toggleFullscreen', 'seek', 'volumeChange'])

// 音量：点喇叭切静音，悬停展开滑块。
// 收起延迟 220ms：鼠标从钮斜着移向滑块时会先离开 .mini-volume，立即收起就够不着了。
const volumeOpen = ref(false)
let volumeCloseTimer: ReturnType<typeof setTimeout> | null = null

function openVolume() {
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer)
    volumeCloseTimer = null
  }
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

onUnmounted(() => {
  if (volumeCloseTimer)
    clearTimeout(volumeCloseTimer)
})

const volumePercent = computed(() => Math.round(Math.min(1, Math.max(0, props.volume)) * 100))
/** 图标按「实际无声」走：静音或音量归零 */
const mutedIcon = computed(() => props.muted || props.volume <= 0)
const sliderPercent = computed(() => (mutedIcon.value ? 0 : volumePercent.value))

// 提示槽：键盘 ↑/↓ 的提示由宿主经 hint 传入，拖动滑块在本组件内合成，两者共用
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

function timeText(): string {
  const current = formatMediaTime(props.currentTime)
  return props.compact ? current : `${current} / ${formatMediaTime(props.duration)}`
}

function onRangeInput(event: Event) {
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  if (Number.isNaN(value))
    return
  emit('seek', value)
}
</script>

<template>
  <!-- 全自绘控制条：直播与录播共用。直播经 #leading 插槽放状态段，录播用内置进度段 -->
  <div class="mini-controls player-capsule" :class="{ 'mini-controls--progress': showProgress }">
    <slot name="leading" />

    <button class="player-capsule__btn" :aria-label="playing ? '暂停' : '播放'" @click="emit('togglePlay')">
      <MediaIcon :name="playing ? 'pause' : 'play'" />
    </button>

    <template v-if="showProgress">
      <input
        type="range"
        class="mini-range"
        :min="0"
        :max="duration || 0"
        :value="currentTime"
        :style="{ '--fill': duration > 0 ? `${Math.min((currentTime / duration) * 100, 100)}%` : '0%' }"
        :aria-label="`播放进度 ${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`"
        @input="onRangeInput"
      >
      <span class="mini-time" :title="timeText()">{{ timeText() }}</span>
    </template>

    <!-- 音量：点喇叭切静音，悬停浮出滑块 -->
    <div
      class="mini-volume"
      @pointerenter="openVolume"
      @pointerleave="scheduleCloseVolume"
    >
      <button
        class="player-capsule__btn"
        :class="{ 'is-open': volumeOpen }"
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

      <!-- 音量提示：浮层打开时抬高到面板之上 -->
      <Transition name="mini-hint">
        <span v-if="hintText" class="mini-hint" :class="{ 'is-above-panel': volumeOpen }">{{ hintText }}</span>
      </Transition>
    </div>

    <button
      class="player-capsule__btn"
      :aria-label="isFullscreen ? '退出全屏' : '全屏'"
      @click="emit('toggleFullscreen')"
    >
      <MediaIcon :name="isFullscreen ? 'minimize' : 'fullscreen'" />
    </button>
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
}

/* 有进度段（录播/回放）：随容器拉伸，520px 封顶；直播与窄容器仍走 shrink-to-fit */
.mini-controls--progress {
  width: min(calc(100% - 2 * var(--mini-gutter)), 520px);
}

/* 迷你进度条：优先吸收富余空间，空间不足时先收缩 */
.mini-range {
  flex: 1 1000 140px;
  min-width: 0;
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

/* 音量提示：浮层正上方居中，不参与 flex、不撑宽胶囊 */
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

  /* 浮层展开时抬到面板顶之上 */
  &.is-above-panel {
    bottom: calc(100% + #{fp(102px, 126px)});
  }
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
  font-size: var(--fp-font-sm);
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
