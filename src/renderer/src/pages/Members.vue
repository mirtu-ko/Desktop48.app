<script setup lang="ts">
import type { MemberSection } from '@renderer/utils/member-list'
import type { MemberDetail } from '@renderer/utils/member-merge'
import type { SortKey } from '@renderer/utils/member-sort'
import { Close, Grid, Menu } from '@element-plus/icons-vue'
import MemberCard from '@renderer/components/member/MemberCard.vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import MemberDetailCard from '@renderer/components/ui/MemberDetailCard.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberActions } from '@renderer/composables/use-member-actions'
import { useMemberSections } from '@renderer/composables/use-member-sections'
import { useMemberSync } from '@renderer/composables/use-member-sync'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { useMemberTreeStore } from '@renderer/stores/member-tree'
import Constants from '@renderer/utils/constants'
import { memberCardKey } from '@renderer/utils/member-list'
import { buildAdjuncts, mergeMembers } from '@renderer/utils/member-merge'
import { SORT_OPTIONS } from '@renderer/utils/member-sort'
import { useEventListener } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import { computed, onActivated, onDeactivated, onMounted, ref } from 'vue'

/** 成员库页面：分团 tab + 工具条 + 分区卡片网格 + 详情抽屉。本文件只留布局与交互 */

/** 顶部 tab：5 个分团 + 末尾「成员库」。key 一律是 groupId，与公演页共用 Constants.GroupTabs */
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

// ===== 搜索 =====

const keyword = ref('')
const searchInputRef = ref<HTMLInputElement>()
const searchFocused = ref(false)

function clearKeyword() {
  keyword.value = ''
  searchInputRef.value?.focus()
}

// ===== 排序 / 密度 =====

const sortKey = ref<SortKey>('default')

/** 卡片密度偏好：纯展示偏好，落 localStorage 而非 app-config（不值得为此走 IPC） */
const DENSITY_STORAGE_KEY = 'members:density'
const compact = ref(readDensity())

function readDensity(): boolean {
  try {
    return localStorage.getItem(DENSITY_STORAGE_KEY) === 'compact'
  }
  catch {
    // 存储不可用（隐私模式等）时按默认密度走
    return false
  }
}

function setCompact(value: boolean) {
  compact.value = value
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, value ? 'compact' : 'comfortable')
  }
  catch {
    // 写不进去就退化成「本次会话内生效」，不影响功能
  }
}

// ===== 分区派生 =====

/** 过滤 → 分组 → 分区内排序 → 计数，规则见 composables/use-member-sections.ts */
const { normalizedKeyword, sections, activeCount, inactiveCount, memberCount } = useMemberSections({
  members,
  activeKey,
  isLibrary,
  keyword,
  sortKey,
})

/** 工具条 / 列表末尾共用的计数文案：搜索中改说「命中」，避免和总人数混淆 */
const countText = computed(() => {
  if (normalizedKeyword.value)
    return `命中 ${memberCount.value} 人`
  return isLibrary.value
    ? `在团 ${activeCount.value} 人 · 离团 ${inactiveCount.value} 人`
    : `在团 ${activeCount.value} 人`
})

const emptyText = computed(() => normalizedKeyword.value ? '没有匹配的成员' : '暂无成员信息')

// 首次/切换后无成员数据时展示骨架；已有数据刷新不整页遮罩
const showSkeleton = computed(() => loading.value && members.value.length === 0)

// ===== 详情卡片的 ↑ / ↓ 切换 =====

/** 按当前可见顺序（分区顺序 + 分区内排序）铺平成一条链，切成员不跳出当前 tab / 搜索结果 */
const visibleMembers = computed(() => sections.value.flatMap(section => section.members))

/** 用 memberCardKey 而非 userId 定位：兼任记录与本人共用 userId，只有它能区分两张卡 */
const selectedIndex = computed(() => {
  const current = selectedMember.value
  if (!current)
    return -1
  const key = memberCardKey(current)
  return visibleMembers.value.findIndex(member => memberCardKey(member) === key)
})

const hasPrevMember = computed(() => selectedIndex.value > 0)
const hasNextMember = computed(() =>
  selectedIndex.value >= 0 && selectedIndex.value < visibleMembers.value.length - 1,
)

function stepMember(delta: number) {
  const next = visibleMembers.value[selectedIndex.value + delta]
  if (next)
    selectedMember.value = next
}

onMounted(() => {
  fetchMembers()
  refreshBlockedMembers()
  refreshFollowedMembers()
})

/** 拉取两个数据源并合并（挂载初始化 / 双击 tab / 更新数据库后共用）。成员树走 stores/member-tree 的缓存；
 * 兼任成员由 buildAdjuncts 以本人档案为底座并入其兼任队伍 */
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

// ===== 分区展示派生 =====

/** 分区内联变量：队色贯穿分区底、标题药丸、人数徽章 */
function sectionStyle(section: MemberSection) {
  return section.accent ? { '--sec-accent': section.accent } : undefined
}

/** 分区标题左侧图标：优先队伍徽章，退分团官方 logoPng（groupLogo 有 GroupLogoFallback 兜底，恒非空） */
function badgeSrc(section: MemberSection) {
  return section.teamBadge || section.groupLogo
}

// ===== 快捷键：/ 聚焦搜索，Esc 清空并失焦 =====
// 页面被 keep-alive 缓存，失活实例不应再响应按键
const keyboardEnabled = ref(true)

onActivated(() => {
  keyboardEnabled.value = true
})
onDeactivated(() => {
  keyboardEnabled.value = false
})

function onKeydown(event: KeyboardEvent) {
  if (!keyboardEnabled.value)
    return
  // 抽屉 / 对话框打开时不抢按键（Esc 归弹层）
  if (document.querySelector('.el-overlay:not([style*="display: none"])'))
    return

  const target = event.target as HTMLElement | null
  const typing = !!target && (target.tagName === 'INPUT' || target.isContentEditable)

  if (event.key === '/' && !typing) {
    event.preventDefault()
    searchInputRef.value?.focus()
  }
  else if (event.key === 'Escape' && typing && keyword.value) {
    keyword.value = ''
    searchInputRef.value?.blur()
  }
}

useEventListener(window, 'keydown', onKeydown)
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮动分团切换：5 个分团 + 成员库；双击当前 tab 刷新列表 -->
    <FloatingTabBar :tabs="MEMBER_TABS" :active="activeKey" @change="changeTab" @refresh="fetchMembers" />

    <!-- 工具条：搜索 / 排序 / 密度 / 计数。放在滚动区之外，滚列表时不会把搜索框滚走 -->
    <div class="member-toolbar">
      <label class="search-box" :class="{ 'is-focused': searchFocused }">
        <MediaIcon name="search" :size="14" />
        <input
          ref="searchInputRef"
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="搜索姓名 / 昵称 / 拼音缩写"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
        >
        <button
          v-if="keyword"
          class="search-clear"
          type="button"
          title="清空搜索（Esc）"
          @click="clearKeyword"
        >
          <el-icon :size="13">
            <Close />
          </el-icon>
        </button>
      </label>

      <div class="segmented">
        <button
          v-for="option in SORT_OPTIONS"
          :key="option.key"
          class="segmented__item"
          :class="{ 'is-active': sortKey === option.key }"
          :title="option.title"
          type="button"
          @click="sortKey = option.key"
        >
          {{ option.label }}
        </button>
      </div>

      <div class="segmented segmented--icon">
        <button
          class="segmented__item"
          :class="{ 'is-active': !compact }"
          type="button"
          title="大卡"
          @click="setCompact(false)"
        >
          <el-icon :size="14">
            <Grid />
          </el-icon>
        </button>
        <button
          class="segmented__item"
          :class="{ 'is-active': compact }"
          type="button"
          title="紧凑"
          @click="setCompact(true)"
        >
          <el-icon :size="14">
            <Menu />
          </el-icon>
        </button>
      </div>

      <span class="toolbar-count">{{ countText }}</span>
    </div>

    <el-scrollbar class="scrollbar-wrapper">
      <CardSkeletonGrid
        v-if="showSkeleton"
        class="members-skeleton"
        :count="12"
        min-item-width="118px"
        gap="6px"
        aspect-ratio="1"
        media-radius="50%"
        :line-widths="[68, 44]"
      />
      <div v-else class="members-container">
        <!-- 分区：一层极淡的队色底 + 同色描边，让每支队伍自成一块，整页不再是一片白 -->
        <section
          v-for="section in sections"
          :key="section.key"
          class="group-section"
          :class="{ 'is-muted': section.muted }"
          :style="sectionStyle(section)"
        >
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
            >
              {{ section.title }}
              <span class="team-count">{{ section.members.length }}</span>
            </span>
          </h2>

          <!-- 卡片列表：TransitionGroup 负责排序 / 密度 / 搜索变化时的 FLIP 位移与错峰入场 -->
          <TransitionGroup name="card" tag="div" class="member-list" :class="{ 'is-compact': compact }">
            <!-- key 见 memberCardKey：兼任记录走档案主键，官网独有的补充成员走 sid 兜底 -->
            <MemberCard
              v-for="(member, index) in section.members"
              :key="memberCardKey(member)"
              :member="member"
              :index="index"
              :compact="compact"
              :keyword="keyword"
              :blocked="!!member.userId && isBlocked(member.userId)"
              :followed="!!member.userId && isFollowed(member.userId)"
              @select="selectedMember = member"
              @toggle-follow="toggleFollowMember"
              @toggle-block="toggleBlockMember"
            />
          </TransitionGroup>
        </section>

        <el-empty
          v-if="!loading && memberCount === 0"
          class="page-empty"
          :image-size="120"
          :description="emptyText"
        >
          <el-button v-if="normalizedKeyword" type="primary" @click="clearKeyword">
            清空搜索
          </el-button>
        </el-empty>
      </div>
      <div v-if="memberCount > 0" class="list-end">
        {{ countText }}
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

    <!-- 成员详情卡片：两个数据源合并后的同一个详情页 -->
    <MemberDetailCard
      :member="selectedMember"
      :blocked="!!selectedMember?.userId && isBlocked(selectedMember.userId)"
      :followed="!!selectedMember?.userId && isFollowed(selectedMember.userId)"
      :has-prev="hasPrevMember"
      :has-next="hasNextMember"
      @close="selectedMember = null"
      @prev="stepMember(-1)"
      @next="stepMember(1)"
      @toggle-block="toggleBlockMember"
      @toggle-follow="toggleFollowMember"
    />
  </div>
</template>

<style scoped lang="scss">
/* 页面骨架：全局 .page-root 给了相对定位 + 裁剪，这里改成纵向两段
 * （常驻工具条 + 滚动区），浮动 tab 栏 / 工具条仍是绝对定位，不参与这两段 */
.page-root {
  display: flex;
  flex-direction: column;
}

/* ===== 工具条 ===== */
.member-toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  /* 顶部让开左上角浮动切换器（--tabbar-offset-top） */
  margin-top: var(--tabbar-offset-top);
  padding: 0 16px 10px;
}

.search-box {
  flex: 1 1 200px;
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  max-width: 320px;
  height: 34px;
  padding: 0 10px 0 12px;
  border-radius: var(--radius-pill);
  color: var(--el-text-color-placeholder);
  background: var(--el-bg-color);
  box-shadow: inset 0 0 0 1px var(--el-border-color-light);
  cursor: text;
  transition:
    box-shadow 0.2s ease,
    background-color 0.2s ease;

  /* 聚焦反馈走自绘描边（全局已隐藏 outline） */
  &.is-focused {
    color: var(--brand-primary);
    box-shadow:
      inset 0 0 0 1px rgba(var(--brand-rgb), 0.55),
      0 0 0 3px rgba(var(--brand-rgb), 0.12);
  }
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  font-family: inherit;
  font-size: 13px;
  color: var(--el-text-color-primary);
  background: transparent;

  &::placeholder {
    color: var(--el-text-color-placeholder);
  }
}

.search-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;

  &:hover {
    color: #fff;
    background: var(--el-color-danger);
  }
}

/* 分段控件：排序 / 密度共用 */
.segmented {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--el-bg-color);
  box-shadow: inset 0 0 0 1px var(--el-border-color-light);

  &--icon .segmented__item {
    width: 30px;
    padding: 0;
  }

  &__item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0 12px;
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

    &:hover {
      color: var(--brand-primary-dark);
      background: rgba(var(--brand-rgb), 0.1);
    }

    &.is-active {
      color: #fff;
      font-weight: 600;
      background: var(--gradient-brand);
      box-shadow: var(--shadow-glow);
    }
  }
}

.toolbar-count {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* ===== 滚动区 ===== */
.scrollbar-wrapper {
  flex: 1;
  min-height: 0;
  /* 全局 .scrollbar-wrapper 是 height:100%，在纵向 flex 里会溢出，改由 flex 决定高度 */
  height: auto;
}

.members-container {
  /* 顶部留白由工具条承担，这里只留内容间距；底部留卡片悬停上浮与阴影 */
  padding: 6px 16px 8px;
}

.members-skeleton {
  padding: 6px 16px 8px;

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

/* ===== 分区：队色底 + 同色描边 =====
 * 底色平铺：标题条比它深一档当分区头，平铺时两者的分界最干净 */
.group-section {
  --sec-accent: var(--brand-primary);

  padding: 10px 14px 14px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--sec-accent) 5%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sec-accent) 14%, transparent);

  & + .group-section {
    margin-top: 14px;
  }

  /* 暂休 / 退团：没有队伍色，退成中性灰底，不与在团队伍抢注意力 */
  &.is-muted {
    --sec-accent: var(--el-text-color-secondary);

    background: var(--el-fill-color-lighter);
    box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  }
}

/* 分区标题：队伍徽章 + 队名 + 人数徽章 + 队色渐隐线，兼作分区的头部色带 */
.team-title {
  display: flex;
  gap: 12px;
  align-items: center;
  /* 负外边距抵消分区的内边距：标题条铺满分区整宽 */
  margin: -10px -14px 10px;
  padding: 10px 16px;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  /* 比分区底色深一档，形成分区头 */
  background: color-mix(in srgb, var(--sec-accent) 11%, var(--el-bg-color));
  /* 描边跟着标题走一圈，否则分区外框的顶边会被标题条盖掉、只余下三边 */
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sec-accent) 14%, transparent);

  /* 统一尺寸的徽章盒子：图标等比缩放入内（图标恒有值，见 badgeSrc / GroupLogoFallback） */
  .team-badge-box {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;

    .team-badge-img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
    }
  }

  /* 复用全局分区标题（队色药丸），撑满剩余宽度；
     头部条自带底色与描边，尾部渐隐线与其重复，隐藏 */
  .section-title {
    flex: 1;
    min-width: 0;
    margin: 0;

    &::after {
      display: none;
    }
  }
}

/* 暂休 / 退团分区：标题条跟随分区退成中性灰 */
.group-section.is-muted .team-title {
  background: var(--el-fill-color-light);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
}

.team-count {
  flex: none;
  padding: 1px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.7;
  color: color-mix(in srgb, var(--sec-accent) 62%, #24223a);
  background: color-mix(in srgb, var(--sec-accent) 16%, var(--el-bg-color));
  font-variant-numeric: tabular-nums;
}

/* ===== 卡片列表网格（卡片自身的样式见 components/member/MemberCard.vue） ===== */
.member-list {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));

  /* 紧凑档：列更窄；头像与文案的收小由 MemberCard 的 compact prop 负责 */
  &.is-compact {
    gap: 4px;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }
}

/* ===== 列表过渡：卡片平滑归位（TransitionGroup 打在子组件根节点上，父级 scope 照样命中） ===== */
.card-enter-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  /* 错峰入场：--i 由卡片内联注入，封顶 16 免得长列表要等太久 */
  transition-delay: calc(var(--i, 0) * 14ms);
}

.card-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.96);
}

/* FLIP：位置变化的卡片滑到新位置，而不是瞬移 */
.card-move {
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

/* 离场不做过场：搜索过滤时可能整屏一起消失，留在网格里会拖出一片幽灵 */
.card-leave-active {
  transition: none;
}

/* 空态：样式见全局 .page-empty（竖直留白，视觉上与浮动切换器保持对称） */

/* 系统「减少动态效果」下关掉本页的装饰性动画（卡片自身的见 MemberCard.vue） */
@media (prefers-reduced-motion: reduce) {
  .card-enter-active,
  .card-move,
  .segmented__item {
    transition: none;
  }
}
</style>
