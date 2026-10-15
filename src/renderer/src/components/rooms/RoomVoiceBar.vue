<script setup lang="ts">
// 房间语音条：播放/暂停 + 进度条 + 时长，样式同微信语音条。同时只允许一条在播（占位见 utils/voice-solo.ts）。
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { claimVoiceSlot, releaseVoiceSlot } from '@renderer/utils/voice-solo'
import { onDeactivated, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ src: string }>()

const playing = ref(false)
const current = ref(0)
const duration = ref(0)
/** 加载失败：回退占位文案 */
const failed = ref(false)

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
  pause()
  current.value = 0
  audio.currentTime = 0
}

function onError() {
  pause()
  failed.value = true
}

audio.addEventListener('timeupdate', onTimeupdate)
audio.addEventListener('loadedmetadata', onLoadedmetadata)
audio.addEventListener('ended', onEnded)
audio.addEventListener('error', onError)

watch(() => props.src, () => {
  // 换源时 Chromium 会从新资源开头继续播，必须先停手（pause 自带让位）
  pause()
  audio.src = props.src
  current.value = 0
  duration.value = 0
  failed.value = false
}, { immediate: true })

function toggle() {
  if (playing.value) {
    pause()
    return
  }
  if (failed.value || !audio.src)
    return
  claimVoiceSlot(pause)
  void audio.play().then(() => {
    playing.value = true
  }).catch((error: unknown) => {
    // play() 被拒时没人替我们停手，坑位要自己交还
    releaseVoiceSlot(pause)
    // 被后点的语音条抢走播放权时 Chromium 抛 AbortError，属正常让位，不是加载失败
    if (error instanceof DOMException && error.name === 'AbortError')
      return
    failed.value = true
  })
}

/** 唯一的「停 + 让位」出口：谁停谁交还坑位，调用方不必再记得 release */
function pause() {
  releaseVoiceSlot(pause)
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

/**
 * KeepAlive 页面切走：缓存页不卸载，onUnmounted 不触发，语音会在后台继续播。
 * 激活钩子会递归到后代实例，所以挂在语音条自己身上即可，不必让 Rooms 页来通知。
 * 只停不续 —— 回来时不自动恢复（进度还停在断点，自动续播像卡住）。
 */
onDeactivated(pause)

onUnmounted(() => {
  pause()
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
