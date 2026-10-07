<script setup lang="ts">
import type { StatItem } from '@renderer/utils/member-stats'
import { computed } from 'vue'

/**
 * 数据看板的横向条形图：各张分布图共用一张皮。
 * 只负责「标签 + 条 + 计数 + 占比」的排布，排序与归一化由调用方（member-stats）决定。
 */
const props = defineProps<{
  title: string
  items: StatItem[]
  /** 强调色（CSS 颜色值）；缺省走品牌紫 */
  accent?: string
  /** 计数单位（缺省「人」） */
  unit?: string
  /**
   * 卡内多栏。传数字固定列数（如年份两列），传 'auto' 按 300px 列宽自适应列数
   * （给「条目数天生就多」的图：期数 84 条、队伍 31 支、出生地 36 条）。
   *
   * 多栏走 **CSS 多列（multicol）** 而不是 grid 的第二套轨道，因为它天然是**列优先** ——
   * 先填满第一列再进第二列。grid 的 auto-flow 是行优先，多栏时阅读顺序会变成
   * 「先第一行再第二行」，15 个年份会被读成横着走的 2012 2013 / 2014 2015。
   */
  columns?: number | 'auto'
}>()

/** 条长按「最大项」取满格，而不是按总量 —— 分布图看的是彼此高下，总量占比只会让所有条都很短 */
const peak = computed(() => props.items.reduce((max, item) => Math.max(max, item.count), 0))
const total = computed(() => props.items.reduce((sum, item) => sum + item.count, 0))

const multi = computed(() => props.columns !== undefined)
/** 'auto' 下标签长短参差（「SNH48 二十二期生」vs「IDFT」），必须定宽才能让各栏条形起点对齐 */
const fixedLabel = computed(() => props.columns === 'auto')

/**
 * 多栏参数直接落成 CSS 多列：'auto' 给 column-width（列数按容器宽度自适应），
 * 数字给 column-count（固定列数）。
 */
const listStyle = computed(() => {
  if (props.columns === 'auto')
    return { columnWidth: '300px' }
  if (typeof props.columns === 'number')
    return { columnCount: String(props.columns) }
  return undefined
})

/** 最短也留 4%，否则个位数的项会缩成一条看不见的细线；0 人就是 0，不能画成细线 */
function widthOf(count: number): string {
  if (!peak.value || count <= 0)
    return '0%'
  return `${Math.max((count / peak.value) * 100, 4)}%`
}

function percentOf(count: number): string {
  return total.value ? `${Math.round((count / total.value) * 100)}%` : '0%'
}
</script>

<template>
  <section
    class="stat-bars"
    :style="accent ? { '--bar-accent': accent } : undefined"
  >
    <h3 class="stat-bars__title">
      {{ title }}
      <span v-if="total" class="stat-bars__total">合计 {{ total }}{{ unit || '人' }}</span>
    </h3>

    <p v-if="!items.length" class="stat-bars__empty">
      暂无数据
    </p>

    <ul
      v-else
      class="stat-bars__list"
      :class="{ 'stat-bars__list--multi': multi, 'stat-bars__list--fixed': fixedLabel }"
      :style="listStyle"
    >
      <li
        v-for="(item, index) in items"
        :key="item.label"
        class="stat-bars__row"
        :style="{ '--i': Math.min(index, 12) }"
      >
        <span class="stat-bars__label ellipsis" :title="item.label">{{ item.label }}</span>
        <span class="stat-bars__track">
          <span class="stat-bars__fill" :style="{ width: widthOf(item.count) }" />
        </span>
        <span class="stat-bars__count">{{ item.count }}</span>
        <span class="stat-bars__pct">{{ percentOf(item.count) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.stat-bars {
  --bar-accent: var(--brand-primary);

  padding: 14px 16px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-lg);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
}

.stat-bars__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  /* 标题前的小色块：与条形同色，一眼看出这张图归哪个主题 */
  &::before {
    content: '';
    flex: none;
    align-self: center;
    width: 3px;
    height: 13px;
    border-radius: var(--radius-pill);
    background: var(--bar-accent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--bar-accent) 45%, transparent);
  }
}

.stat-bars__total {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.stat-bars__empty {
  margin: 0;
  padding: 8px 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* 单栏：grid + row-gap 管行距（multicol 没有 row-gap，多栏形态才改用 margin）。
 *
 * ⚠️ **不要给这个列表加 `max-height` + `overflow-y`**：它一旦成为 scroll container，
 * 鼠标停在这张卡上滚轮就被它吞掉 —— 卡片明明没有可滚内容，页面却滚不动
 * （用户报过：「光标在有些数据卡片上，即使卡片没有滚动，也无法滚动页面」）。
 * 长列表要压高度就用 `columns` 多栏，别退回卡内滚动。 */
.stat-bars__list {
  display: grid;
  gap: 7px 18px;
  grid-template-columns: minmax(0, 1fr);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* ===== 卡内多栏（列优先） =====
 * 高度由内容自然决定，不设 max-height、不设 overflow —— 列表保持普通流，
 * 滚轮事件照常穿透到页面滚动容器。
 * 列数 / 列宽由行内 style 给（column-count / column-width）。 */
.stat-bars__list--multi {
  display: block;
  column-gap: 18px;
  /* 抵消最后一行的 margin-bottom，免得卡内底部凭空多出一截空白 */
  margin-bottom: -7px;
}

.stat-bars__list--multi .stat-bars__row {
  /* 一条数据就是一行，被拆到两列中间会读成两条 */
  break-inside: avoid;
  margin-bottom: 7px;
}

/* 宽版（columns="auto"）标签列定宽：multicol 的每一列是独立上下文，各列按自己的
 * max-content 走会让条形起点一栏一个样，跨栏比较就失去了基准。104px 容得下「SNH48 二十二期生」。
 * 固定列数（如四位年份）不套这条 —— 那种标签天然等长，max-content 也能对齐，放开更舒展。 */
.stat-bars__list--fixed .stat-bars__row {
  grid-template-columns: minmax(0, 104px) minmax(40px, 1fr) 30px 36px;
}

/* 标签 / 条 / 计数 / 占比四列：标签列按内容自适应（minmax(0, max-content)），
 * 既不会把「SNH48 一期生」这类长名字截掉，空间不够时又能回缩让位给条形 */
.stat-bars__row {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(40px, 1fr) 30px 36px;
  gap: 8px;
  align-items: center;
}

.stat-bars__label {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.stat-bars__track {
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--el-fill-color);
  overflow: hidden;
}

.stat-bars__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--bar-accent) 55%, transparent), var(--bar-accent));
  transform-origin: left center;
  /* 错峰生长：--i 由行内注入，封顶 12 免得长列表等太久 */
  animation: bar-grow 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(var(--i, 0) * 26ms);
}

@keyframes bar-grow {
  from {
    transform: scaleX(0);
  }

  to {
    transform: scaleX(1);
  }
}

.stat-bars__count {
  font-size: 12px;
  font-weight: 700;
  text-align: right;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.stat-bars__pct {
  font-size: 11px;
  text-align: right;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .stat-bars__fill {
    animation: none;
  }
}
</style>
