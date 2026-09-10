<script setup lang="ts">
import type { TaskKind } from '@renderer/stores/tasks'
import { Check, Download, Loading, VideoCamera } from '@element-plus/icons-vue'
import useTasksStore from '@renderer/stores/tasks'
import Constants from '@renderer/utils/constants'
import { computed, onMounted } from 'vue'

// 任务状态由 useTasksStore 这个模块级单例持有：本页卸载后任务照常运行，
// 从悬浮迷你窗等任意入口发起的任务也不会因为本页未挂载而丢失
const { downloadTasks, recordTasks, removeTask, restoreTasks } = useTasksStore()

onMounted(() => {
  restoreTasks('download')
  restoreTasks('record')
})

// 分区展示配置：图标与主题色与底部 Dock 的语义保持一致（直播-玫红 / 下载-绿，取自 Constants.Theme）
const taskGroups = computed(() => [
  { kind: 'record' as TaskKind, title: '直播录制', icon: VideoCamera, color: Constants.Theme.LIVES, emptyText: '暂无录制任务', tasks: recordTasks.value },
  { kind: 'download' as TaskKind, title: '回放下载', icon: Download, color: Constants.Theme.DOWNLOADS, emptyText: '暂无下载任务', tasks: downloadTasks.value },
])
</script>

<template>
  <el-scrollbar
    class="scrollbar-wrapper"
    wrap-class="scrollbar-wrapper"
  >
    <div class="downloads-root">
      <section
        v-for="group in taskGroups"
        :key="group.kind"
        class="task-section"
        :style="{ '--group-color': group.color }"
      >
        <!-- 分区头：主题色图标 + 标题 + 任务数 -->
        <header class="section-head">
          <span class="section-icon icon-tile">
            <el-icon><component :is="group.icon" /></el-icon>
          </span>
          <span class="section-title">{{ group.title }}</span>
          <span class="section-count">{{ group.tasks.length }}</span>
        </header>

        <div
          v-if="group.tasks.length === 0"
          class="empty-card glass-card"
        >
          <el-icon class="empty-icon">
            <component :is="group.icon" />
          </el-icon>
          <p>{{ group.emptyText }}</p>
        </div>

        <!-- 任务卡片列表 -->
        <div
          v-else
          class="task-list"
        >
          <article
            v-for="task in group.tasks"
            :key="task.getLiveId()"
            class="task-card glass-card"
          >
            <span
              class="task-icon"
              :class="{ 'is-running': task.isRunning() }"
            >
              <el-icon><component :is="group.icon" /></el-icon>
            </span>

            <div class="task-meta">
              <div
                class="task-name ellipsis"
                :title="task.getFilename()"
              >
                {{ task.getFilename() }}
              </div>
              <div
                v-if="task.getFilePath()"
                class="task-path ellipsis"
                :title="task.getFilePath()"
              >
                {{ task.getFilePath() }}
              </div>
            </div>

            <el-tag
              v-if="task.isRunning()"
              type="primary"
              size="small"
              round
              class="task-tag"
            >
              <el-icon class="is-loading">
                <Loading />
              </el-icon>
              <span>运行中</span>
            </el-tag>
            <el-tag
              v-else
              type="success"
              size="small"
              round
              class="task-tag"
            >
              <el-icon><Check /></el-icon>
              <span>已完成</span>
            </el-tag>

            <div class="task-actions">
              <el-button
                v-if="task.isRunning()"
                type="danger"
                size="small"
                round
                @click="task.stop()"
              >
                结束
              </el-button>
              <template v-else>
                <el-button
                  type="primary"
                  size="small"
                  round
                  @click="task.openSaveDirectory()"
                >
                  打开文件夹
                </el-button>
                <el-button
                  size="small"
                  round
                  @click="removeTask(task, group.kind)"
                >
                  移除
                </el-button>
              </template>
            </div>
          </article>
        </div>
      </section>
    </div>
  </el-scrollbar>
</template>

<style scoped lang="scss">
.downloads-root {
  max-width: 880px;
  margin: 0 auto;
  /* 底部留出悬浮 Dock 的高度（--dock-reserve），避免最后一张卡片被遮挡 */
  padding: 20px 24px var(--dock-reserve);
}

.task-section + .task-section {
  margin-top: 26px;
}

/* 分区头 */
.section-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;

  .section-icon {
    /* 渐变磁贴骨架见全局 .icon-tile，--tile-color 跟随分组主题色 */
    --tile-color: var(--group-color);

    width: 28px;
    height: 28px;
    border-radius: 9px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--group-color) 75%, #fff), var(--group-color));

    .el-icon {
      font-size: 15px;
    }
  }

  .section-title {
    margin: 0;
    gap: 0;
    color: var(--el-text-color-primary);

    /* 已有主题色图标磁贴，隐藏全局 .section-title 的左侧竖条 */
    &::before {
      display: none;
    }
  }

  .section-count {
    min-width: 20px;
    height: 20px;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 600;
    background: color-mix(in srgb, var(--group-color) 12%, transparent);
    color: color-mix(in srgb, var(--group-color) 85%, #000);
  }
}

/* 空态：虚线玻璃卡 */
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 240px;
  border-style: dashed;
  opacity: 0.9;

  &:hover {
    transform: none;
    box-shadow: var(--shadow-sm);
  }

  .empty-icon {
    font-size: 30px;
    color: var(--el-text-color-placeholder);
  }

  p {
    margin: 0;
    font-size: 13px;
    color: var(--el-text-color-placeholder);
  }
}

/* 任务列表 */
.task-list {
  min-height: 240px;
}

/* 任务卡片：主题色磁贴 + 文件名/路径 + 状态 + 操作 */
.task-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 18px;
  border-radius: var(--radius-lg);

  & + .task-card {
    margin-top: 12px;
  }

  .task-icon {
    position: relative;
    flex-shrink: 0;
    width: 42px;
    height: 42px;
    border-radius: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--group-color) 18%, #fff),
      color-mix(in srgb, var(--group-color) 8%, #fff)
    );
    border: 1px solid color-mix(in srgb, var(--group-color) 20%, transparent);
    color: var(--group-color);

    .el-icon {
      font-size: 20px;
    }

    /* 运行中：磁贴右上角呼吸圆点 */
    &.is-running::after {
      content: '';
      position: absolute;
      top: -3px;
      right: -3px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--group-color);
      border: 2px solid var(--el-bg-color);
      animation: task-pulse 1.6s ease-in-out infinite;
    }
  }

  .task-meta {
    flex: 1;
    min-width: 0;

    .task-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--el-text-color-primary);
    }

    .task-path {
      margin-top: 3px;
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }
  }

  .task-tag {
    flex-shrink: 0;

    .el-icon {
      margin-right: 4px;
    }
  }

  .task-actions {
    flex-shrink: 0;
    display: flex;
  }
}

@keyframes task-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--group-color) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px transparent;
  }
}
</style>
