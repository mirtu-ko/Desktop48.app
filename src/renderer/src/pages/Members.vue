<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { Hide, User, View } from '@element-plus/icons-vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import MemberDetailDrawer from '@renderer/components/ui/MemberDetailDrawer.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberSync } from '@renderer/composables/use-member-sync'
import { useBlockedMembersStore } from '@renderer/stores/blocked-members'
import Constants from '@renderer/utils/constants'
import { mergeMembers } from '@renderer/utils/member-merge'
import Tools from '@renderer/utils/tools'
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
  { label: '成员库', key: LIBRARY_KEY, color: Constants.Theme.MEMBERS },
]

const activeKey = ref('10')
const isLibrary = computed(() => activeKey.value === LIBRARY_KEY)

/** 合并后的成员列表：成员树（starInfo）为骨架，allmembers 补官网字段，见 utils/member-merge.ts */
const members = ref<MemberDetail[]>([])
const loading = ref(true)

/** 当前查看详情的成员（null = 抽屉关闭） */
const selectedMember = ref<MemberDetail | null>(null)

/** 屏蔽名单：模块级共享状态，机制见 stores/blocked-members.ts */
const { refreshBlockedMembers, isBlocked, toggleBlock } = useBlockedMembersStore()

/** 成员状态（starInfo.status）取值收口见 Constants.MemberStatus（与详情抽屉/回放页共用） */
const { Active: STATUS_ACTIVE, Hiatus: STATUS_HIATUS, Left: STATUS_LEFT } = Constants.MemberStatus

interface MemberSection {
  /** 分区标识（团体 + 队伍 / 状态分区名） */
  key: string
  title: string
  /** 队伍徽章（合并时已归一化） */
  teamBadge: string
  /** 分区标题主题色：跟随队伍 teamColor；暂休/退团走弱化灰变体 */
  accent?: string
  muted?: boolean
  members: MemberDetail[]
}

/** 按队伍分区：入参已按树的顺序（团体 → teamSort）排好，用 Map 保住首现顺序 */
function groupByTeam(list: MemberDetail[], withGroup: boolean): MemberSection[] {
  const sections = new Map<string, MemberSection>()
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
    return list.length ? [{ key: title, title, teamBadge: '', muted: true, members: list }] : []
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
})

/** 拉取两个数据源并合并（挂载初始化 / 双击 tab / 更新数据库后共用） */
async function fetchMembers() {
  loading.value = true
  try {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    const [tree, payload] = await Promise.all([
      window.mainAPI.getMemberTree(),
      window.mainAPI.getAllMembers(),
    ])
    members.value = mergeMembers(tree, payload?.allmembers)
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

/** 成员同步：loading 态与接口调用收口在 use-member-sync.ts（与首页的启动兜底共用一份逻辑） */
const { isSyncing, syncMembers } = useMemberSync()

/** 更新成员数据库：从接口同步最新名单，成功后刷新本页 */
async function updateMembers() {
  const ok = await syncMembers()
  if (ok)
    await fetchMembers()
}

/** 屏蔽 / 解除屏蔽：官网独有的补充成员没有 userId，直接忽略（卡片上也不给入口） */
function toggleBlockMember(member: MemberDetail) {
  const { userId } = member
  if (typeof userId !== 'number')
    return
  void toggleBlock({ ...member, userId })
}

/** 徽章加载失败时隐藏，避免显示碎图 */
function hideBadge(event: Event) {
  (event.target as HTMLImageElement).style.visibility = 'hidden'
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
        min-item-width="120px"
        gap="14px"
        aspect-ratio="3 / 4"
        :line-widths="[68]"
      />
      <div v-else class="members-container">
        <section v-for="section in sections" :key="section.key" class="group-section">
          <h2 class="team-title">
            <img
              v-if="section.teamBadge"
              class="team-badge-img"
              :src="section.teamBadge"
              alt=""
              @error="hideBadge"
            >
            <span
              class="section-title"
              :class="{ 'section-title--muted': section.muted }"
              :style="section.accent ? { '--st-accent': section.accent } : undefined"
            >
              {{ `${section.title} (${section.members.length})` }}
            </span>
          </h2>
          <div class="member-list">
            <!-- 官网独有的补充成员没有 userId，用 sid 兜底做 key -->
            <div
              v-for="member in section.members"
              :key="member.userId ?? member.sid"
              class="member-card lift-card clickable"
              :class="{ 'is-blocked': !!member.userId && isBlocked(member.userId) }"
              @click="selectedMember = member"
            >
              <el-image class="avatar" :src="member.avatar" fit="cover" lazy>
                <template #placeholder>
                  <div class="avatar-ph" />
                </template>
                <template #error>
                  <div class="avatar-ph">
                    <el-icon :size="28">
                      <User />
                    </el-icon>
                  </div>
                </template>
              </el-image>

              <!-- 排名徽章：总选排名非 0 的成员右上角显示皇冠，数字内嵌皇冠中 -->
              <span v-if="member.ranking" class="rank-crown">
                <svg
                  class="rank-crown__svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2l2.4 4.9L19 5l-2.1 5.6 2.6 2.3L12 21l-7.5-8.1 2.6-2.3L5 5l4.6 1.9L12 2z" />
                </svg>
                <span class="rank-crown__num">{{ member.ranking }}</span>
              </span>

              <div class="member-meta">
                <p class="member-name ellipsis" :title="member.realName">
                  {{ member.realName }}
                </p>
              </div>
              <span
                v-if="member.teamName"
                class="team-badge team-badge--overlay"
                :style="member.teamColor ? { '--tb-color': `#${member.teamColor}` } : undefined"
              >
                {{ Tools.shortTeamName(member.teamName) }}
              </span>

              <!-- 屏蔽控件：未屏蔽悬浮出现快捷屏蔽；已屏蔽常驻标记 + 悬浮解除 -->
              <template v-if="member.userId">
                <button
                  v-if="!isBlocked(member.userId)"
                  class="quick-block"
                  title="屏蔽 TA 的直播与回放"
                  @click.stop="toggleBlockMember(member)"
                >
                  <el-icon :size="13">
                    <Hide />
                  </el-icon>
                </button>
                <template v-else>
                  <span class="blocked-flag">
                    <el-icon :size="12">
                      <Hide />
                    </el-icon>
                    已屏蔽
                  </span>
                  <button class="unblock-btn" @click.stop="toggleBlockMember(member)">
                    <el-icon :size="13">
                      <View />
                    </el-icon>
                    解除屏蔽
                  </button>
                </template>
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
      <span class="member-count">更新成员数据库</span>
    </FloatingRefreshDock>

    <!-- 成员详情抽屉：两个数据源合并后的同一个详情页 -->
    <MemberDetailDrawer
      :member="selectedMember"
      :blocked="!!selectedMember?.userId && isBlocked(selectedMember.userId)"
      @close="selectedMember = null"
      @toggle-block="toggleBlockMember"
    />
  </div>
</template>

<style scoped lang="scss">
/* 页面骨架（相对定位 + 裁剪）见全局 .page-root */

.members-container {
  /* 顶部留出左上角浮动切换器的空间（--tabbar-offset-top）；底留卡片悬停上浮与阴影的空间 */
  padding: var(--tabbar-offset-top) 16px 8px;
}

/* 底部留出 Dock 空间（--dock-reserve） */
:deep(.el-scrollbar__view) {
  padding-bottom: var(--dock-reserve);
}

/* 分区标题 */
.team-title {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  margin: 14px 4px 12px;

  /* 徽章保持原始宽高比 */
  .team-badge-img {
    flex: none;
    height: 144px;
    width: auto;
    object-fit: contain;
  }

  /* 复用全局分区标题：撑满行宽以展示右侧渐隐细线 */
  .section-title {
    width: 100%;
  }
}

.members-skeleton {
  padding: var(--tabbar-offset-top) 16px 8px;
}

.member-count {
  margin-left: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.member-list {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
}

.member-card.clickable {
  cursor: pointer;
}

.member-card {
  position: relative;

  .avatar {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 4;
  }

  .avatar-ph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--el-text-color-placeholder);
    background: var(--el-fill-color-light);
  }

  /* 排名皇冠徽章：头像右上角，数字内嵌皇冠中。
   * 与快捷屏蔽按钮同占一个角：悬浮时让位给按钮，卡片屏蔽后不再显示排名装饰 */
  .rank-crown {
    position: absolute;
    top: 0px;
    right: 0px;
    z-index: 2;
    display: inline-flex;
    pointer-events: none;
    transition: opacity 0.15s ease;

    &__svg {
      width: 46px;
      height: 34px;
      color: #ffc53d;
      fill: #ffc53d;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
    }

    /* 排名数字：叠加在皇冠图形内部偏下的位置 */
    &__num {
      position: absolute;
      left: 50%;
      bottom: 8px;
      transform: translateX(-50%);
      padding: 0 1px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 800;
      line-height: 1.3;
      text-align: center;
      color: #fff;
      text-shadow: 0 0 2px rgba(255, 231, 158, 0.8);
    }
  }

  .member-meta {
    padding: 8px 10px 10px;
    text-align: center;

    p {
      margin: 0;
    }
  }

  .member-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  /* 快捷屏蔽：悬浮卡片时右上角出现 */
  .quick-block {
    position: absolute;
    top: 6px;
    right: 6px;
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
      color 0.15s ease;

    &:hover {
      color: var(--el-color-danger);
      transform: scale(1.05);
    }
  }

  &:hover .quick-block {
    opacity: 1;
    transform: scale(1);
  }

  &:hover .rank-crown {
    opacity: 0;
  }

  /* 已屏蔽：头像去色弱化，排名装饰让位给状态标记 */
  &.is-blocked {
    .avatar {
      filter: grayscale(1);
      opacity: 0.55;
    }

    .rank-crown {
      display: none;
    }
  }

  .blocked-flag {
    position: absolute;
    top: 6px;
    right: 6px;
    display: inline-flex;
    gap: 3px;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.6;
    color: #fff;
    background: var(--el-color-danger);
    opacity: 0.92;
  }

  .unblock-btn {
    position: absolute;
    bottom: 50px;
    left: 50%;
    display: inline-flex;
    gap: 4px;
    align-items: center;
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.55);
    border-radius: 999px;
    font-family: inherit;
    font-size: 12px;
    color: #fff;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transform: translateX(-50%) translateY(4px);
    transition:
      opacity 0.18s ease,
      transform 0.18s ease,
      background 0.18s ease;

    &:hover {
      background: var(--el-color-danger);
    }
  }

  &:hover .unblock-btn {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(-50%) translateY(0);
  }
}

/* 空态：样式见全局 .page-empty（竖直留白，视觉上与浮动切换器保持对称） */
</style>
