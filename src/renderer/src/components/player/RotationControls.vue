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
    <el-tooltip content="逆时针旋转 90°（Shift + R）" placement="bottom" :show-after="400">
      <button class="rotate-btn player-capsule__btn" aria-label="逆时针旋转 90 度" @click="emit('rotateLeft')">
        <MediaIcon name="rotateLeft" :size="16" />
      </button>
    </el-tooltip>
    <el-tooltip
      :content="angle === 0 ? '当前未旋转' : `重置为 0°（当前 ${angle}°）`"
      placement="bottom"
      :show-after="400"
    >
      <button
        class="rotate-btn rotate-angle player-capsule__btn"
        :class="{ 'is-zero': angle === 0 }"
        :aria-disabled="angle === 0"
        :aria-label="`当前旋转 ${angle} 度，点击重置`"
        @click="emit('reset')"
      >
        {{ angle }}°
      </button>
    </el-tooltip>
    <el-tooltip content="顺时针旋转 90°（R）" placement="bottom" :show-after="400">
      <button class="rotate-btn player-capsule__btn" aria-label="顺时针旋转 90 度" @click="emit('rotateRight')">
        <MediaIcon name="rotateRight" :size="16" />
      </button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
/* 旋转三件套合并成一个胶囊，读起来是「一个控件」而不是三个孤立功能；
 * 深色玻璃胶囊骨架见全局 .player-capsule */
.action-group {
  overflow: hidden;
}

/* 透明圆钮（hover 白纱 / 按下缩放）见全局 .player-capsule__btn */
.rotate-btn {
  width: 32px;
  height: 32px;
  border-radius: 0;
  font-size: 12px;

  & + .rotate-btn {
    border-left: 1px solid rgba(255, 255, 255, 0.14);
  }
}

/* 当前角度：0° 置灰并禁用，明确「现在没有可重置的东西」 */
.rotate-angle {
  min-width: 36px;
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
