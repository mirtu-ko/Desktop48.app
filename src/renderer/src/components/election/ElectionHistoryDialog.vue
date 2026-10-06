<script setup lang="ts">
import type { ElectionMember } from '@renderer/data/elections'
import type { ElectionHistoryEntry } from '@renderer/utils/election'
import RankChangeChip from '@renderer/components/election/RankChangeChip.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { ELECTIONS } from '@renderer/data/elections'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import {
  avatarUrl,
  formatVotes,
  groupColor,
  medalColor,
  memberHistory,
  sectionTitleOf,
} from '@renderer/utils/election'
import { computed, ref, watch } from 'vue'

/**
 * 成员总选履历弹窗：点名次卡 / 领奖台头像打开。
 * 上半是历届名次走势（SVG 折线，名次越高越靠上，未入选的届次断线），
 * 下半是入选过的届次明细（名次、分组、票数、较上届变动、新人榜），点某一行跳到那一届。
 * 外壳 / 卡面 / 关闭钮 / 滚动列复用 app.scss 的「详情卡片共用」。
 */
const props = defineProps<{
  /** 当前查看的成员；null 时关闭 */
  member: ElectionMember | null
  /** 页面当前所在届的年份：走势图里高亮这一届 */
  currentYear: number
}>()

const emit = defineEmits<{
  close: []
  /** 点明细行：跳到那一届 */
  selectYear: [year: number]
}>()

const history = computed<ElectionHistoryEntry[]>(() =>
  props.member ? memberHistory(props.member.userId, ELECTIONS) : [])

/** 入选过总选或新人榜的届次，倒序（最新在上） */
const rankedEntries = computed(() =>
  history.value.filter(entry => entry.rank || entry.newcomerRank).reverse())

const mainEntries = computed(() => history.value.filter(entry => entry.rank))

/** 最近一次出现时的团体：成员可能转团，取最新口径 */
const latestGroup = computed(() =>
  rankedEntries.value.find(entry => entry.group)?.group ?? props.member?.group ?? '')

const themeStyle = computed(() => {
  const color = groupColor(latestGroup.value)
  return color ? { '--gc': color } : undefined
})

/** 概览：入选届数、最高名次（并列取最早一届）、最高票数 */
const stats = computed(() => {
  const entries = mainEntries.value
  let best: ElectionHistoryEntry | undefined
  let topVotes: ElectionHistoryEntry | undefined
  for (const entry of entries) {
    if (!best || entry.rank! < best.rank!)
      best = entry
    if (entry.votes && (!topVotes || entry.votes > topVotes.votes!))
      topVotes = entry
  }
  const newcomerCount = history.value.filter(entry => entry.newcomerRank).length
  return { count: entries.length, best, topVotes, newcomerCount }
})

/* ===== 头像：有 sid 拼官网地址，没有则回落成员名录（与名次卡同一套口径） ===== */
const { findMemberByUserId } = useMemberDirectoryStore()
const directoryAvatar = ref('')
let avatarRequestId = 0
watch(
  () => props.member,
  async (member) => {
    const requestId = ++avatarRequestId
    directoryAvatar.value = ''
    if (!member || member.sid || !member.userId)
      return
    try {
      const info = await findMemberByUserId(member.userId)
      if (requestId === avatarRequestId)
        directoryAvatar.value = info?.avatar ?? ''
    }
    catch (error) {
      console.error('[ElectionHistoryDialog]按 userId 获取成员头像失败:', error)
    }
  },
  { immediate: true },
)
const avatarSrc = computed(() => avatarUrl(props.member?.sid) || directoryAvatar.value)

/* ===== 走势图几何：viewBox 坐标，宽度随容器缩放 ===== */
const CHART = { width: 560, height: 210, left: 40, right: 18, top: 24, bottom: 30 }
/** 纵轴刻度取分组边界：名次落在哪个分组，纵轴就拉到哪 */
const RANK_BOUNDARIES = [16, 32, 48, 66]

const yMax = computed(() => {
  const worst = Math.max(1, ...mainEntries.value.map(entry => entry.rank!))
  return RANK_BOUNDARIES.find(boundary => worst <= boundary) ?? worst
})

function xOf(index: number): number {
  const count = history.value.length
  const span = CHART.width - CHART.left - CHART.right
  return count <= 1 ? CHART.left + span / 2 : CHART.left + (index * span) / (count - 1)
}

function yOf(rank: number): number {
  const span = CHART.height - CHART.top - CHART.bottom
  return CHART.top + ((rank - 1) / (yMax.value - 1)) * span
}

const gridLines = computed(() =>
  [1, ...RANK_BOUNDARIES.filter(boundary => boundary <= yMax.value)].map(rank => ({ rank, y: yOf(rank) })))

interface ChartPoint {
  key: number
  x: number
  y: number
  rank: number
  year: number
  current: boolean
  medal?: string
}

const points = computed<ChartPoint[]>(() =>
  history.value.flatMap((entry, index) => entry.rank
    ? [{
        key: entry.year,
        x: xOf(index),
        y: yOf(entry.rank),
        rank: entry.rank,
        year: entry.year,
        current: entry.year === props.currentYear,
        medal: medalColor(entry.rank),
      }]
    : []))

/** 折线按连续入选切段：中间有一届落选就断开 */
const segments = computed(() => {
  const result: string[] = []
  let run: string[] = []
  history.value.forEach((entry, index) => {
    if (entry.rank) {
      run.push(`${xOf(index).toFixed(1)},${yOf(entry.rank).toFixed(1)}`)
      return
    }
    if (run.length > 1)
      result.push(run.join(' '))
    run = []
  })
  if (run.length > 1)
    result.push(run.join(' '))
  return result
})

const yearTicks = computed(() =>
  history.value.map((entry, index) => ({
    year: entry.year,
    x: xOf(index),
    ranked: !!entry.rank,
    current: entry.year === props.currentYear,
  })))

const currentX = computed(() => yearTicks.value.find(tick => tick.current)?.x)

function onVisibilityChange(visible: boolean) {
  if (!visible)
    emit('close')
}
</script>

<template>
  <el-dialog
    class="detail-card-dialog election-history-dialog"
    modal-class="detail-card-overlay"
    :model-value="!!member"
    :show-close="false"
    align-center
    append-to-body
    @update:model-value="onVisibilityChange"
  >
    <div v-if="member" :key="member.userId" class="detail-card history-card" :style="themeStyle">
      <button
        type="button"
        class="detail-close"
        aria-label="关闭"
        @click="emit('close')"
      >
        <MediaIcon name="close" :size="14" />
      </button>

      <!-- 头部：头像 + 姓名 / 团体 + 概览 -->
      <header class="history-head">
        <el-image class="history-avatar" :src="avatarSrc" fit="cover">
          <template #error>
            <span class="avatar-fallback">{{ member.name.slice(0, 1) }}</span>
          </template>
        </el-image>
        <div class="history-id">
          <p class="history-name ellipsis" :title="member.name">
            {{ member.name }}
            <span v-if="latestGroup" class="history-group">{{ latestGroup }}</span>
          </p>
          <ul class="history-stats">
            <li>
              <b>{{ stats.count }}</b> 届入选
            </li>
            <li v-if="stats.best">
              最高 <b>第 {{ stats.best.rank }} 名</b>
              <small>{{ stats.best.year }}</small>
            </li>
            <li v-if="stats.topVotes">
              最高 <b>{{ formatVotes(stats.topVotes.votes!) }}</b> 票
              <small>{{ stats.topVotes.year }}</small>
            </li>
            <li v-if="stats.newcomerCount">
              新人榜 <b>{{ stats.newcomerCount }}</b> 次
            </li>
          </ul>
        </div>
      </header>

      <div class="history-body detail-scroll" tabindex="0">
        <!-- 历届名次走势 -->
        <section v-if="mainEntries.length" class="history-chart">
          <h3 class="history-subtitle">
            名次走势
          </h3>
          <svg
            :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
            class="chart-svg"
            role="img"
            :aria-label="`${member.name} 历届总选名次走势`"
          >
            <!-- 当前届的竖向高亮带 -->
            <rect
              v-if="currentX !== undefined"
              class="chart-current"
              :x="currentX - 14"
              :y="CHART.top - 16"
              width="28"
              :height="CHART.height - CHART.top - CHART.bottom + 30"
              rx="8"
            />

            <g class="chart-grid">
              <template v-for="line in gridLines" :key="line.rank">
                <line :x1="CHART.left" :x2="CHART.width - CHART.right" :y1="line.y" :y2="line.y" />
                <text :x="CHART.left - 8" :y="line.y" text-anchor="end" dominant-baseline="middle">
                  {{ line.rank }}
                </text>
              </template>
            </g>

            <g class="chart-years">
              <text
                v-for="tick in yearTicks"
                :key="tick.year"
                :x="tick.x"
                :y="CHART.height - 8"
                text-anchor="middle"
                :class="{ 'is-absent': !tick.ranked, 'is-current': tick.current }"
              >
                {{ tick.year }}
              </text>
            </g>

            <polyline v-for="(segment, i) in segments" :key="i" class="chart-line" :points="segment" />

            <g v-for="point in points" :key="point.key" class="chart-point" :class="{ 'is-current': point.current }">
              <circle
                :cx="point.x"
                :cy="point.y"
                :r="point.current ? 6 : 4.5"
                :style="point.medal ? { fill: point.medal } : undefined"
              />
              <text :x="point.x" :y="point.y - 10" text-anchor="middle">
                {{ point.rank }}
              </text>
              <title>{{ point.year }} 年 · 第 {{ point.rank }} 名</title>
            </g>
          </svg>
        </section>

        <!-- 入选明细：点击跳到该届 -->
        <section class="history-list">
          <h3 class="history-subtitle">
            历届成绩
          </h3>
          <button
            v-for="entry in rankedEntries"
            :key="entry.year"
            type="button"
            class="history-row"
            :class="{ 'is-current': entry.year === currentYear }"
            :title="`查看 ${entry.year} 年度总选`"
            @click="emit('selectYear', entry.year)"
          >
            <span class="row-year">
              <b>{{ entry.year }}</b>
              <small>第 {{ entry.ordinal }} 届 · {{ entry.theme }}</small>
            </span>
            <span class="row-result">
              <template v-if="entry.rank">
                <span class="row-rank" :style="medalColor(entry.rank) ? { '--medal': medalColor(entry.rank) } : undefined">
                  第 {{ entry.rank }} 名
                </span>
                <span class="row-section">{{ sectionTitleOf(entry.rank) }}</span>
                <RankChangeChip v-if="entry.change" :change="entry.change" />
              </template>
              <span v-else class="row-absent">未入选总选</span>
              <span v-if="entry.newcomerRank" class="row-newcomer">新人榜 #{{ entry.newcomerRank }}</span>
            </span>
            <span class="row-votes">
              {{ entry.votes ? `${formatVotes(entry.votes)} 票` : '' }}
            </span>
          </button>
        </section>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.history-card {
  /* 团体色的可读文字版（同领奖台口径） */
  --gc-ink: color-mix(in srgb, var(--gc, var(--el-text-color-secondary)) 50%, #000);
  --accent: var(--color-elections);
  /* 卡面是浅底，关闭钮改用浅灰底深色图标 */
  --detail-close-bg: var(--el-fill-color);
  --detail-close-ink: var(--el-text-color-regular);

  flex-direction: column;
}

/* ===== 头部 ===== */
.history-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
  padding: 22px 56px 18px 24px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: radial-gradient(
    360px 140px at 0% 0%,
    color-mix(in srgb, var(--color-elections) 12%, transparent),
    transparent 72%
  );
}

.history-avatar {
  flex: none;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color-light);
  box-shadow:
    0 0 0 2.5px var(--gc, var(--color-elections)),
    0 0 0 4.5px color-mix(in srgb, var(--gc, var(--color-elections)) 22%, transparent);
}

.avatar-fallback {
  font-size: 28px;
}

.history-id {
  min-width: 0;
}

.history-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.history-group {
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.8;
  color: var(--gc-ink);
  background: color-mix(in srgb, var(--gc, var(--el-text-color-secondary)) 14%, transparent);
}

.history-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);

  b {
    font-weight: 700;
    color: var(--el-text-color-primary);
  }

  small {
    margin-left: 2px;
    font-size: 10px;
  }
}

/* ===== 滚动主体 ===== */
.history-body {
  flex: 1;
  padding: 16px 24px 22px;
}

.history-subtitle {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

/* ===== 走势图 ===== */
.history-chart {
  margin-bottom: 18px;
}

.chart-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.chart-current {
  fill: color-mix(in srgb, var(--color-elections) 9%, transparent);
}

.chart-grid {
  line {
    stroke: var(--el-border-color-lighter);
    stroke-dasharray: 3 4;
  }

  text {
    font-size: 10px;
    fill: var(--el-text-color-secondary);
  }
}

.chart-years text {
  font-size: 10px;
  font-weight: 600;
  fill: var(--el-text-color-regular);

  &.is-absent {
    fill: var(--el-text-color-placeholder);
    font-weight: 400;
  }

  &.is-current {
    fill: var(--color-elections);
  }
}

.chart-line {
  fill: none;
  stroke: var(--color-elections);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.chart-point {
  circle {
    fill: var(--el-bg-color);
    stroke: var(--color-elections);
    stroke-width: 2;
  }

  text {
    font-size: 10px;
    font-weight: 700;
    fill: var(--el-text-color-primary);
  }

  &.is-current text {
    font-size: 12px;
    fill: var(--color-elections);
  }
}

/* ===== 历届明细 ===== */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.5fr) auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font: inherit;
  text-align: left;
  color: inherit;
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    border-color 0.18s ease;

  &:hover {
    background: var(--el-fill-color-light);
  }

  &.is-current {
    border-color: color-mix(in srgb, var(--color-elections) 30%, transparent);
    background: color-mix(in srgb, var(--color-elections) 6%, transparent);
  }
}

.row-year {
  display: flex;
  flex-direction: column;
  min-width: 0;

  b {
    font-size: 14px;
    font-weight: 700;
    color: var(--el-text-color-primary);
  }

  small {
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--el-text-color-secondary);
  }
}

.row-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.row-rank {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--medal, var(--el-text-color-primary)) 70%, #000);
}

.row-section,
.row-absent {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.row-newcomer {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.7;
  color: color-mix(in srgb, var(--brand-primary) 75%, #000);
  background: color-mix(in srgb, var(--brand-primary) 13%, transparent);
}

.row-votes {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
</style>
