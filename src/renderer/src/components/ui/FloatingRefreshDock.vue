<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import useMinVisibleLoading from '@renderer/composables/use-min-visible-loading'

/**
 * 右上角浮动操作条 + 圆形刷新按钮。
 * 直播/公演/专辑/成员/回放页同构的浮动工具条收敛于此；
 * 需要补充计数、筛选等控件时放进默认插槽（渲染在刷新按钮之前）。
 */
const props = withDefaults(defineProps<{
  /**
   * 刷新进行中。注意组件内部会套一层「最短可见时长」（见 useMinVisibleLoading）：
   * 接口几十毫秒就回来时，转圈会被拉长到可辨时长，否则用户看不出「刷过」。
   */
  loading?: boolean
  /** 按钮 title */
  title?: string
}>(), {
  loading: false,
  title: '刷新',
})

const emit = defineEmits<{ refresh: [] }>()

/**
 * 指示统一走「最短可见时长」：五个页面（直播/公演/专辑/成员/回放）的接口都很快，
 * 各自去补时长会重复五遍，放这里一处生效。只延长指示，数据仍是回包即用。
 */
const displayLoading = useMinVisibleLoading(() => props.loading)
</script>

<template>
  <div class="floating-dock frosted-surface no-scrollbar">
    <slot />
    <el-button
      circle
      type="primary"
      :icon="Refresh"
      :loading="displayLoading"
      :title="title"
      @click="emit('refresh')"
    />
  </div>
</template>

<style scoped lang="scss">
.floating-dock {
  position: absolute;
  right: 8px;
  top: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 40px);
  padding: 4px;
  border-radius: var(--radius-pill);
  overflow-x: auto;
}
</style>
