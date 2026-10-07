<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import type { StatsScope, StatsStatus } from '@renderer/utils/member-stats'
import { User } from '@element-plus/icons-vue'
import MemberStatBars from '@renderer/components/member/MemberStatBars.vue'
import { EXCLUDED_GROUP_COUNT, EXCLUDED_GROUP_LABELS } from '@renderer/utils/member-exclude'
import { memberCardKey } from '@renderer/utils/member-list'
import {
  birthMonthStats,
  birthplaceStats,
  bloodTypeStats,
  canonicalMembers,
  constellationStats,
  groupStats,
  heightBucketStats,
  heightRanking,
  joinYearStats,
  periodStats,
  scopeMembers,
  STATS_ALL_SCOPE,
  STATS_STATUS_ALL,
  STATS_STATUS_OPTIONS,
  statsOverview,
  statusMembers,
  teamStats,
} from '@renderer/utils/member-stats'
import Tools from '@renderer/utils/tools'
import { computed, ref } from 'vue'

/** 成员数据看板：统计口径在 utils/member-stats.ts，这里只取数与铺版；范围由页面 v-model。 */
const props = defineProps<{
  members: MemberDetail[]
  /** 范围选项：全库 + 各分团，由页面按 Constants.GroupTabs 生成 */
  scopes: StatsScope[]
  /** 当前范围：groupId 字符串，'0' 为全库 */
  scope: string
}>()

const emit = defineEmits<{
  'select': [member: MemberDetail]
  'update:scope': [key: string]
}>()

/** 状态口径：看板内部状态，不影响页面其它区域。 */
const status = ref<StatsStatus>(STATS_STATUS_ALL)

/** 先全库去重，再按范围 / 状态筛，避免兼任镜像卡重复计数。 */
const canonical = computed(() => canonicalMembers(props.members))
const scoped = computed(() =>
  statusMembers(scopeMembers(canonical.value, props.scope), status.value),
)

/** 是否处于「全部」范围：决定分团分布图要不要画、期数是否带团体前缀 */
const isAll = computed(() => !props.scope || props.scope === STATS_ALL_SCOPE)

const overview = computed(() => statsOverview(scoped.value))
const constellations = computed(() => constellationStats(scoped.value))
const bloodTypes = computed(() => bloodTypeStats(scoped.value))
const birthMonths = computed(() => birthMonthStats(scoped.value))
const joinYears = computed(() => joinYearStats(scoped.value))
const periods = computed(() => periodStats(scoped.value))
const teams = computed(() => teamStats(scoped.value))
const groups = computed(() => groupStats(scoped.value))
const birthplaces = computed(() => birthplaceStats(scoped.value))
const heights = computed(() => heightRanking(scoped.value))
const heightBuckets = computed(() => heightBucketStats(scoped.value))

/** 分区主题色：同区图表共用一色。 */
const ACCENT_STRUCTURE = 'var(--color-members)'
const ACCENT_PROFILE = 'var(--color-albums)'
const ACCENT_BODY = 'var(--color-follow)'
const ACCENT_ESTABLISH = 'var(--color-downloads)'

interface OverviewTile {
  label: string
  value: number
  suffix: string
  accent: string
  /** 悬停说明 */
  title?: string
}

/** 概览磁贴：按状态收起恒为 0 / 重复的数字。 */
const tiles = computed<OverviewTile[]>(() => {
  const data = overview.value
  const isAllStatus = status.value === STATS_STATUS_ALL
  const statusTiles: OverviewTile[] = []
  if (isAllStatus) {
    statusTiles.push(
      { label: '在团', value: data.active, suffix: '人', accent: 'var(--color-downloads)' },
      { label: '暂休', value: data.hiatus, suffix: '人', accent: 'var(--color-shows)' },
      { label: '退团', value: data.left, suffix: '人', accent: 'var(--el-text-color-secondary)' },
    )
    // 荣誉毕业在上游仍是 status=1，但不算「在团」；单列以保持总数可加。
    if (data.honorary > 0) {
      statusTiles.push({
        label: '荣誉毕业',
        value: data.honorary,
        suffix: '人',
        accent: 'var(--color-follow)',
        title: '荣誉毕业生 / 明星殿堂：已毕业、升堂，不计入「在团」',
      })
    }
  }
  return [
    {
      label: isAllStatus ? '成员总数' : '在团成员',
      value: data.total,
      suffix: '人',
      accent: 'var(--color-members)',
    },
    ...statusTiles,
    { label: '在团队伍', value: data.teams, suffix: '支', accent: 'var(--color-albums)' },
    { label: '有总选名次', value: data.ranked, suffix: '人', accent: 'var(--color-elections)' },
    { label: '平均身高', value: data.averageHeight, suffix: 'cm', accent: 'var(--color-follow)' },
  ]
})

/** 身高之最：鎏金只给最高榜首。 */
const heightColumns = computed(() => [
  { key: 'tallest', label: '最高', highlightTop: true, entries: heights.value.tallest },
  { key: 'shortest', label: '最矮', highlightTop: false, entries: heights.value.shortest },
])

function pickScope(key: string) {
  if (key !== props.scope)
    emit('update:scope', key)
}
</script>

<template>
  <div class="stats-board">
    <!-- 范围和状态是两个正交筛选维度。 -->
    <div class="board-filters">
      <div class="scope-bar">
        <button
          v-for="option in scopes"
          :key="option.key"
          class="scope-pill"
          :class="{ 'is-active': option.key === scope }"
          :style="{ '--scope-accent': option.color || 'var(--brand-primary)', '--scope-ink': Tools.readableInk(option.color) }"
          type="button"
          :title="`按 ${option.label} 统计`"
          @click="pickScope(option.key)"
        >
          <span class="scope-pill__dot" />
          {{ option.label }}
        </button>
      </div>

      <div class="status-bar">
        <span class="status-bar__label">状态</span>
        <div class="status-track">
          <button
            v-for="option in STATS_STATUS_OPTIONS"
            :key="option.key"
            class="status-pill"
            :class="{ 'is-active': option.key === status }"
            type="button"
            :title="option.title"
            @click="status = option.key"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- 换筛选时整块重挂，让条形图重新播放生长动画。 -->
    <div :key="`${scope}:${status}`" class="board-body">
      <header class="board-head">
        <h2 class="board-head__title">
          数据看板
          <span class="board-head__count">{{ overview.total }} 位成员</span>
        </h2>
        <p
          class="board-head__sub"
          :title="`已屏蔽：${EXCLUDED_GROUP_LABELS.join('、')}`"
        >
          {{ isAll ? '全库档案' : `${scopes.find(item => item.key === scope)?.label ?? ''} 成员档案` }}
          · {{ status === STATS_STATUS_ALL ? '含暂休 / 退团' : '仅在团（不含荣誉毕业生 / 明星殿堂）' }}
          · 已去重兼任记录，不含 {{ EXCLUDED_GROUP_COUNT }} 个衍生团体
        </p>
      </header>

      <!-- 人员结构：只放轻量图，巨卡放到最后的「队伍明细」。 -->
      <section class="board-section" :style="{ '--sec-accent': ACCENT_STRUCTURE }">
        <h3 class="board-section__title">
          人员结构
          <span class="board-section__note">{{ overview.total }} 位成员 · {{ overview.teams }} 支在团队伍</span>
        </h3>

        <div class="ov-grid">
          <div
            v-for="tile in tiles"
            :key="tile.label"
            class="ov-tile"
            :style="{ '--tile-accent': tile.accent }"
            :title="tile.title"
          >
            <p class="ov-tile__value">
              {{ tile.value }}<span class="ov-tile__suffix">{{ tile.suffix }}</span>
            </p>
            <p class="ov-tile__label">
              {{ tile.label }}
            </p>
          </div>
        </div>

        <div class="chart-grid">
          <!-- 分团分布只在全库范围有意义。 -->
          <MemberStatBars v-if="isAll" title="分团分布" :items="groups" :accent="ACCENT_STRUCTURE" />
          <MemberStatBars title="入团年份" :items="joinYears" :accent="ACCENT_STRUCTURE" :columns="2" />
        </div>
      </section>

      <!-- 人群画像 -->
      <section class="board-section" :style="{ '--sec-accent': ACCENT_PROFILE }">
        <h3 class="board-section__title">
          人群画像
          <span class="board-section__note">来自星座 / 血型 / 生日 / 籍贯档案</span>
        </h3>

        <div class="chart-grid">
          <MemberStatBars title="星座分布" :items="constellations" :accent="ACCENT_PROFILE" />
          <MemberStatBars title="血型分布" :items="bloodTypes" :accent="ACCENT_PROFILE" />
          <MemberStatBars title="生日月份" :items="birthMonths" :accent="ACCENT_PROFILE" />
          <!-- 出生地条目多，独占一行并自适应多栏。 -->
          <MemberStatBars class="chart-wide" columns="auto" title="出生地分布" :items="birthplaces" :accent="ACCENT_PROFILE" />
        </div>
      </section>

      <!-- 身体数据：分布 + 之最 -->
      <section class="board-section" :style="{ '--sec-accent': ACCENT_BODY }">
        <h3 class="board-section__title">
          身体数据
          <span class="board-section__note">
            平均 {{ heights.average }} cm · {{ heights.counted }} 人有身高档案
          </span>
        </h3>

        <div class="chart-grid">
          <MemberStatBars title="身高分布" :items="heightBuckets" :accent="ACCENT_BODY" />

          <div class="height-card">
            <p class="height-card__title">
              身高之最
            </p>
            <div class="height-cols">
              <div v-for="column in heightColumns" :key="column.key" class="height-col">
                <p class="height-col__label">
                  {{ column.label }}
                </p>
                <ul class="height-list">
                  <li v-for="(entry, index) in column.entries" :key="memberCardKey(entry.member)">
                    <button
                      class="height-row"
                      type="button"
                      :title="`查看 ${entry.member.realName} 的资料`"
                      @click="emit('select', entry.member)"
                    >
                      <span class="height-row__rank" :class="{ 'is-top': index === 0 && column.highlightTop }">{{ index + 1 }}</span>
                      <el-image class="height-row__avatar" :src="entry.member.avatar" fit="cover">
                        <template #error>
                          <span class="height-row__fallback">
                            <el-icon :size="14">
                              <User />
                            </el-icon>
                          </span>
                        </template>
                      </el-image>
                      <span class="height-row__name ellipsis">{{ entry.member.realName }}</span>
                      <span class="height-row__value">{{ entry.height }}<i>cm</i></span>
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 队伍明细：条目多，放最后避免挤占首屏。 -->
      <section class="board-section" :style="{ '--sec-accent': ACCENT_ESTABLISH }">
        <h3 class="board-section__title">
          队伍明细
          <span class="board-section__note">期数与队伍逐项</span>
        </h3>

        <div class="chart-grid">
          <MemberStatBars class="chart-wide" columns="auto" title="期数分布" :items="periods" :accent="ACCENT_ESTABLISH" />
          <MemberStatBars class="chart-wide" columns="auto" title="队伍分布" :items="teams" :accent="ACCENT_ESTABLISH" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.stats-board {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 范围和状态是两个正交筛选维度。 */
.board-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.scope-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 状态维度：标签 + 凹陷轨道。 */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 16px;
  border-left: 1px solid var(--el-border-color);
}

.status-bar__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.status-track {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--el-text-color-primary) 8%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-text-color-primary) 6%, transparent);
}

.status-pill {
  height: 22px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;

  /* 悬浮时抬起成白片，与选中态的实心紫再区分一层 */
  &:hover {
    color: var(--brand-primary-dark);
    background: var(--el-bg-color);
  }

  &.is-active {
    color: #fff;
    font-weight: 600;
    background: var(--gradient-brand);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.3),
      var(--shadow-glow);
  }
}

/* 范围药丸：选中用团体色实心填充；文字色按底色亮度计算。 */
.scope-pill {
  --scope-accent: var(--brand-primary);
  --scope-ink: #fff;

  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 26px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--scope-accent) 24%, transparent);
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--scope-accent) 52%, #24223a);
  background: color-mix(in srgb, var(--scope-accent) 7%, var(--el-bg-color));
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--scope-accent) 45%, transparent);
    background: color-mix(in srgb, var(--scope-accent) 16%, var(--el-bg-color));
  }

  &.is-active {
    border-color: var(--scope-accent);
    color: var(--scope-ink);
    background: var(--scope-accent);
    /* 同色描边 + 外发光：把实心药丸从一排淡底药丸里「抬」出来 */
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--scope-accent) 28%, transparent),
      0 4px 12px -4px color-mix(in srgb, var(--scope-accent) 75%, transparent);
  }
}

.scope-pill__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--scope-accent);
}

/* 选中态圆点跟随文字色。 */
.scope-pill.is-active .scope-pill__dot {
  background: currentColor;
}

.board-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 入场：分区按顺序上浮，与详情卡同一曲线 */
.board-head,
.board-section {
  animation: detail-enter 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.board-section:nth-child(2) {
  animation-delay: 0.05s;
}

.board-section:nth-child(3) {
  animation-delay: 0.1s;
}

.board-section:nth-child(4) {
  animation-delay: 0.15s;
}

.board-section:nth-child(5) {
  animation-delay: 0.2s;
}

/* ===== 页头 ===== */
.board-head__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.board-head__count {
  padding: 1px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.7;
  color: color-mix(in srgb, var(--color-members) 62%, #24223a);
  background: color-mix(in srgb, var(--color-members) 15%, var(--el-bg-color));
  font-variant-numeric: tabular-nums;
}

.board-head__sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ===== 分区：只做分组标题，不套外框 —— 里面的图表自己就是卡片，卡片套卡片会脏 ===== */
.board-section {
  --sec-accent: var(--brand-primary);
}

.board-section__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 700;
  color: var(--el-text-color-primary);

  &::before {
    content: '';
    flex: none;
    align-self: center;
    width: 3px;
    height: 14px;
    border-radius: var(--radius-pill);
    background: var(--sec-accent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--sec-accent) 45%, transparent);
  }
}

.board-section__note {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

/* ===== 概览磁贴 ===== */
.ov-grid {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
}

.ov-tile {
  --tile-accent: var(--brand-primary);

  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--tile-accent) 7%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tile-accent) 16%, transparent);
}

.ov-tile__value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  line-height: 1.1;
  color: color-mix(in srgb, var(--tile-accent) 72%, #1c1a2e);
  font-variant-numeric: tabular-nums;
}

.ov-tile__suffix {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.ov-tile__label {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 图表区：宽窗三列，窄窗堆叠；卡片按内容定高。 */
.chart-grid {
  display: grid;
  align-items: start;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
}

.chart-grid > .chart-wide {
  grid-column: 1 / -1;
}

/* ===== 身高之最 ===== */
.height-card {
  padding: 14px 16px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-lg);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
}

/* 与条形图标题保持同一套长相。 */
.height-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &::before {
    content: '';
    flex: none;
    width: 3px;
    height: 13px;
    border-radius: var(--radius-pill);
    background: var(--sec-accent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--sec-accent) 45%, transparent);
  }
}

.height-cols {
  display: grid;
  gap: 12px 20px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.height-col__label {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.height-list {
  margin: 0;
  padding: 0;
  list-style: none;

  li + li {
    margin-top: 2px;
  }
}

.height-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-sm);
  font-family: inherit;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.18s ease;

  &:hover {
    background: var(--el-fill-color-lighter);
  }
}

.height-row__rank {
  flex: none;
  width: 18px;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;

  &.is-top {
    color: var(--color-follow);
    text-shadow: 0 0 8px color-mix(in srgb, var(--color-follow) 50%, transparent);
  }
}

.height-row__avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color-light);
}

.height-row__fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--el-text-color-placeholder);
}

.height-row__name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  color: var(--el-text-color-primary);
}

.height-row__value {
  flex: none;
  font-size: 13px;
  font-weight: 700;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;

  i {
    margin-left: 1px;
    font-size: 10px;
    font-style: normal;
    font-weight: 500;
    color: var(--el-text-color-placeholder);
  }
}

@media (prefers-reduced-motion: reduce) {
  .board-head,
  .board-section {
    animation: none;
  }

  .scope-pill,
  .status-pill,
  .height-row {
    transition: none;
  }
}
</style>
