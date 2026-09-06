<script setup lang="ts">
import type { MemberDetail } from '../components/ui/MemberDetailDrawer.vue'
import { Hide, User, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import FloatingRefreshDock from '../components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '../components/ui/FloatingTabBar.vue'
import MemberDetailDrawer from '../components/ui/MemberDetailDrawer.vue'
import { useBlockedMembers } from '../composables/data/use-blocked-members'
import { useMemberSync } from '../composables/data/use-member-sync'
import Constants from '../utils/constants'
import Tools from '../utils/tools'

/** 成员树：分团 → 队伍 → 成员（getMemberTree 返回结构） */
interface TeamNode {
  teamName: string
  /** 队伍徽章（seineTeamBadge，可能是相对路径，展示前需归一化） */
  teamBadge?: string
  children: MemberDetail[]
}

interface GroupNode {
  groupName: string
  /** 主进程树节点里可能是字符串 id 或缺省，比较时统一 String() 归一化 */
  groupId: number | string | undefined
  children: TeamNode[]
}

const loading = ref(true)
const groups = ref<GroupNode[]>([])

/** 当前分团 groupId：取值见 Constants.GroupTabs（'0'=全部） */
const groupId = ref('0')

/** 左上角分团切换 tab 选项（与公演页共用同一份分团配置 Constants.GroupTabs） */
const groupTabs = Constants.GroupTabs

/** 成员状态（starInfo.status）取值收口见 Constants.MemberStatus（与详情抽屉/回放页共用） */
const { Active: STATUS_ACTIVE, Hiatus: STATUS_HIATUS, Left: STATUS_LEFT } = Constants.MemberStatus

interface MemberSection {
  title: string
  teamBadge: string
  /** 分区标题主题色：跟随队伍 teamColor；暂休/退团走弱化灰变体 */
  accent?: string
  muted?: boolean
  members: MemberDetail[]
}

/** 头像相对路径归一化 */
function normalizeMember(member: MemberDetail): MemberDetail {
  return { ...member, avatar: member.avatar ? Tools.sourceUrl(member.avatar) : '' }
}

/** 徽章加载失败时隐藏，避免显示碎图 */
function hideBadge(event: Event) {
  (event.target as HTMLImageElement).style.visibility = 'hidden'
}

/** 当前查看详情的成员（null = 抽屉关闭） */
const selectedMember = ref<MemberDetail | null>(null)

/** 屏蔽名单：模块级共享状态，机制见 use-blocked-members.ts */
const { refreshBlockedMembers, isBlocked, toggleBlock } = useBlockedMembers()

/** API 把“明星殿堂”建模成独立分团（groupId 19），展示上并入 SNH48 的同名队伍 */
const HALL_GROUP_NAME = '明星殿堂'
const HALL_HOST_GROUP_NAME = 'SNH48'

/** 展示分节：分团队伍只收在团成员（status=1），末尾追加 暂休（status=2）/ 退团（status=3），均受分团筛选影响 */
const sections = computed<MemberSection[]>(() => {
  const hall = groups.value.find(group => group.groupName === HALL_GROUP_NAME)
  // 纯展示层合并：不改原树，避免副作用（回放筛选、屏蔽成员仍用原结构）
  const merged = groups.value
    .filter(group => group.groupName !== HALL_GROUP_NAME)
    .map((group) => {
      if (!hall || group.groupName !== HALL_HOST_GROUP_NAME) {
        return group
      }
      const children = [...group.children]
      for (const team of hall.children) {
        const index = children.findIndex(item => item.teamName === team.teamName)
        if (index >= 0) {
          children[index] = {
            ...children[index],
            children: [...children[index].children, ...team.children],
          }
        }
        else {
          children.push(team)
        }
      }
      return { ...group, children }
    })

  const list = merged.filter(
    group => groupId.value === '0' || String(group.groupId) === groupId.value,
  )
  const collect = (status: number) =>
    list.flatMap(group =>
      group.children.flatMap(team =>
        team.children.filter(member => member.status === status).map(normalizeMember),
      ),
    )

  const result: MemberSection[] = []
  for (const group of list) {
    for (const team of group.children) {
      const members = team.children
        .filter(member => member.status === STATUS_ACTIVE)
        .map(normalizeMember)
      if (members.length) {
        // 队伍主题色：取队伍内任一成员的 teamColor（与成员卡片徽章同源）
        const teamColor = team.children.find(member => member.teamColor)?.teamColor || ''
        result.push({
          title: groupId.value === '0' ? `${group.groupName} · ${team.teamName}` : team.teamName,
          teamBadge: team.teamBadge ? Tools.sourceUrl(team.teamBadge) : '',
          accent: teamColor ? `#${teamColor}` : '',
          members,
        })
      }
    }
  }
  const hiatus = collect(STATUS_HIATUS)
  if (hiatus.length) {
    result.push({ title: '暂休', teamBadge: '', muted: true, members: hiatus })
  }
  const left = collect(STATUS_LEFT)
  if (left.length) {
    result.push({ title: '退团', teamBadge: '', muted: true, members: left })
  }
  return result
})

/** 当前筛选下的成员总数（用于空态判断） */
const memberCount = computed(() =>
  sections.value.reduce((sum, section) => sum + section.members.length, 0),
)
const activeCount = computed(() => sections.value.filter(section => !section.muted).reduce((sum, section) => sum + section.members.length, 0))
const inactiveCount = computed(() => sections.value.filter(section => section.muted).reduce((sum, section) => sum + section.members.length, 0))

onMounted(() => {
  fetchGroups()
  refreshBlockedMembers()
})

/** 拉取成员树（挂载初始化 / 双击分团 tab 刷新共用） */
async function fetchGroups() {
  loading.value = true
  try {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts（成员树是主进程内存派生，不落盘）
    groups.value = (await window.mainAPI.getMemberTree()) || []
  }
  catch (error) {
    console.error('获取成员信息失败:', error)
    ElMessage.error('获取成员信息失败，请稍后重试')
  }
  finally {
    loading.value = false
  }
}

/** 成员同步：loading 态与接口调用收口在 use-member-sync.ts（与首页的启动兜底共用一份逻辑） */
const { isSyncing, syncMembers } = useMemberSync()

/** 更新成员数据库：从接口同步最新名单，成功后刷新本页 */
async function updateMembers() {
  const ok = await syncMembers()
  if (ok) {
    await fetchGroups()
  }
}
</script>

<template>
  <div
    v-loading="loading"
    class="page-root"
  >
    <!-- 左上角浮动分团切换：与公演页同一套交互；双击当前分团刷新成员数据 -->
    <FloatingTabBar :tabs="groupTabs" :active="groupId" @change="groupId = $event" @refresh="fetchGroups" />
    <div class="page-root">
      <el-scrollbar class="scrollbar-wrapper">
        <div class="members-container">
          <section v-for="section in sections" :key="section.title" class="group-section">
            <h2 class="team-title">
              <img
                v-if="section.teamBadge"
                class="team-badge-img"
                :src="Tools.sourceUrl(section.teamBadge)"
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
              <div
                v-for="member in section.members"
                :key="member.userId"
                class="member-card lift-card clickable"
                :class="{ 'is-blocked': isBlocked(member.userId) }"
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

                <!-- 未屏蔽：悬浮卡片时右上角快捷屏蔽 -->
                <button
                  v-if="!isBlocked(member.userId)"
                  class="quick-block"
                  title="屏蔽 TA 的直播与回放"
                  @click.stop="toggleBlock(member)"
                >
                  <el-icon :size="13">
                    <Hide />
                  </el-icon>
                </button>

                <!-- 已屏蔽：状态标记 + 悬浮解除按钮 -->
                <template v-else>
                  <span class="blocked-flag">
                    <el-icon :size="12">
                      <Hide />
                    </el-icon>
                    已屏蔽
                  </span>
                  <button class="unblock-btn" @click.stop="toggleBlock(member)">
                    <el-icon :size="13">
                      <View />
                    </el-icon>
                    解除屏蔽
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
        <div class="list-end">
          在团共 {{ activeCount }} 人，离团 {{ inactiveCount }} 人
        </div>
      </el-scrollbar>
    </div>

    <!-- 右上角浮动操作条：更新成员数据库 -->
    <FloatingRefreshDock
      :loading="isSyncing"
      title="更新成员数据库"
      @refresh="updateMembers"
    >
      <span class="member-count">更新成员数据库</span>
    </FloatingRefreshDock>

    <!-- 成员详情抽屉 -->
    <MemberDetailDrawer
      :member="selectedMember"
      :blocked="selectedMember ? isBlocked(selectedMember.userId) : false"
      @close="selectedMember = null"
      @toggle-block="toggleBlock"
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

  /* 已屏蔽：头像去色弱化 */
  &.is-blocked .avatar {
    filter: grayscale(1);
    opacity: 0.55;
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
