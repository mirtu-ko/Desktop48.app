<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import useMinVisibleLoading from '@renderer/composables/use-min-visible-loading'

/**
 * 右上角浮动操作条 + 圆形刷新按钮。
 * 直播/公演/专辑/成员/回放页同构的浮动工具条收敛于此；
 * 需要补充计数、筛选等控件时放进默认插槽（渲染在刷新按钮之前）。
 */
const props = withDefaults(defineProps<{
  /** 刷新进行中（转圈时长由下方的 displayLoading 兜底） */
  loading?: boolean
  /** 按钮 title */
  title?: string
  /**
   * 是否脱离文档流自行定位（默认 true = 右上角浮层）。
   * 置 false 时改为普通流内的胶囊，由外层工具行负责定位与两端对齐。
   */
  floating?: boolean
}>(), {
  loading: false,
  title: '刷新',
  floating: true,
})

const emit = defineEmits<{ refresh: [] }>()

/** 五个页面的指示时长统一在这里兜底（机制见 useMinVisibleLoading） */
const displayLoading = useMinVisibleLoading(() => props.loading)
</script>

<template>
  <div class="floating-dock frosted-surface no-scrollbar" :class="{ 'is-flow': !floating }">
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
@use '../../assets/css/fluid' as *;

.floating-dock {
  position: absolute;
  right: 8px;
  top: var(--float-top);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: fluid(8px, 12px);
  max-width: calc(100% - 40px);
  padding: fluid(3px, 4px);
  border-radius: var(--radius-pill);
  overflow-x: auto;

  /* 并排组成页首工具行时不再自行定位；宽度随内容，贴哪一侧交给外层工具行决定
   * （回放页把它与关注条一起推向右端，两者是同一件事的两个入口） */
  &.is-flow {
    position: static;
    flex: none;
    max-width: none;
  }
}

/* 圆钮 32 → 28 与同排 tab 栏（41 → 33）、关注条同步连续收，
 * 三者的「内距 + 内容」都是同一条曲线，工具行才不会在某个高度被最高项撑住 */
.floating-dock :deep(.el-button.is-circle) {
  width: fluid(28px, 32px);
  height: fluid(28px, 32px);
}
</style>
