<script setup lang="ts">
import { computed, ref, watch } from 'vue'

/**
 * 成员头像：首次失败先切占位，延迟后用新地址重试一次；仍失败直接兜底。
 * 请求固定 no-referrer：官网 WAF 会按 Referer 拦截 file:// 来源。
 */
const props = defineProps<{
  src: string
  alt?: string
  /** 原生 loading 透传，列表建议 lazy */
  loading?: 'lazy' | 'eager'
  /** 首次失败后多久重试，默认 1.5s */
  retryDelay?: number
}>()

const failed = ref(false)
/** 已重试次数：最多 1 次 */
const retryCount = ref(0)
let retryTimer: ReturnType<typeof setTimeout> | null = null

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

// 换地址时复位
watch(() => props.src, () => {
  clearRetryTimer()
  failed.value = false
  retryCount.value = 0
})

const requestSrc = computed(() => {
  if (!props.src || !retryCount.value)
    return props.src
  const separator = props.src.includes('?') ? '&' : '?'
  return `${props.src}${separator}_retry=${retryCount.value}`
})

function onError() {
  if (retryCount.value >= 1) {
    failed.value = true
    return
  }
  retryCount.value += 1
  failed.value = true
  clearRetryTimer()
  retryTimer = setTimeout(() => {
    retryTimer = null
    failed.value = false
  }, props.retryDelay ?? 1500)
}

function onLoad() {
  failed.value = false
}

defineExpose({ failed, retryCount })
</script>

<template>
  <img
    v-if="!failed"
    class="member-avatar"
    :src="requestSrc"
    :alt="alt"
    :loading="loading"
    referrerpolicy="no-referrer"
    decoding="async"
    @error="onError"
    @load="onLoad"
  >
  <slot v-else />
</template>

<style scoped>
/*
 * 原生 img 不会自己裁切：官网头像是 300×400 竖图，塞进方形容器会被拉扁。
 * 与原先 el-image 的 fit="cover" 等价；各页面只负责尺寸与圆角。
 */
.member-avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}
</style>
