<script setup lang="ts">
import { computed, ref, watch } from 'vue'

/**
 * 封面图统一兜底组件（B-1）：img 加载失败时切换到占位插槽，替代各调用方
 * 自维护「失败 Set + isBroken/markBroken」的三套写法。
 *
 * 失败态为组件内部状态：src 或 version 变化时自动复位，
 * 无需调用方手动清理。占位内容由调用方通过默认插槽提供（文字 / 图标均可），
 * 未提供插槽时不渲染占位（仅留空，布局尺寸由外部 class 决定）。
 */
const props = defineProps<{
  src: string
  alt?: string
  /** 原生 loading 属性透传：列表长图建议 lazy（视口外不请求） */
  loading?: 'lazy' | 'eager'
  /** 刷新版本号：变化时会重置失败态，并给 URL 追加 cache-busting 参数 */
  version?: number | string
}>()

const failed = ref(false)

// 同一 URL 的 <img> 加载失败后不会自动重试；version 变化时生成新 URL 并复位失败态
const requestSrc = computed(() => {
  if (!props.src || !props.version)
    return props.src
  const separator = props.src.includes('?') ? '&' : '?'
  return `${props.src}${separator}_r=${encodeURIComponent(String(props.version))}`
})

// 换源或刷新版本变化时重置失败态
watch(() => [props.src, props.version], () => {
  failed.value = false
})

function onError() {
  failed.value = true
}
</script>

<template>
  <img
    v-if="!failed"
    class="cover-image"
    :src="requestSrc"
    :alt="alt"
    :loading="loading"
    @error="onError"
  >
  <slot v-else />
</template>

<style scoped>
.cover-image {
  display: block;
}
</style>
