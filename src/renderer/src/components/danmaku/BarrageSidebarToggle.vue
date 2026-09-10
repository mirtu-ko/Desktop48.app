<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'

defineProps<{
  /** 弹幕侧栏当前是否展开，决定竖条上的文案与提示 */
  visible: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<template>
  <!-- 视频窗口右边缘：hover 时才浮出的弹幕列表显隐竖条（B站式边缘吸附） -->
  <div class="sidebar-toggle">
    <div
      class="sidebar-toggle-tab"
      :title="visible ? '隐藏弹幕列表' : '显示弹幕列表'"
      @click="emit('toggle')"
    >
      <MediaIcon name="chat" :size="16" />
      <span class="toggle-label">{{ visible ? '收起' : '弹幕' }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 右缘触发区：平时不可见，hover 到右缘才滑出 */
.sidebar-toggle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 72px;
  box-sizing: border-box;
  padding-top: 96px;
  padding-bottom: 96px;
  z-index: 30;
}

/* 边缘吸附竖条：贴在右缘，仅左侧圆角，hover 时从边缘滑出 */
.sidebar-toggle-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 26px;
  height: 76px;
  box-sizing: border-box;
  padding: 8px 2px;
  border-radius: 10px 0 0 10px;
  background: color-mix(in srgb, var(--brand-primary) 75%, transparent);
  color: #fff;
  font-size: 11px;
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
  backdrop-filter: blur(6px);
  border-left: 1px solid rgba(255, 255, 255, 0.32);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.35);
  opacity: 0;
  transform: translateX(12px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    background 0.2s ease;
}

.sidebar-toggle:hover .sidebar-toggle-tab {
  opacity: 1;
  transform: translateX(0);
}

/* hover 提亮一档，给出明确的可点击反馈 */
.sidebar-toggle-tab:hover {
  background: color-mix(in srgb, var(--brand-primary) 92%, #fff);
}

.toggle-label {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
  font-weight: 500;
}
</style>
