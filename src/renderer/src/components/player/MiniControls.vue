<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { formatMediaTime } from '@renderer/utils/time-format'

const props = defineProps({
  playing: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  isFullscreen: { type: Boolean, default: false },
  /** 录播必须可 seek，直播隐藏进度条 */
  showProgress: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  /** 系统画中画：仅视频轨适用，电台（纯音频）由宿主传 false 隐藏 */
  showPip: { type: Boolean, default: false },
  isPip: { type: Boolean, default: false },
  /** 迷你浮窗：时间串只显示当前进度，总时长让位给进度条 */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['togglePlay', 'toggleMute', 'toggleFullscreen', 'togglePip', 'seek'])

// PiP 能力探测（Chromium/Electron 常开，防御性判断环境）
const pipSupported = (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true

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
  <!-- 全自绘控制条：直播与录播共用同一条胶囊。
       直播在 #leading 插槽放状态段（LIVE 徽标/时长），录播用内置进度段；
       加载期间整条随宿主 v-if 隐藏，连接中不显示 LIVE 状态。 -->
  <div class="mini-controls player-capsule" :class="{ 'mini-controls--progress': showProgress }">
    <slot name="leading" />

    <button class="mini-btn player-capsule__btn" :aria-label="playing ? '暂停' : '播放'" @click="emit('togglePlay')">
      <MediaIcon :name="playing ? 'pause' : 'play'" :size="16" />
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
      <span class="mini-time">{{ timeText() }}</span>
    </template>

    <button class="mini-btn player-capsule__btn" :aria-label="muted ? '取消静音' : '静音'" @click="emit('toggleMute')">
      <MediaIcon :name="muted ? 'volumeOff' : 'volumeOn'" :size="16" />
    </button>
    <button
      v-if="showPip && pipSupported"
      class="mini-btn player-capsule__btn"
      :aria-label="isPip ? '退出画中画' : '画中画'"
      :title="isPip ? '退出画中画' : '画中画'"
      @click="emit('togglePip')"
    >
      <MediaIcon name="pip" :size="16" />
    </button>
    <button
      class="mini-btn player-capsule__btn"
      :aria-label="isFullscreen ? '退出全屏' : '全屏'"
      @click="emit('toggleFullscreen')"
    >
      <MediaIcon :name="isFullscreen ? 'minimize' : 'fullscreen'" :size="16" />
    </button>
  </div>
</template>

<style scoped lang="scss">
/* 全自绘控制条：不参与旋转，恒定贴在容器底部；窄容器（迷你浮窗）下限宽自适应。
 * 深色玻璃胶囊骨架见全局 .player-capsule */
.mini-controls {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 24px);
  min-width: 0;
  gap: 0px;
  padding: 3px 8px;
  z-index: 20;
}

/* 有进度段（录播/回放）：容器足够宽时胶囊随容器拉伸，520px 封顶，富余空间由进度条吸收；
 * 直播（无进度段）与窄容器仍走 shrink-to-fit + max-width 兜底 */
.mini-controls--progress {
  width: min(calc(100% - 24px), 520px);
}

/* 按钮永不收缩：拥挤时让位给进度条 / 时间 / leading 插槽内容。
 * 透明圆钮（hover 白纱 / 按下缩放）见全局 .player-capsule__btn */
.mini-btn {
  width: 28px;
  height: 28px;
}

/* 迷你进度条：录播必须可 seek。grow 因子 1：容器富余空间全部归进度条（时间串被推到右端）；
 * shrink 因子 1000：按 basis×factor 加权，空间不足时进度条先收缩（可压到 0），
 * 时间串的份额小到亚像素（100 时仍漏 1px 出省略号），进度条让尽后时间串才截断。*/
.mini-range {
  flex: 1 1000 140px;
  min-width: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;

  &::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 3px;
    /* --fill 由模板按 currentTime/duration 注入：填充段品牌渐变，底段半透明白 */
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
    width: 12px;
    height: 12px;
    margin-top: -3px;
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

/* 时间串优先级高于进度条：只在进度条让尽后才截断 */
.mini-time {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: visible;
  text-overflow: ellipsis;
}
</style>
