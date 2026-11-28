<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'

defineProps<{ angle: number }>()

const emit = defineEmits<{
  rotateLeft: []
  rotateRight: []
  reset: []
}>()
</script>

<template>
  <!-- 旋转是一个状态而非三个动作：合并成一组，中段直接显示当前角度，点击归零 -->
  <div class="action-group player-capsule">
    <button
      class="rotate-btn player-capsule__btn"
      title="逆时针旋转 90°（Shift + R）"
      aria-label="逆时针旋转 90 度"
      @click="emit('rotateLeft')"
    >
      <MediaIcon name="rotateLeft" />
    </button>
    <!-- 0 度时重置无意义，但不设 disabled：项目约定开关态用样式表达，
         真 disabled 会让按钮退出焦点序列。点击无副作用，aria 照实说明。 -->
    <button
      class="rotate-btn rotate-angle player-capsule__btn"
      :class="{ 'is-zero': angle === 0 }"
      :title="angle === 0 ? '当前未旋转' : `重置为 0°（当前 ${angle}° · 快捷键 0）`"
      :aria-disabled="angle === 0"
      :aria-label="angle === 0 ? '当前未旋转' : `当前旋转 ${angle} 度，点击重置`"
      @click="emit('reset')"
    >
      {{ angle }}°
    </button>
    <button
      class="rotate-btn player-capsule__btn"
      title="顺时针旋转 90°（R）"
      aria-label="顺时针旋转 90 度"
      @click="emit('rotateRight')"
    >
      <MediaIcon name="rotateRight" />
    </button>
  </div>
</template>

<style scoped lang="scss">
/* 旋转三件套合并成一个胶囊，读起来是「一个控件」而不是三个孤立功能；
 * 深色玻璃胶囊骨架见全局 .player-capsule */
.action-group {
  overflow: hidden;
}

/* 透明圆钮（hover 白纱 / 按下缩放）见全局 .player-capsule__btn。
 * 旋转组排在右上角动作钮旁边，故与 .action-btn 同径（不是底部胶囊的 --fp-capsule-btn） */
.rotate-btn {
  width: var(--fp-btn);
  height: var(--fp-btn);
  border-radius: 0;
  font-size: var(--fp-icon);

  & + .rotate-btn {
    border-left: 1px solid rgba(255, 255, 255, 0.14);
  }
}

/* 当前角度是文字不是图标：字号回到浮层正文档，宽度留给「90°」三个字符 */
.rotate-angle {
  min-width: calc(var(--fp-btn) + 4px);
  font-size: var(--fp-font);
  font-weight: 500;

  &.is-zero {
    color: rgba(255, 255, 255, 0.35);
    cursor: default;

    &:hover {
      background: transparent;
    }

    &:active {
      transform: none;
    }
  }
}
</style>
