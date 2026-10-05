<script setup lang="ts">
import { Download } from '@element-plus/icons-vue'
import useTasksStore from '@renderer/stores/tasks'
import { computed } from 'vue'

/** 右下角常驻下载入口：任务中心卡片的唯一入口，角标显示运行中的任务数 */
const emit = defineEmits<{ open: [] }>()

const { downloadTasks, recordTasks } = useTasksStore()

const runningCount = computed(
  () =>
    downloadTasks.value.filter(task => task.status === 'running').length
    + recordTasks.value.filter(task => task.status === 'running').length,
)
</script>

<template>
  <button
    type="button"
    class="downloads-entry"
    title="任务中心"
    @click="emit('open')"
  >
    <el-icon><Download /></el-icon>
    <span
      v-if="runningCount"
      class="entry-badge"
    >{{ runningCount > 99 ? '99+' : runningCount }}</span>
  </button>
</template>

<style scoped lang="scss">
.downloads-entry {
  position: fixed;
  right: 18px;
  bottom: 26px;
  z-index: 96;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-downloads) 82%, #000), var(--color-downloads));
  box-shadow:
    0 6px 16px -6px color-mix(in srgb, var(--color-downloads) 70%, transparent),
    var(--shadow-sm);
  cursor: pointer;
  animation: entry-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;

  .el-icon {
    font-size: 21px;
  }

  &:hover {
    transform: translateY(-2px) scale(1.06);
    box-shadow:
      0 10px 24px -8px color-mix(in srgb, var(--color-downloads) 80%, transparent),
      var(--shadow-md);
  }

  &:active {
    transform: scale(0.96);
  }
}

/* 运行中任务角标：白环把它从绿色按钮上剥离出来 */
.entry-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 2px solid #fff;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: var(--el-color-danger);
}

@keyframes entry-pop {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.8);
  }
}

@media (prefers-reduced-motion: reduce) {
  .downloads-entry {
    animation: none;
    transition: none;
  }
}
</style>
