<script setup lang="ts">
import Tools from '@renderer/utils/tools'
import { computed, ref, watch } from 'vue'

/**
 * 封面图统一兜底组件：img 加载失败时切换到占位插槽。
 *
 * 失败态为组件内部状态：src 或 version 变化时自动复位，
 * 无需调用方手动清理。占位内容由调用方通过默认插槽提供（文字 / 图标均可），
 * 未提供插槽时不渲染占位（仅留空，布局尺寸由外部 class 决定）。
 *
 * 只有本图失败过，version 才会拼进 URL（见 Tools.retryImageUrl），成功的一直用原地址。
 */
const props = defineProps<{
  src: string
  alt?: string
  /** 原生 loading 属性透传：列表长图建议 lazy（视口外不请求） */
  loading?: 'lazy' | 'eager'
  /** 刷新版本号：变化时复位失败态，失败过的封面据此换地址重试 */
  version?: number | string
}>()

const failed = ref(false)

// 只有失败过的图才拼 version，未失败的原样用 src（见 Tools.retryImageUrl）
const requestSrc = computed(() => Tools.retryImageUrl(props.src, failed.value ? Number(props.version) || 0 : 0))

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
