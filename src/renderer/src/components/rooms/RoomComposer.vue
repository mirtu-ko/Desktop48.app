<script setup lang="ts">
import type { InputInstance } from 'element-plus'
import { Close, Lock } from '@element-plus/icons-vue'
import { ref } from 'vue'

/**
 * 房间输入条：回复摘要 + 输入框 + 发送按钮。
 *
 * 只负责「长什么样」与把交互抛出去：草稿、连接状态、冷却、禁言判断、发送编排
 * 全部留在页面（use-pocket-rooms）。这里唯一的本地状态是输入框实例，供页面调用 focus()。
 */
defineProps<{
  /** 引用摘要；null 表示不在回复态 */
  replyTarget: { senderName: string, text: string } | null
  /** 发送中（按钮 loading） */
  sendBusy: boolean
  draft: string
  /** 阻断态：输入框转为警告色，说明为什么发不出去 */
  blocked: boolean
  muted: boolean
  placeholder: string
  /** 允许编辑（连接未就绪时为 false） */
  canSend: boolean
  /** 能否发送（草稿为空 / 冷却 / 未连接时为 false） */
  usable: boolean
  sendHint: string
  sendLabel: string
}>()

const emit = defineEmits<{
  'update:draft': [value: string]
  'cancelReply': []
  'composerClick': []
  'draftEnter': [event: KeyboardEvent]
  'send': []
}>()

const draftInput = ref<InputInstance | null>(null)

/** 供页面点「回复」后把焦点交回输入框 */
function focus(): void {
  draftInput.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="chat-composer">
    <div v-if="replyTarget" class="composer-reply">
      <span class="composer-reply-name">回复 {{ replyTarget.senderName }}</span>
      <span class="composer-reply-text">{{ replyTarget.text || '消息' }}</span>
      <button
        type="button"
        class="composer-reply-close"
        title="取消回复"
        aria-label="取消回复"
        @click="emit('cancelReply')"
      >
        <el-icon :size="12">
          <Close />
        </el-icon>
      </button>
    </div>
    <div class="composer-row">
      <el-input
        ref="draftInput"
        :model-value="draft" class="composer-input"
        :class="{ 'is-blocked': blocked }"
        :placeholder="placeholder"
        :readonly="!canSend"
        maxlength="500"
        clearable
        @update:model-value="emit('update:draft', $event)"
        @click="emit('composerClick')"
        @keyup.enter="emit('draftEnter', $event)"
      >
        <!-- 禁言状态合并进输入框：即使草稿仍占着 placeholder，左侧标记也能持续说明原因 -->
        <template #prefix>
          <span v-if="muted" class="composer-muted-mark">
            <el-icon :size="12">
              <Lock />
            </el-icon>
            全员禁言
          </span>
        </template>
      </el-input>
      <el-button
        class="composer-send"
        type="primary"
        round
        :loading="sendBusy"
        :disabled="!usable"
        :title="sendHint"
        @click="emit('send')"
      >
        {{ sendLabel }}
      </el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../assets/css/fluid' as *;

/* 发言输入条：房间就绪后常驻消息区底部（与 .main-foot 互斥出现：后者只在加载/错误态）。
 * 禁用态不置灰整条——占位文案即连接状态（正在连接 / 重连中 / 未连接原因），
 * 用户要能看到「为什么发不了」，而不是面对一个灰掉的输入框猜原因 */
.chat-composer {
  flex: none;
  padding: fluid(8px, 10px) var(--chat-pad-x) calc(fluid(8px, 10px) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--el-border-color-lighter);
}

/* 回复态摘要：被回复者昵称 + 内容一行省略，取消钮靠右 */
.composer-reply {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  background: var(--el-fill-color-lighter);
}

.composer-reply-name {
  flex: none;
  font-weight: 600;
  /* 房间语义色（与页签 / 图标同一支），不用品牌紫 */
  color: var(--color-rooms);
}

.composer-reply-text {
  overflow: hidden;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--el-text-color-secondary);
}

.composer-reply-close {
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-left: auto;
  padding: 2px;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;

  &:hover {
    color: var(--el-text-color-primary);
    background: var(--el-fill-color);
  }
}

/* 阻断态与输入框合并：锁定标记常驻在输入框内，警告色只落在这一处 */
.composer-input.is-blocked :deep(.el-input__wrapper) {
  background: var(--el-color-warning-light-9);
  box-shadow: 0 0 0 1px var(--el-color-warning-light-5) inset;
}

.composer-input.is-blocked :deep(.el-input__inner),
.composer-input.is-blocked :deep(.el-input__inner::placeholder) {
  color: var(--el-color-warning-dark-2);
}

.composer-muted-mark {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-right: 6px;
  padding-right: 8px;
  border-right: 1px solid var(--el-color-warning-light-5);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--el-color-warning-dark-2);
}

.composer-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 发送钮定宽：文案在「发送 / 发送中 / 冷却倒数」之间切换，宽度跳变会抖 */
.composer-send {
  flex: none;
  min-width: 64px;
}
</style>
