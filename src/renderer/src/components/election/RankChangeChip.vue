<script setup lang="ts">
import type { RankChange } from '@renderer/utils/election'
import { formatRankChange } from '@renderer/utils/election'
import { computed } from 'vue'

/**
 * 名次变动小药丸：▲上升（绿）/ ▼下降（红）/ — 持平（灰）/ NEW 首次入选（品牌紫）/ 回归（总选红）。
 * 名次卡、领奖台、履历弹窗共用。
 */
const props = defineProps<{
  change: RankChange
}>()

const label = computed(() => formatRankChange(props.change))

const title = computed(() => {
  const change = props.change
  switch (change.kind) {
    case 'up':
      return `较上届上升 ${change.delta} 名`
    case 'down':
      return `较上届下降 ${change.delta} 名`
    case 'same':
      return '与上届名次持平'
    case 'new':
      return '首次入选'
    case 'return':
      return '上届未入选，本届回归'
  }
  return ''
})
</script>

<template>
  <span class="rank-change" :class="`is-${change.kind}`" :title="title">{{ label }}</span>
</template>

<style scoped lang="scss">
.rank-change {
  --chip: var(--el-text-color-secondary);

  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.7;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: color-mix(in srgb, var(--chip) 72%, #000);
  background: color-mix(in srgb, var(--chip) 14%, transparent);

  &.is-up {
    --chip: var(--el-color-success);
  }

  &.is-down {
    --chip: var(--el-color-danger);
  }

  &.is-new {
    --chip: var(--brand-primary);
  }

  &.is-return {
    --chip: var(--color-elections);
  }
}
</style>
