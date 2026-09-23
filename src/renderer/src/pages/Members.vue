<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { Hide, Star, StarFilled, User, View } from '@element-plus/icons-vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import MemberDetailDrawer from '@renderer/components/ui/MemberDetailDrawer.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberActions } from '@renderer/composables/use-member-actions'
import { useMemberSync } from '@renderer/composables/use-member-sync'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'

import { useMemberTreeStore } from '@renderer/stores/member-tree'
import Constants from '@renderer/utils/constants'
import { buildAdjuncts, mergeMembers } from '@renderer/utils/member-merge'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'

/**
 * 顶部 tab：5 个分团 + 末尾「成员库」（全部团体）。
 * key 一律是 groupId —— 与公演页 Constants.GroupTabs 共用同一套分团配置（含主题色），
 * 展示顺序按需求固定为 SNH48 / GNZ48 / BEJ48 / CKG48 / CGT48 / 成员库。
 */
const LIBRARY_KEY = 'library'
const GROUP_TAB_KEYS = ['10', '12', '11', '14', '21']

const MEMBER_TABS: Array<{ label: string, key: string, color: string }> = [
  ...GROUP_TAB_KEYS.map(key => Constants.GroupTabs.find(tab => tab.key === key) ?? { label: key, key, color: '' }),
  { label: '成员库', key: LIBRARY_KEY, color: 'var(--color-members)' },
]

const activeKey = ref('10')
const isLibrary = computed(() => activeKey.value === LIBRARY_KEY)

/** 合并后的成员列表：成员树（starInfo）为骨架，allmembers 补官网字段，见 utils/member-merge.ts */
const members = ref<MemberDetail[]>([])
const loading = ref(true)

/** 当前查看详情的成员（null = 抽屉关闭） */
const selectedMember = ref<MemberDetail | null>(null)

/** 屏蔽名单：模块级共享状态，机制见 stores/member-flags.ts */
const { refreshBlockedMembers } = useBlockedMembersStore()

/** 关注名单：模块级共享状态，机制见 stores/member-flags.ts（直播列表页共用同一份） */
const { refreshFollowedMembers } = useFollowedMembersStore()

/** 关注 / 屏蔽的互斥规则集中在 use-member-actions.ts（本页卡片与三处详情抽屉共用同一份） */
const { isBlocked, isFollowed, toggleBlockMember, toggleFollowMember } = useMemberActions()

/** 成员树：全局单例（与回放页筛选器共用同一份，同步完成后由 store 统一作废重拉） */
const { loadTree } = useMemberTreeStore()

/** 成员状态（starInfo.status）取值见 Constants.MemberStatus（与详情抽屉 / 回放页共用） */
const { Active: STATUS_ACTIVE, Hiatus: STATUS_HIATUS, Left: STATUS_LEFT } = Constants.MemberStatus

interface MemberSection {
  /** 分区标识（团体 + 队伍 / 状态分区名） */
  key: string
  title: string
  /** 队伍徽章（合并时已归一化） */
  teamBadge: string
  /** 分区标题主题色：跟随队伍 teamColor；暂休/退团走弱化灰变体 */
  accent?: string
  /** 分团官方 logo（snh48.com 的 about-logo-*.png）：队伍徽章缺失时充当标题左侧图标；
   * 查不到所属团体 logo 的团体（IDFT / 燃烧吧团魂 等）走 `Constants.GroupLogoFallback`，故必有值 */
  groupLogo: string
  muted?: boolean
  members: MemberDetail[]
}

/** 按队伍分区：入参已按树的顺序（团体 → teamSort）排好，用 Map 保住首现顺序 */
function groupByTeam(list: MemberDetail[], withGroup: boolean): MemberSection[] {
  const sections = new Map<string, MemberSection>()
  // 队伍徽章缺失时用分团 logo 兜底（表里没有的团体与暂休 / 退团分区一律退 GroupLogoFallback）
  const groupLogoOf = (member: MemberDetail) =>
    Constants.GroupTabs.find(item => item.key === String(member.groupId))?.logoPng
    || Constants.GroupLogoFallback
  for (const member of list) {
    const key = `${member.groupName}/${member.teamName}`
    const existing = sections.get(key)
    if (existing) {
      existing.members.push(member)
      continue
    }
    sections.set(key, {
      key,
      title: withGroup ? `${member.groupName} · ${member.teamName}` : member.teamName,
      teamBadge: member.teamBadge,
      accent: member.teamColor ? `#${member.teamColor}` : '',
      groupLogo: groupLogoOf(member),
      members: [member],
    })
  }
  return [...sections.values()]
}

/**
 * 展示分区：
 * - 分团 tab：只列在团成员，按队伍分区
 * - 成员库：全部分团汇总，按「团体 · 队伍」列在团，末尾追加 暂休 / 退团
 */
const sections = computed<MemberSection[]>(() => {
  const scope = isLibrary.value
    ? members.value
    : members.value.filter(member => String(member.groupId) === activeKey.value)
  const active = groupByTeam(scope.filter(member => member.status === STATUS_ACTIVE), isLibrary.value)
  if (!isLibrary.value)
    return active

  const inactiveSections = (status: number, title: string): MemberSection[] => {
    const list = scope.filter(member => member.status === status)
    return list.length
      ? [{ key: title, title, teamBadge: '', groupLogo: Constants.GroupLogoFallback, muted: true, members: list }]
      : []
  }
  return [...active, ...inactiveSections(STATUS_HIATUS, '暂休'), ...inactiveSections(STATUS_LEFT, '退团')]
})

/** 在团 / 暂休退团人数（分团 tab 只有前者的值，后者为 0） */
const activeCount = computed(() =>
  sections.value.filter(section => !section.muted).reduce((sum, section) => sum + section.members.length, 0),
)
const inactiveCount = computed(() =>
  sections.value.filter(section => section.muted).reduce((sum, section) => sum + section.members.length, 0),
)
const memberCount = computed(() => activeCount.value + inactiveCount.value)

// 首次/切换后无成员数据时展示骨架；已有数据刷新不整页遮罩
const showSkeleton = computed(() => loading.value && members.value.length === 0)

onMounted(() => {
  fetchMembers()
  refreshBlockedMembers()
  refreshFollowedMembers()
})

/** 拉取两个数据源并合并（挂载初始化 / 双击 tab / 更新数据库后共用）。
 * 成员树取自 stores/member-tree（同步完成后会自行失效重拉，故这里按缓存优先读取即可）；
 * 兼任成员（starAdjunctInfo，status===1）由 buildAdjuncts 以本人档案为底就地并入其兼任队伍 */
async function fetchMembers() {
  loading.value = true
  try {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    const [tree, payload] = await Promise.all([
      loadTree(),
      window.mainAPI.getAllMembers(),
    ])
    const merged = mergeMembers(tree, payload?.allmembers)
    members.value = [...merged, ...buildAdjuncts(merged, tree, payload?.adjuncts)]
  }
  catch (error) {
    console.error('获取成员信息失败:', error)
    ElMessage.error('获取成员信息失败，请稍后重试')
  }
  finally {
    loading.value = false
  }
}

/** 切换 tab：FloatingTabBar 的 change 事件载荷是 string，这里按已知 tab 收窄 */
function changeTab(key: string) {
  if (MEMBER_TABS.some(tab => tab.key === key))
    activeKey.value = key
}

/** 成员同步：loading 态与接口调用集中在 use-member-sync.ts（与首页启动兜底共用） */
const { isSyncing, syncMembers } = useMemberSync()

/** 更新成员数据库：从接口同步最新名单，成功后刷新本页 */
async function updateMembers() {
  const ok = await syncMembers()
  if (ok)
    await fetchMembers()
}

/** 头像圆环强调色：兼任成员取主队色 ringColor，其余成员取所属队伍色 teamColor；都没有时不注入变量，走 CSS 默认渐变 */
function avatarAccentStyle(member: MemberDetail) {
  const color = member.ringColor || member.teamColor
  return color ? { '--avatar-accent': `#${color}` } : undefined
}

/** 卡片 key：兼任记录用兼职档案主键（加前缀，避免数值上与别的 userId 相撞），其余成员用 userId / sid 兜底 */
function cardKey(member: MemberDetail) {
  if (member.adjunctId !== undefined)
    return `adjunct-${member.adjunctId}`
  return member.userId ?? member.sid
}

/** 分区标题左侧图标：优先队伍徽章，退分团官方 logoPng（groupLogo 有 GroupLogoFallback 兜底，恒非空） */
function badgeSrc(section: MemberSection) {
  return section.teamBadge || section.groupLogo
}
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮动分团切换：5 个分团 + 成员库；双击当前 tab 刷新列表 -->
    <FloatingTabBar :tabs="MEMBER_TABS" :active="activeKey" @change="changeTab" @refresh="fetchMembers" />
    <el-scrollbar class="scrollbar-wrapper">
      <CardSkeletonGrid
        v-if="showSkeleton"
        class="members-skeleton"
        :count="12"
        min-item-width="118px"
        gap="6px"
        aspect-ratio="1"
        media-radius="50%"
        :line-widths="[68]"
      />
      <div v-else class="members-container">
        <section v-for="section in sections" :key="section.key" class="group-section">
          <h2 class="team-title">
            <!-- 徽章盒子固定尺寸，保证各分区标题列起点一致 -->
            <span class="team-badge-box">
              <img
                v-if="badgeSrc(section)"
                class="team-badge-img"
                :src="badgeSrc(section)"
                alt=""
              >
            </span>
            <span
              class="section-title"
              :class="{ 'section-title--muted': section.muted }"
              :style="section.accent ? { '--st-accent': section.accent } : undefined"
            >
              {{ `${section.title} (${section.members.length})` }}
            </span>
          </h2>
          <div class="member-list">
            <!-- key 见 cardKey：兼任记录走档案主键，官网独有的补充成员走 sid 兜底 -->
            <div
              v-for="member in section.members"
              :key="cardKey(member)"
              class="member-card"
              :class="{ 'is-blocked': !!member.userId && isBlocked(member.userId), 'is-followed': !!member.userId && isFollowed(member.userId) }"
              @click="selectedMember = member"
            >
              <div
                class="avatar-wrap"
                :style="avatarAccentStyle(member)"
              >
                <el-image class="avatar" :src="member.avatar" fit="cover" lazy>
                  <template #placeholder>
                    <div class="media-ph" />
                  </template>
                  <template #error>
                    <div class="media-ph">
                      <el-icon :size="30">
                        <User />
                      </el-icon>
                    </div>
                  </template>
                </el-image>

                <!-- 排名徽章：总选排名非 0 的成员在头像左上角显示皇冠，数字内嵌皇冠中 -->
                <span v-if="member.ranking" class="rank-crown">
                  <MediaIcon name="crownFilled" :size="30" />
                  <span class="rank-crown__num">{{ member.ranking }}</span>
                </span>
              </div>

              <div class="member-meta">
                <p class="member-name ellipsis" :title="member.realName">
                  {{ member.realName }}
                </p>
              </div>
              <!-- 图标即状态：空心 = 未启用（悬浮才出现），实心 = 已启用（语义色实底、常驻）；两者互斥 -->
              <template v-if="member.userId">
                <button
                  class="quick-follow"
                  :class="{ 'is-on': isFollowed(member.userId) }"
                  :title="isFollowed(member.userId) ? '取消关注' : '关注 TA，直播列表优先展示'"
                  @click.stop="toggleFollowMember(member)"
                >
                  <el-icon :size="14">
                    <StarFilled v-if="isFollowed(member.userId)" />
                    <Star v-else />
                  </el-icon>
                </button>
                <button
                  class="quick-block"
                  :class="{ 'is-on': isBlocked(member.userId) }"
                  :title="isBlocked(member.userId) ? '解除屏蔽' : '屏蔽 TA 的直播与回放'"
                  @click.stop="toggleBlockMember(member)"
                >
                  <el-icon :size="14">
                    <Hide v-if="isBlocked(member.userId)" />
                    <View v-else />
                  </el-icon>
                </button>
              </template>
            </div>
          </div>
        </section>

        <el-empty
          v-if="!loading && memberCount === 0"
          class="page-empty"
          :image-size="120"
          description="暂无成员信息，可在设置里同步成员数据"
        />
      </div>
      <div v-if="memberCount > 0" class="list-end">
        {{ isLibrary ? `在团共 ${activeCount} 人，离团 ${inactiveCount} 人` : `在团共 ${activeCount} 人` }}
      </div>
    </el-scrollbar>

    <!-- 右上角浮动操作条：更新成员数据库 -->
    <FloatingRefreshDock
      :loading="isSyncing || loading"
      title="更新成员数据库"
      @refresh="updateMembers"
    >
      <span class="dock-note">更新成员数据库</span>
    </FloatingRefreshDock>

    <!-- 成员详情抽屉：两个数据源合并后的同一个详情页 -->
    <MemberDetailDrawer
      :member="selectedMember"
      :blocked="!!selectedMember?.userId && isBlocked(selectedMember.userId)"
      :followed="!!selectedMember?.userId && isFollowed(selectedMember.userId)"
      @close="selectedMember = null"
      @toggle-block="toggleBlockMember"
      @toggle-follow="toggleFollowMember"
    />
  </div>
</template>

<style scoped lang="scss">
/* 页面骨架（相对定位 + 裁剪）见全局 .page-root；
 * 滚动区给 Dock 的底部预留同样由全局 .page-root .el-scrollbar__view 统一提供 */

.members-container {
  /* 顶部留出左上角浮动切换器的空间（--tabbar-offset-top）；底留卡片悬停上浮与阴影的空间 */
  padding: var(--page-pad);
}

/* 分区标题：队伍徽章图标居左、标题居右的水平布局；
 * 徽章盒子固定尺寸、始终占位（无徽章分区标题列起点保持一致） */
.team-title {
  display: flex;
  gap: 14px;
  align-items: center;
  margin: 18px 4px 6px;

  /* 统一尺寸的徽章盒子：图标等比缩放入内（图标恒有值，见 badgeSrc / GroupLogoFallback） */
  .team-badge-box {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 54px;
    height: 54px;

    .team-badge-img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
    }
  }

  /* 复用全局分区标题：撑满剩余宽度以展示右侧渐隐细线 */
  .section-title {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
}

.members-skeleton {
  padding: var(--page-pad);

  /* 骨架与卡片同构（透明底、92px 圆头像、文案行居中），加载完成时不跳版 */
  :deep(.skeleton-card) {
    overflow: visible;
    border: none;
    background: transparent;
    box-shadow: none;
  }

  :deep(.skeleton-media) {
    width: 92px;
    margin: 0 auto;
  }

  :deep(.skeleton-body) {
    margin-top: 14px;
    padding: 0 4px;
  }
}

.member-list {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
}

.member-card {
  /* 无实底卡片皮肤：透明底，仅保留功能性布局与 hover 动效；可点击 */
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 7px 8px;
  background: transparent;
  border: none;
  box-shadow: none;
  cursor: pointer;

  /* 头像圆形容器：渐变光环 + 顶部高光；hover 轻微放大 */
  .avatar-wrap {
    position: relative;
    width: 92px;
    aspect-ratio: 1;
    border-radius: 50%;
    padding: 3px;
    background: radial-gradient(circle at 30% 20%, #fff, rgba(255, 255, 255, 0));
    transition: transform 0.25s ease;
    transform-origin: center;

    /* hover：头像略微放大 */
    &:hover {
      transform: scale(1.16);
    }

    &::before {
      /* 主题色渐变光环（跟随队伍强调色；无强调色时回退为蓝紫渐变） */
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 2px;
      background: linear-gradient(
        135deg,
        var(--avatar-accent, #4f6ef7),
        var(--avatar-accent, #a94ff7) 60%,
        var(--avatar-accent, #50c8ff)
      );
      -webkit-mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      opacity: 0.85;
    }

    &::after {
      /* 顶部高光：营造玻璃质感 */
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(160deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 45%);
      pointer-events: none;
    }

    /* 圆形头像本身 */
    .avatar {
      display: block;
      width: 100%;
      aspect-ratio: 1;
      border-radius: 50%;
      overflow: hidden;
      background: var(--el-fill-color-light);
    }
  }

  /* 排名皇冠徽章：头像左上角，队色皇冠（MediaIcon 实心壳）+ 内嵌数字；屏蔽后隐藏 */
  .rank-crown {
    position: absolute;
    top: 0px;
    left: 0px;
    z-index: 3;
    display: inline-flex;
    pointer-events: none;
    transition: opacity 0.15s ease;

    /* 队色皇冠：沿用 avatar-wrap 注入的 --avatar-accent；无队色回退金色 */
    .media-icon {
      color: var(--avatar-accent, var(--color-follow));
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
    }

    /* 排名数字：叠加在皇冠图形内部偏下的位置 */
    &__num {
      position: absolute;
      left: 50%;
      bottom: 8px;
      transform: translateX(-50%);
      padding: 0 1px;
      border-radius: var(--radius-xs);
      font-size: 11px;
      font-weight: 800;
      line-height: 1.3;
      text-align: center;
      color: #fff;
      text-shadow: 0 0 2px color-mix(in srgb, var(--avatar-accent, var(--color-follow)) 70%, transparent);
    }
  }

  .member-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    margin-top: 14px;
    padding: 0 4px;
    text-align: center;

    p {
      margin: 0;
    }
  }

  .member-name {
    width: 100%;
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  /* 关注 / 屏蔽钮：空心 = 未启用（悬浮出现），实心 = 已启用（语义色实底 + 白图标，常驻） */
  .quick-follow,
  .quick-block {
    position: absolute;
    right: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 50%;
    font-family: inherit;
    color: var(--el-text-color-regular);
    background: rgba(255, 255, 255, 0.88);
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    opacity: 0;
    transform: scale(0.9);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      color 0.15s ease,
      background-color 0.15s ease;
  }

  /* 关注在上、屏蔽在下：两枚钮错开 32px，互不遮挡 */
  .quick-follow {
    top: 12px;
  }

  .quick-block {
    top: 44px;
  }

  &:hover .quick-follow,
  &:hover .quick-block {
    opacity: 1;
    transform: scale(1);
  }

  /* 已启用：实心常驻（不悬浮也看得见），图标转白压在语义色实底上 */
  .quick-follow.is-on,
  .quick-block.is-on {
    color: #fff;
    opacity: 1;
    transform: scale(1);
  }

  .quick-follow.is-on {
    background: var(--color-follow);
  }

  .quick-block.is-on {
    background: var(--el-color-danger);
  }

  /* 单钮悬浮：再放大一档，提示可点（未启用时图标保持灰色空心，避免与已启用混淆） */
  .quick-follow:hover,
  .quick-block:hover {
    transform: scale(1.08);
  }

  /* 已屏蔽：头像去色弱化，排名装饰隐藏 */
  &.is-blocked {
    .avatar {
      filter: grayscale(1);
      opacity: 0.55;
    }

    .rank-crown {
      display: none;
    }
  }

  /* 已关注：头像使用单层金色光环，配合右上角金星钮识别状态 */
  &.is-followed .avatar-wrap::before {
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-follow) 75%, #fff),
      var(--color-follow) 55%,
      color-mix(in srgb, var(--color-follow) 85%, #ffd257)
    );
  }
}

/* 空态：样式见全局 .page-empty（竖直留白，视觉上与浮动切换器保持对称） */
</style>
