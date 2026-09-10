<script setup lang="ts">
import CoverImage from '@renderer/components/ui/CoverImage.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import useAudioPlayerStore from '@renderer/stores/audio-player'
import Tools from '@renderer/utils/tools'
import { computed, ref } from 'vue'

const {
  playlist,
  currentIndex,
  currentTrack,
  playing,
  currentTime,
  duration,
  playAt,
  togglePlay,
  next,
  prev,
  seek,
  removeAt,
  clearAll,
  isCurrent,
  isBroken,
} = useAudioPlayerStore()

/** 队列面板展开态 */
const panelVisible = ref(false)

const progress = computed(() => (duration.value ? currentTime.value / duration.value : 0))

const coverStyle = computed(() => ({
  '--cover': currentTrack.value?.cover ? `url(${currentTrack.value.cover})` : 'none',
}))

/** 点击进度条跳转 */
function onSeek(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  seek(((event.clientX - rect.left) / rect.width) * (duration.value || 0))
}

/** 清空队列并收起面板 */
function onClearAll() {
  clearAll()
  panelVisible.value = false
}
</script>

<template>
  <!-- 播放列表为空时整体隐藏（清空队列必已停止播放） -->
  <div v-if="playlist.length" class="float-audio">
    <!-- 队列面板：向上展开 -->
    <transition name="panel-pop">
      <div v-if="panelVisible" class="audio-panel frosted-surface">
        <div class="panel-head">
          <span class="panel-title">播放列表</span>
          <span class="panel-count">{{ playlist.length }} 首</span>
          <button class="panel-clear" title="清空列表" @click="onClearAll">
            <MediaIcon name="trash" :size="15" />
          </button>
        </div>
        <el-scrollbar max-height="300px" class="panel-scroll">
          <div
            v-for="(track, index) in playlist"
            :key="track.key"
            class="panel-row"
            :class="{ 'is-current': isCurrent(track.key), 'is-broken': isBroken(track.url) }"
            @click="playAt(index)"
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
              <div class="row-name ellipsis">
                {{ track.name }}
              </div>
              <div class="row-album ellipsis">
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

    <!-- 迷你播放条：小旋转黑胶 + 进度 + 控制键 -->
    <div class="audio-bar frosted-surface">
      <div class="bar-progress" @click="onSeek">
        <div class="bar-progress-fill" :style="{ width: `${progress * 100}%` }" />
      </div>

      <span class="bar-vinyl" :class="{ 'is-playing': playing }" :style="coverStyle" />

      <div class="bar-info">
        <div class="bar-name ellipsis">
          {{ currentTrack?.name || '播放列表' }}
        </div>
        <div class="bar-sub ellipsis">
          {{ currentTrack ? `${currentTrack.singer} · ${currentTrack.albumTitle}` : `${playlist.length} 首待播` }}
        </div>
      </div>

      <span class="bar-time">{{ Tools.formatDuration(currentTime) }} / {{ Tools.formatDuration(duration) }}</span>

      <div class="bar-controls">
        <button class="ctrl-btn" title="上一首" :disabled="currentIndex <= 0" @click="prev">
          <MediaIcon name="prevFilled" :size="15" />
        </button>
        <button class="ctrl-btn ctrl-main" :title="playing ? '暂停' : '播放'" @click="togglePlay">
          <MediaIcon :name="playing ? 'pauseFilled' : 'playFilled'" :size="16" />
        </button>
        <button
          class="ctrl-btn"
          title="下一首"
          :disabled="currentIndex >= playlist.length - 1"
          @click="next"
        >
          <MediaIcon name="nextFilled" :size="15" />
        </button>
      </div>

      <button
        class="ctrl-btn ctrl-list"
        :class="{ 'is-active': panelVisible }"
        title="播放列表"
        @click="panelVisible = !panelVisible"
      >
        <MediaIcon name="playlistFilled" :size="15" />
      </button>
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
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  width: 340px;
  border-radius: var(--radius-lg);
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

  .panel-clear {
    display: inline-flex;
    padding: 4px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--el-text-color-secondary);
    cursor: pointer;
    transition:
      background-color 0.2s ease,
      color 0.2s ease;

    &:hover {
      background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
      color: var(--el-color-danger);
    }
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

/* ===== 迷你播放条 ===== */
.audio-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 340px;
  padding: 8px 10px 8px 12px;
  border-radius: var(--radius-pill);
}

/* 顶部细进度条：点击跳转。
 * 线浮在胶囊顶边（y≈0），该高度圆弧肩部内缩约 20px，
 * 左右端收到 22px 起止，避免越过上下圆弧 */
.bar-progress {
  position: absolute;
  top: -3px;
  left: 22px;
  right: 22px;
  height: 6px;
  border-radius: var(--radius-pill);
  cursor: pointer;

  /* 可点击热区，视觉上只显示 3px */
  &::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 2px;
    height: 2px;
    border-radius: inherit;
    background: color-mix(in srgb, var(--el-border-color) 60%, transparent);
    transition:
      top 0.15s ease,
      height 0.15s ease;
  }

  &:hover::before {
    top: 1px;
    height: 4px;
  }
}

.bar-progress-fill {
  position: relative;
  height: 2px;
  margin-top: 2px;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--brand-primary), var(--brand-primary-light));
  box-shadow: 0 0 6px -1px var(--shadow-glow);
  transition: height 0.15s ease;
  pointer-events: none;

  .bar-progress:hover & {
    height: 4px;
    margin-top: 1px;
  }
}

/* 小黑胶：纹理由类样式绘制，封面经 --cover 注入盘标层 */
.bar-vinyl {
  position: relative;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: repeating-radial-gradient(circle at 50% 50%, #191920 0 1.5px, #23232c 1.5px 2.5px);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px rgba(255, 255, 255, 0.08);

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

  &.is-playing::after {
    animation-play-state: running;
  }
}

.bar-info {
  flex: 1;
  min-width: 0;
}

.bar-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.bar-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.bar-time {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.bar-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ctrl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
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
    width: 34px;
    height: 34px;
    margin: 0 2px;
    background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light));
    color: #fff;
    box-shadow: var(--shadow-glow);

    &:hover {
      color: #fff;
      background: linear-gradient(135deg, var(--brand-primary-dark), var(--brand-primary));
    }
  }

  &.is-active {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
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
