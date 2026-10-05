<script setup lang="ts">
import type { ElectionMember } from '@renderer/data/elections'
import ElectionRankCard from '@renderer/components/election/ElectionRankCard.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { ELECTIONS } from '@renderer/data/elections'
import {
  avatarUrl,
  buildSections,
  formatElectionDate,
  formatVotes,
  groupColor,
  medalColor,
} from '@renderer/utils/election'
import { computed, ref } from 'vue'

/**
 * 总选页：按年份查看 SNH48 GROUP 历届年度总选的最终名次。
 * 御三家（前三名）在页顶做成加冕领奖台，其余名次按官网口径切成星光 / 高飞 / 梦想 / 未来组；
 * 总选排名与新人榜是并列的两份榜单，用页内 tab 切换查看。
 */

/** 年份切换 tab：倒序，最新一届在最左，首屏不必横向滚动 */
const yearTabs = ELECTIONS.map(election => ({
  label: String(election.year),
  key: String(election.year),
  color: 'var(--color-elections)',
})).reverse()

const year = ref(String(ELECTIONS[ELECTIONS.length - 1].year))

const election = computed(() =>
  ELECTIONS.find(item => String(item.year) === year.value) ?? ELECTIONS[ELECTIONS.length - 1])

/** 榜单切换：总选排名与新人榜并列；当届没有新人榜时总选排名兜底 */
const listTab = ref<'main' | 'newcomer'>('main')

const newcomers = computed(() => election.value.newcomers)

const activeTab = computed(() =>
  listTab.value === 'newcomer' && !newcomers.value.length ? 'main' : listTab.value)

/** 前三名按领奖台站位排布：亚军居左、冠军居中、季军居右 */
interface PodiumSpot {
  role: 'champion' | 'runner'
  member: ElectionMember
}

const podiumSpots = computed<PodiumSpot[]>(() => {
  const [first, second, third] = election.value.members
  const spots: PodiumSpot[] = []
  if (second)
    spots.push({ role: 'runner', member: second })
  if (first)
    spots.push({ role: 'champion', member: first })
  if (third)
    spots.push({ role: 'runner', member: third })
  return spots
})

const champion = computed(() => election.value.members[0])

/** 御三家已在领奖台展示，分区从第四名开始 */
const sections = computed(() => buildSections(election.value.members.slice(3)))

/** 团体色与名次色注入：--gc 供团体文字 / 头像兜底，--medal 供名次徽章与头像戒圈（默认冠军金） */
function spotStyle(member: ElectionMember): Record<string, string> {
  const style: Record<string, string> = {}
  const color = groupColor(member.group)
  if (color)
    style['--gc'] = color
  style['--medal'] = medalColor(member.rank) ?? 'var(--medal-gold)'
  return style
}

/** 团体色注入 --gc：冠军的团体文字与头像兜底取它 */
const championStyle = computed(() => {
  const color = champion.value ? groupColor(champion.value.group) : ''
  return color ? { '--gc': color } : undefined
})
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮动年份切换：与公演 / 成员页同一套玻璃切换器 -->
    <FloatingTabBar :tabs="yearTabs" :active="year" @change="year = $event" />

    <el-scrollbar class="scrollbar-wrapper">
      <!-- 整块按年份重建，切年份时名次卡重新错峰入场 -->
      <div :key="election.year" class="elections-container">
        <!-- 加冕领奖台：御三家 + 当届信息 -->
        <section class="podium" :style="championStyle">
          <div class="podium-head">
            <p class="podium-theme">
              {{ election.theme }}
            </p>
            <p class="podium-meta">
              {{ election.year }} 年度 · {{ formatElectionDate(election.date) }} · 入选 {{ election.members.length }} 人
            </p>
          </div>

          <div class="podium-row">
            <div
              v-for="spot in podiumSpots"
              :key="spot.member.rank"
              class="podium-spot"
              :class="`is-${spot.role}`"
              :style="spotStyle(spot.member)"
            >
              <span v-if="spot.role === 'champion'" class="spot-tag">
                <MediaIcon name="crownFilled" :size="14" />
                御三家
              </span>

              <div class="spot-figure">
                <!-- 加冕：皇冠压在头像顶沿，头像背后一圈金色光环 -->
                <MediaIcon v-if="spot.role === 'champion'" name="crownFilled" :size="36" class="spot-crown" />
                <span class="spot-halo" aria-hidden="true" />
                <el-image class="spot-avatar" :src="avatarUrl(spot.member.sid)" fit="cover">
                  <template #error>
                    <span class="avatar-fallback">{{ spot.member.name.slice(0, 1) }}</span>
                  </template>
                </el-image>
                <span v-if="spot.role === 'runner'" class="rank-badge spot-no is-medal">{{ spot.member.rank }}</span>
              </div>

              <p class="spot-name ellipsis" :title="spot.member.name">
                {{ spot.member.name }}
              </p>
              <p class="spot-sub">
                <span class="spot-group">{{ spot.member.group }}</span>
                <span v-if="spot.member.votes" class="spot-votes">{{ formatVotes(spot.member.votes) }} 票</span>
              </p>
            </div>
          </div>
        </section>

        <!-- 总选排名 / 新人榜：并列榜单，tab 切换 -->
        <div class="list-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="list-tab list-tab--main"
            :class="{ 'is-active': activeTab === 'main' }"
            :aria-selected="activeTab === 'main'"
            @click="listTab = 'main'"
          >
            总选排名
            <span class="list-tab-range">TOP{{ election.members.length }}</span>
          </button>
          <button
            v-if="newcomers.length"
            type="button"
            role="tab"
            class="list-tab list-tab--newcomer"
            :class="{ 'is-active': activeTab === 'newcomer' }"
            :aria-selected="activeTab === 'newcomer'"
            @click="listTab = 'newcomer'"
          >
            新人榜
            <span class="list-tab-range">TOP{{ newcomers.length }}</span>
          </button>
        </div>

        <!-- 星光 / 高飞 / 梦想 / 未来组：某届没有的名次段不产出 -->
        <template v-if="activeTab === 'main'">
          <template v-for="section in sections" :key="section.title">
            <h2 class="section-title section-title--elections">
              {{ section.title }}
              <span class="section-count">{{ section.range }}</span>
            </h2>
            <div class="rank-grid">
              <ElectionRankCard
                v-for="(member, index) in section.members"
                :key="member.rank"
                :member="member"
                :index="index"
              />
            </div>
          </template>
        </template>

        <template v-else>
          <div class="rank-grid">
            <ElectionRankCard
              v-for="(member, index) in newcomers"
              :key="`newcomer-${member.rank}`"
              :member="member"
              :index="index"
            />
          </div>
        </template>
      </div>
    </el-scrollbar>
  </div>
</template>

<style scoped lang="scss">
.elections-container {
  padding: var(--page-pad);
}

/* ===== 加冕领奖台：御三家（亚军 / 冠军 / 季军）+ 当届基本信息 ===== */
.podium {
  /* 团体色的可读文字版：浅色团色（GNZ48 黄绿、CKG48 琥珀）本色读不出来，压深一半才达标 */
  --gc-ink: color-mix(in srgb, var(--gc, var(--el-text-color-secondary)) 50%, #000);

  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding: 24px 30px 26px;
  border: 1px solid color-mix(in srgb, var(--medal-gold) 34%, var(--el-border-color-lighter));
  border-radius: var(--radius-card);
  /* 加冕舞台：左上庆典红聚光 + 右下金色余晖，把头图从平面衬出纵深 */
  background:
    radial-gradient(460px 200px at 0% 0%, color-mix(in srgb, var(--color-elections) 14%, transparent), transparent 72%),
    radial-gradient(320px 190px at 100% 100%, color-mix(in srgb, var(--medal-gold) 10%, transparent), transparent 70%),
    var(--el-bg-color);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--medal-gold) 22%, transparent),
    var(--shadow-sm);
  text-align: center;
}

.podium-head {
  min-width: 0;
}

.podium-theme {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.podium-meta {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 底边对齐的一排领奖台：冠军居中最大，两侧亚军 / 季军稍小 */
.podium-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 18px 36px;
}

.podium-spot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 领奖台基座：一截名次色的台面，冠军的最宽最高 */
.podium-spot::after {
  content: '';
  width: 88px;
  height: 8px;
  margin-top: 10px;
  border-radius: var(--radius-pill);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--medal) 38%, transparent),
    color-mix(in srgb, var(--medal) 16%, transparent)
  );
}

.podium-spot.is-champion::after {
  width: 108px;
  height: 13px;
}

/* 加冕徽章：金字金底的药丸，和头图的金环呼应 */
.spot-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 11px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: color-mix(in srgb, var(--medal-gold) 42%, #000);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--medal-gold) 22%, transparent),
    color-mix(in srgb, var(--medal-gold) 11%, transparent)
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--medal-gold) 32%, transparent);

  .media-icon {
    color: var(--medal-gold);
  }
}

.spot-figure {
  position: relative;
}

.is-champion .spot-figure {
  /* 皇冠的预留位 */
  padding-top: 30px;
}

.spot-crown {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 2;
  transform: translateX(-50%);
  color: var(--medal-gold);
  filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--medal-gold) 50%, transparent));
  animation: spot-crown-bob 2.6s ease-in-out infinite;
}

@keyframes spot-crown-bob {
  0%,
  100% {
    transform: translateX(-50%) translateY(0);
  }

  50% {
    transform: translateX(-50%) translateY(-3px);
  }
}

/* 金色光环：只给冠军，头像背后的柔光晕，撑出「聚光灯下」的加冕氛围 */
.is-champion .spot-halo {
  position: absolute;
  inset: 12px -22px -14px;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--medal-gold) 26%, transparent),
    color-mix(in srgb, var(--medal-gold) 9%, transparent) 58%,
    transparent 78%
  );
  filter: blur(2px);
}

.spot-avatar {
  position: relative;
  z-index: 1;
  display: block;
  width: 116px;
  height: 116px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color-light);
  /* 亚军 / 季军：名次色金属戒圈 + 下垂柔光 */
  box-shadow:
    0 0 0 3px var(--medal),
    0 0 0 4.5px color-mix(in srgb, var(--medal) 28%, transparent),
    0 6px 18px -6px color-mix(in srgb, var(--medal) 62%, transparent);
}

.is-champion .spot-avatar {
  width: 164px;
  height: 164px;
  /* 金色加冕双环：内实外虚，像一层金属戒圈 */
  box-shadow:
    0 0 0 3.5px var(--medal-gold),
    0 0 0 6px color-mix(in srgb, var(--medal-gold) 24%, transparent),
    0 10px 26px -10px color-mix(in srgb, var(--medal-gold) 65%, transparent);
}

/* 亚军 / 季军的名次徽章：走共享 .rank-badge 的金银铜款，按领奖台比例放大一号 */
.spot-no {
  min-width: 26px;
  height: 26px;
  padding: 0 8px;
  bottom: -1px;
  font-size: 14px;
}

/* 头像加载失败时用姓氏占位（共享兜底样式见 app.scss 的 .avatar-fallback） */
.avatar-fallback {
  font-size: 48px;
}

.spot-name {
  max-width: 140px;
  margin: 8px 0 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.is-champion .spot-name {
  max-width: 200px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1px;
}

.spot-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 12px;
}

.spot-group {
  font-weight: 600;
  color: var(--gc-ink);
}

.spot-votes {
  color: var(--el-text-color-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .spot-crown {
    animation: none;
  }
}

/* ===== 并列榜单切换：总选排名（庆典红）× 新人榜（品牌紫） ===== */
.list-tabs {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin: 26px 0 18px;
}

.list-tab {
  /* 当前 tab 的强调色：两个榜单各给一色，须在各 tab 的类里覆盖 */
  --tab-accent: var(--color-elections);

  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--tab-accent) 40%, var(--el-border-color));
    color: color-mix(in srgb, var(--tab-accent) 78%, #000);
  }

  &.is-active {
    border-color: transparent;
    color: #fff;
    background: linear-gradient(160deg, color-mix(in srgb, var(--tab-accent) 88%, #fff), var(--tab-accent));
    box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--tab-accent) 55%, transparent);
  }
}

.list-tab--newcomer {
  --tab-accent: var(--brand-primary);
}

.list-tab-range {
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.7;
  color: color-mix(in srgb, var(--tab-accent) 78%, #000);
  background: color-mix(in srgb, var(--tab-accent) 13%, transparent);
}

.is-active .list-tab-range {
  color: #fff;
  background: rgb(255 255 255 / 0.2);
}

/* 名次卡网格：与成员页同构（卡片皮肤 / 头像环复用 card-item / avatar-wrap），
 * 头像比成员卡大一档（92 → 112px），经共享的 --avatar-size 注入 */
.rank-grid {
  --avatar-size: 112px;

  display: grid;
  gap: 10px 8px;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
}
</style>
