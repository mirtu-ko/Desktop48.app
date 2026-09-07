<script setup lang="ts">
/**
 * 播放器统一加载态：双环 spinner + 主文案 + 可选提示与封面图淡显背景。
 * 直播（LivePlayer）与回放（PlaybackPlayer）共用，覆盖在视频容器上。
 */
withDefaults(defineProps<{
  /** 主文案，如「正在加载直播」 */
  label?: string
  /** 次级提示文案 */
  hint?: string
  /** 封面图 URL：以 0.1 透明度铺底 */
  background?: string
  /** 深色不透明蒙层：电台轮播等亮背景场景使用 */
  masked?: boolean
}>(), {
  label: '加载中',
  hint: '',
  background: '',
  masked: false,
})
</script>

<template>
  <div class="player-loading" :class="{ 'is-masked': masked }">
    <div v-if="background" class="loading-bg" :style="{ backgroundImage: `url(${background})` }" />
    <div class="loading-spinner" aria-hidden="true">
      <div class="ring ring--outer" />
      <div class="ring ring--inner" />
    </div>
    <div class="loading-text">
      <span class="loading-text__label">{{ label }}</span>
      <span class="loading-text__dots"><span>.</span><span>.</span><span>.</span></span>
    </div>
    <div v-if="hint" class="loading-hint">
      {{ hint }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.player-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  z-index: 10;
  color: #fff;
  text-align: center;
  pointer-events: none;
  overflow: hidden;
}

/* 亮背景（电台轮播）下叠加深色蒙层，保证动画可读 */
.player-loading.is-masked {
  background: rgba(0, 0, 0, 0.9);
}

/* 封面图淡显铺底，不遮挡居中内容 */
.loading-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  opacity: 0.1;
  z-index: 0;
}

.loading-spinner,
.loading-text,
.loading-hint {
  position: relative;
  z-index: 1;
}

.loading-spinner {
  position: relative;
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-spinner .ring {
  position: absolute;
  border-radius: 50%;
}

.ring--outer {
  inset: 0;
  border: 3px solid rgba(255, 255, 255, 0.14);
  border-top-color: var(--brand-primary);
  box-shadow: 0 0 18px color-mix(in srgb, var(--brand-primary) 35%, transparent);
  /* 旋转动画见全局 @keyframes spin */
  animation: spin 1.1s linear infinite;
}

.ring--inner {
  inset: 11px;
  border: 3px solid rgba(255, 255, 255, 0.12);
  border-bottom-color: var(--brand-primary-light);
  animation: spin 0.8s linear infinite reverse;
}

.loading-text {
  display: flex;
  align-items: baseline;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.94);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
}

.loading-text__dots {
  display: inline-flex;
  margin-left: 2px;
  overflow: hidden;
}

.loading-text__dots span {
  animation: player-loading-dot-bounce 1.2s ease-in-out infinite;
  color: var(--brand-primary-light);
  font-weight: 700;
}

.loading-text__dots span:nth-child(2) {
  animation-delay: 0.18s;
}

.loading-text__dots span:nth-child(3) {
  animation-delay: 0.36s;
}

.loading-hint {
  font-size: 12px;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.55);
}

@keyframes player-loading-dot-bounce {
  0%,
  100% {
    opacity: 0.2;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-3px);
  }
}
</style>
