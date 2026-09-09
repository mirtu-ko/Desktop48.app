<script setup lang="ts">
/**
 * 骨架基础块：统一波光动画与占位底色。
 * 页面只决定块的形状与尺寸，加载动效在这里收敛。
 */
withDefaults(defineProps<{
  /** 固定高度，如 16px；媒体位建议用 aspectRatio */
  height?: string
  /** 固定宽度，如 72%；不传时占满父级 */
  width?: string
  /** 媒体占位比例，如 1 或 16 / 9 */
  aspectRatio?: string
  /** 圆角大小，默认与全局 radius-sm 一致 */
  radius?: string
}>(), {
  height: undefined,
  width: undefined,
  aspectRatio: undefined,
  radius: 'var(--radius-sm)',
})
</script>

<template>
  <div
    class="base-skeleton"
    :style="{ height, width, aspectRatio, borderRadius: radius }"
    aria-hidden="true"
  />
</template>

<style scoped lang="scss">
.base-skeleton {
  width: 100%;
  background-color: var(--el-fill-color);
  background-image: linear-gradient(
    100deg,
    transparent 24%,
    color-mix(in srgb, var(--el-bg-color) 68%, transparent) 44%,
    transparent 64%
  );
  background-size: 220% 100%;
  animation: base-skeleton-wave 1.35s ease-in-out infinite;
}

@keyframes base-skeleton-wave {
  0% {
    background-position: 120% 0;
  }

  100% {
    background-position: -20% 0;
  }
}
</style>
