<script setup lang="ts">
// 房间语音条：播放/暂停 + 进度条 + 时长，样式同微信语音条。同时只允许一条在播。
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ src: string }>()

const playing = ref(false)
const current = ref(0)
const duration = ref(0)
/** 加载失败：回退占位文案 */
const failed = ref(false)

/** 正在播放的那条实例的暂停器：开始播放新条目前先停掉旧的 */
let activePause: (() => void) | null = null

const audio = new Audio()
audio.preload = 'metadata'

function onTimeupdate() {
  current.value = audio.currentTime
}

function onLoadedmetadata() {
  if (Number.isFinite(audio.duration))
    duration.value = audio.duration
}

function onEnded() {
  playing.value = false
  current.value = 0
  audio.currentTime = 0
}

function onError() {
  failed.value = true
  playing.value = false
}

audio.addEventListener('timeupdate', onTimeupdate)
audio.addEventListener('loadedmetadata', onLoadedmetadata)
audio.addEventListener('ended', onEnded)
audio.addEventListener('error', onError)

watch(() => props.src, () => {
  audio.src = props.src
  playing.value = false
  current.value = 0
  duration.value = 0
  failed.value = false
}, { immediate: true })

function toggle() {
  if (playing.value) {
    audio.pause()
    playing.value = false
    return
  }
  if (failed.value || !audio.src)
    return
  activePause?.()
  activePause = pause
  void audio.play().then(() => {
    playing.value = true
  }).catch(() => {
    failed.value = true
  })
}

function pause() {
  audio.pause()
  playing.value = false
}

/** 秒 → m:ss；元数据未就绪时显示 --:-- */
function timeText(value: number) {
  if (!value || !Number.isFinite(value))
    return '--:--'
  const total = Math.round(value)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 进度条点击跳播 */
function seek(event: MouseEvent) {
  if (!duration.value)
    return
  const rect = event.currentTarget as HTMLElement
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.getBoundingClientRect().left) / rect.offsetWidth))
  audio.currentTime = ratio * duration.value
  current.value = audio.currentTime
}

onUnmounted(() => {
  if (activePause === pause)
    activePause = null
  audio.pause()
  audio.removeEventListener('timeupdate', onTimeupdate)
  audio.removeEventListener('loadedmetadata', onLoadedmetadata)
  audio.removeEventListener('ended', onEnded)
  audio.removeEventListener('error', onError)
})
</script>

<template>
  <div v-if="!failed" class="voice-bar" :class="{ 'is-playing': playing }" @click="toggle">
    <span class="voice-bar__btn">
      <MediaIcon :name="playing ? 'pauseFilled' : 'playFilled'" :size="13" />
    </span>
    <span class="voice-bar__track" @click.stop="seek($event)">
      <span class="voice-bar__fill" :style="{ width: duration ? `${(current / duration) * 100}%` : '0%' }" />
    </span>
    <span class="voice-bar__time">{{ timeText(playing || current ? current : duration) }}</span>
  </div>
  <span v-else class="voice-bar__failed">[语音加载失败]</span>
</template>

<style scoped lang="scss">
.voice-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 168px;
  padding: 5px 10px;
  /* 与消息列同档圆角：在房间消息流内由 .msg-scroll 注入；独立使用时回退 10px */
  border-radius: var(--msg-radius, 10px);
  cursor: pointer;
  user-select: none;
  background: color-mix(in srgb, var(--color-rooms) 10%, transparent);
  transition: background 0.15s ease;

  &:hover {
    background: color-mix(in srgb, var(--color-rooms) 16%, transparent);
  }
}

.voice-bar__btn {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: #fff;
  background: var(--color-rooms);
}

.voice-bar__track {
  position: relative;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  cursor: pointer;
  background: color-mix(in srgb, var(--color-rooms) 18%, transparent);
}

.voice-bar__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
  background: var(--color-rooms);
}

.voice-bar__time {
  flex: none;
  min-width: 30px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.voice-bar__failed {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
