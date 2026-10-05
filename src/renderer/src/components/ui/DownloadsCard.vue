<script setup lang="ts">
import type { TaskKind } from '@renderer/stores/tasks'
import { Check, Close, Download, Loading, VideoCamera } from '@element-plus/icons-vue'
import useTasksStore from '@renderer/stores/tasks'
import { computed, ref } from 'vue'

/** 下载中心卡片：左栏任务类型切换，右栏对应任务列表。任务状态由 useTasksStore 单例持有，卡片关闭后任务照常运行 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { downloadTasks, recordTasks, removeTask, stopTaskByLiveId, openSaveDirectory } = useTasksStore()

/** 分区配置：图标与主题色引用 app.scss 的 --color-* 变量 */
const groups = computed(() => [
  { kind: 'record' as TaskKind, title: '直播录制', icon: VideoCamera, color: 'var(--color-lives)', emptyText: '暂无录制任务', tasks: recordTasks.value },
  { kind: 'download' as TaskKind, title: '回放下载', icon: Download, color: 'var(--color-downloads)', emptyText: '暂无下载任务', tasks: downloadTasks.value },
])

const activeKind = ref<TaskKind>('download')
const activeGroup = computed(() => groups.value.find(group => group.kind === activeKind.value) ?? groups.value[0])

const runningCount = computed(() => groups.value.reduce((sum, group) => sum + group.tasks.filter(task => task.status === 'running').length, 0))
const finishedCount = computed(() => groups.value.reduce((sum, group) => sum + group.tasks.filter(task => task.status !== 'running').length, 0))

function onVisibilityChange(value: boolean) {
  if (!value)
    emit('close')
}
</script>

<template>
  <el-dialog
    class="detail-card-dialog"
    modal-class="detail-card-overlay"
    :model-value="open"
    :show-close="false"
    align-center
    append-to-body
    @update:model-value="onVisibilityChange"
  >
    <div
      v-if="open"
      class="detail-card downloads-card"
      :style="{ '--accent': activeGroup.color }"
    >
      <!-- 左栏：任务类型切换（骨架的布局见全局 .detail-side*） -->
      <div class="detail-side">
        <div class="side-bg" />
        <div class="detail-side-body detail-scroll">
          <div class="detail-side-inner">
            <span class="hero-icon icon-tile" :style="{ '--tile-color': activeGroup.color }">
              <el-icon><component :is="activeGroup.icon" /></el-icon>
            </span>

            <h3 class="detail-side-title">
              任务中心
            </h3>

            <div class="detail-side-count">
              进行中 {{ runningCount }} · 已完成 {{ finishedCount }}
            </div>

            <div class="kind-list">
              <button
                v-for="group in groups"
                :key="group.kind"
                type="button"
                class="kind-item"
                :class="{ 'is-active': group.kind === activeKind }"
                :style="{ '--kind-color': group.color }"
                @click="activeKind = group.kind"
              >
                <span class="kind-icon"><el-icon><component :is="group.icon" /></el-icon></span>
                <span class="kind-name">{{ group.title }}</span>
                <span class="kind-count">{{ group.tasks.length }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏：任务列表 -->
      <div class="detail-pane">
        <div class="detail-pane-head">
          <span class="detail-pane-title">{{ activeGroup.title }}</span>
          <span class="detail-pane-sub">{{ activeGroup.tasks.length }} 个任务</span>
        </div>

        <div :key="activeKind" class="task-list detail-scroll">
          <div v-if="!activeGroup.tasks.length" class="empty-card">
            <el-icon class="empty-icon">
              <component :is="activeGroup.icon" />
            </el-icon>
            <p>{{ activeGroup.emptyText }}</p>
          </div>

          <template v-else>
            <article
              v-for="(task, index) in activeGroup.tasks"
              :key="task.liveId"
              class="task-card detail-pane-row"
              :style="{ '--i': index }"
            >
              <span
                class="task-icon"
                :class="{ 'is-running': task.status === 'running' }"
              >
                <el-icon><component :is="activeGroup.icon" /></el-icon>
              </span>

              <div class="task-meta">
                <div
                  class="task-name ellipsis"
                  :title="task.filename"
                >
                  {{ task.filename }}
                </div>
                <div
                  v-if="task.elapsed"
                  class="task-elapsed"
                >
                  {{ activeGroup.kind === 'record' ? '已录制' : '已下载' }} {{ task.elapsed }}
                </div>
                <div
                  v-if="task.filePath"
                  class="task-path ellipsis"
                  :title="task.filePath"
                >
                  {{ task.filePath }}
                </div>
              </div>

              <el-tag
                v-if="task.status === 'running'"
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
                  v-if="task.status === 'running'"
                  type="danger"
                  size="small"
                  round
                  @click="stopTaskByLiveId(activeGroup.kind, task.liveId)"
                >
                  结束
                </el-button>
                <template v-else>
                  <el-button
                    type="primary"
                    size="small"
                    round
                    @click="openSaveDirectory(task)"
                  >
                    打开文件夹
                  </el-button>
                  <el-button
                    size="small"
                    round
                    @click="removeTask(task, activeGroup.kind)"
                  >
                    移除
                  </el-button>
                </template>
              </div>
            </article>
          </template>
        </div>
      </div>

      <button class="detail-close" title="关闭" @click="emit('close')">
        <el-icon :size="15">
          <Close />
        </el-icon>
      </button>
    </div>
  </el-dialog>
</template>

<!-- 外壳 / 卡面 / 关闭钮 / 滚动列 / 左右栏骨架与入场错峰见全局 app.scss 的「详情卡片共用」，
     这里只留本卡独有的样式与骨架变量 -->
<style scoped lang="scss">
.downloads-card {
  /* 亮色主题色（如录制玫红）直接当文字色对比度不够，混深后再用于文字 */
  --accent-ink: color-mix(in srgb, var(--accent) 62%, #24223a);
  /* 骨架变量：栏宽比专辑卡窄；左栏内容不足时居中、超出时退回顶端（不会像裸 center 那样裁掉顶部），
   * 间距略大；右栏标题头左侧缩进比专辑卡少 2px */
  --side-basis: clamp(200px, 26%, 260px);
  --side-gap: 14px;
  --side-justify: safe center;
  --side-pad: 26px 18px 22px;
  --pane-head-pad: 20px;
}

/* ===== 左栏：任务类型切换 ===== */

/* 主题色氛围底：跟随当前任务类型换色 */
.side-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 70% at 0% 0%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 70%),
    linear-gradient(160deg, color-mix(in srgb, var(--accent) 8%, var(--el-bg-color)), var(--el-bg-color));
  pointer-events: none;
}

.hero-icon {
  width: 84px;
  height: 84px;
  border-radius: 24px;

  .el-icon {
    font-size: 38px;
  }
}

.kind-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
}

.kind-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--el-bg-color) 70%, transparent);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  font-family: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;

  &:hover {
    background: var(--el-bg-color);
  }

  &.is-active {
    color: color-mix(in srgb, var(--kind-color) 62%, #24223a);
    background: color-mix(in srgb, var(--kind-color) 12%, var(--el-bg-color));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kind-color) 42%, transparent);
  }

  .kind-icon {
    display: inline-flex;
    font-size: 16px;
    color: var(--kind-color);
  }

  .kind-name {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-weight: 600;
  }

  .kind-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 600;
    background: color-mix(in srgb, var(--kind-color) 14%, transparent);
    color: color-mix(in srgb, var(--kind-color) 62%, #24223a);
  }
}

/* ===== 右栏：任务列表（容器与标题头骨架见全局 .detail-pane*） ===== */
.task-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 16px;
}

/* 空态：虚线框 */
.empty-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 200px;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--radius-lg);
  color: var(--el-text-color-placeholder);

  .empty-icon {
    font-size: 30px;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

/* 任务卡片：主题色磁贴 + 文件名/路径 + 状态 + 操作 */
.task-card {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--el-fill-color-lighter);
  transition: background-color 0.2s ease;

  &:hover {
    background: var(--el-fill-color-light);
  }

  .task-icon {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent) 18%, #fff),
      color-mix(in srgb, var(--accent) 8%, #fff)
    );
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);

    .el-icon {
      font-size: 19px;
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
      background: var(--accent);
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

    .task-elapsed {
      margin-top: 3px;
      font-size: 12px;
      /* 状态信息而非辅助信息：跟随主题色，与下方灰色的路径行拉开层级 */
      color: var(--accent-ink);
      font-variant-numeric: tabular-nums;
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
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  }

  50% {
    box-shadow: 0 0 0 5px transparent;
  }
}

/* 入场：外壳静止，左栏元素与任务行错峰上浮，规则见全局 .detail-side-inner / .detail-pane-row */

/* 系统「减少动态效果」下关掉剩下的过渡（入场动画见全局 .detail-* 的对应媒体查询） */
@media (prefers-reduced-motion: reduce) {
  .kind-item,
  .task-card {
    transition: none;
  }
}
</style>
