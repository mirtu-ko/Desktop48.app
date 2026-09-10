<script setup lang="ts">
import type { DanmakuSettings } from '@renderer/composables/use-danmaku-settings'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'

defineProps<{
  settings: DanmakuSettings
}>()

const emit = defineEmits<{
  /** 用户调整了某项显示参数，由父应用生效并持久化 */
  update: [patch: Partial<DanmakuSettings>]
  /** 弹幕总开关需要额外清叠加层，交回父处理 */
  toggle: []
}>()
</script>

<template>
  <el-popover trigger="click" placement="bottom-end" :width="260">
    <template #reference>
      <el-button circle class="side-setting-btn" title="弹幕设置">
        <MediaIcon name="settings" :size="15" />
      </el-button>
    </template>
    <div class="danmaku-settings">
      <div class="setting-row">
        <span>显示弹幕</span>
        <el-switch :model-value="settings.enabled" @change="emit('toggle')" />
      </div>
      <div class="setting-row column">
        <span>不透明度</span>
        <el-slider
          :model-value="settings.opacity"
          :min="0.2"
          :max="1"
          :step="0.1"
          @input="v => emit('update', { opacity: Number(v) })"
          @change="v => emit('update', { opacity: Number(v) })"
        />
      </div>
      <div class="setting-row column">
        <span>字号</span>
        <el-slider
          :model-value="settings.fontSize"
          :min="14"
          :max="40"
          :step="2"
          @input="v => emit('update', { fontSize: Number(v) })"
          @change="v => emit('update', { fontSize: Number(v) })"
        />
      </div>
      <div class="setting-row column">
        <span>速度</span>
        <el-slider
          :model-value="settings.speed"
          :min="80"
          :max="400"
          :step="20"
          @input="v => emit('update', { speed: Number(v) })"
          @change="v => emit('update', { speed: Number(v) })"
        />
      </div>
      <div class="setting-row column">
        <span>显示区域</span>
        <el-radio-group :model-value="settings.area" size="small" @change="v => emit('update', { area: Number(v) })">
          <el-radio-button :value="0.25">
            顶部
          </el-radio-button>
          <el-radio-button :value="0.5">
            半屏
          </el-radio-button>
          <el-radio-button :value="1">
            全屏
          </el-radio-button>
        </el-radio-group>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
/* 弹幕列表面板搜索框右侧的设置按钮：小而圆，与右栏配色一致 */
.side-setting-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-left: 0 !important;
  color: var(--el-text-color-secondary);
}

.danmaku-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.setting-row.column {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}
</style>
