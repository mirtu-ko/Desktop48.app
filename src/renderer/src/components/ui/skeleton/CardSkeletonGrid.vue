<script setup lang="ts">
import { computed } from 'vue'
import BaseSkeleton from './BaseSkeleton.vue'

/**
 * 通用卡片网格骨架：模拟「媒体区 + 文案行」的卡片结构。
 * 网格参数与真实列表接近时，加载完成后的布局位移最小。
 */
const props = withDefaults(defineProps<{
  count?: number
  /** 单卡最小宽度，传给 CSS grid 的 minmax */
  minItemWidth?: string
  gap?: string
  /** 媒体区宽高比；直播/回放 1，公演 16 / 9，成员 3 / 4 */
  aspectRatio?: string
  /** 文案行宽度（百分比），空数组可只显示媒体区 */
  lineWidths?: number[]
  /** 网格上方渲染分区标题占位（公演页使用） */
  heading?: boolean
}>(), {
  count: 12,
  minItemWidth: '220px',
  gap: '16px',
  aspectRatio: '1',
  lineWidths: () => [82, 56, 38],
  heading: false,
})

const gridStyle = computed(() => ({
  '--card-skeleton-min-width': props.minItemWidth,
  '--card-skeleton-gap': props.gap,
}))
</script>

<template>
  <div
    class="card-skeleton-grid"
    :style="gridStyle"
    aria-busy="true"
  >
    <BaseSkeleton
      v-if="heading"
      class="section-heading"
      height="22px"
      width="168px"
      radius="10px"
    />

    <div class="skeleton-items">
      <div
        v-for="index in count"
        :key="index"
        class="skeleton-card"
      >
        <BaseSkeleton
          class="skeleton-media"
          :aspect-ratio="aspectRatio"
          radius="0"
        />
        <div class="skeleton-body">
          <BaseSkeleton
            v-for="(lineWidth, lineIndex) in lineWidths"
            :key="lineIndex"
            class="skeleton-line"
            :style="{ width: `${lineWidth}%`, marginTop: lineIndex === 0 ? 0 : '8px' }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.card-skeleton-grid {
  display: flex;
  flex-direction: column;
}

.section-heading {
  flex: none;
  margin-bottom: 14px;
}

.skeleton-items {
  display: grid;
  gap: var(--card-skeleton-gap);
  grid-template-columns: repeat(auto-fill, minmax(var(--card-skeleton-min-width), 1fr));
}

.skeleton-card {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
}

.skeleton-body {
  padding: 10px 12px 12px;
}

.skeleton-line {
  display: block;
  height: 12px;
}
</style>
