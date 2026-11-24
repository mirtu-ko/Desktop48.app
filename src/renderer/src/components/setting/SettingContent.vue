<script setup lang="ts">
import type { MemberFlag } from '@preload/ipc-contract'
import { Hide } from '@element-plus/icons-vue'
import Tools from '@renderer/utils/tools'
import { ElMessageBox } from 'element-plus'

/**
 * 内容与可见性组：屏蔽成员名单。
 *
 * 名单是 stores/member-flags 的模块级共享状态（成员页也会改它），
 * 这里只做展示，并给出「清空」「去成员页操作」「解除单个屏蔽」三个出口。
 */
const props = defineProps<{ blockedMembers: MemberFlag[] }>()
const emit = defineEmits<{
  unblock: [userId: number]
  goMembers: []
  clearAll: []
}>()

/** 清空名单前二次确认 */
async function onClear(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定清空全部 ${props.blockedMembers.length} 个屏蔽成员？`, '清空屏蔽名单', {
      type: 'warning',
      customClass: 'app-confirm',
      modalClass: 'detail-card-overlay',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  }
  catch {
    return // 用户取消
  }
  emit('clearAll')
}
</script>

<template>
  <h2 class="setting-group-label" data-setting-group="content">
    内容与可见性
  </h2>
  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-members)' }"
      >
        <el-icon><Hide /></el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          屏蔽成员
        </div>
        <div class="row-desc">
          已屏蔽 {{ blockedMembers.length }} 名成员，其直播、回放与房间消息将不再展示
        </div>
      </div>
      <div class="row-actions">
        <el-button
          type="danger"
          plain
          :disabled="!blockedMembers.length"
          @click="onClear"
        >
          清空
        </el-button>
        <el-button
          type="primary"
          @click="emit('goMembers')"
        >
          屏蔽成员
        </el-button>
      </div>
    </div>
    <div class="row-body">
      <div v-if="blockedMembers.length" class="tag-list">
        <el-tag
          v-for="member in blockedMembers"
          :key="member.userId"
          closable
          :color="Tools.toHex(member.teamColor)"
          effect="dark"
          @close="emit('unblock', member.userId)"
        >
          {{ member.realName }}
        </el-tag>
      </div>
      <div v-else class="empty-hint">
        尚未屏蔽任何成员，点击「屏蔽成员」前往成员页操作
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  :deep(.el-tag) {
    color: #fff !important;
    border-color: rgba(255, 255, 255, 0.45) !important;

    .el-tag__close {
      color: #fff;

      &:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.3);
      }
    }
  }
}

/* 屏蔽名单空态：样式见全局 .empty-hint */

/* 权利声明：小字号次要色，低调呈现；两类声明做成响应式双栏卡片 */
</style>
