<script setup lang="ts">
import type { MemberTreeGroupPayload } from '@preload/ipc-contract'
import type { LiveListItemView } from '@renderer/services/api-types'
import FollowedMemberRail from '@renderer/components/playback/FollowedMemberRail.vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import LiveTabBar from '@renderer/components/ui/LiveTabBar.vue'
import MemberDetailCard from '@renderer/components/ui/MemberDetailCard.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useFollowedMemberEntries } from '@renderer/composables/use-followed-member-entries'
import { useMemberDetail } from '@renderer/composables/use-member-detail'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/use-paged-live-list'
import Apis from '@renderer/services/apis'
import EventBus from '@renderer/services/event-bus'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { useMemberTreeStore } from '@renderer/stores/member-tree'
import Constants from '@renderer/utils/constants'
import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

// 组件 props：成员详情「看 TA 的回放」跳转时预置的成员筛选；每次跳转都是新对象，保证 watch 必触发
const props = withDefaults(defineProps<{ memberPreset?: { userId: string } | null }>(), {
  memberPreset: null,
})

const route = useRoute()

// 独立播放窗：回放播放挂载点与直播共用同一套
const { openPlayback } = useFloatPlayersStore()

// 成员树（筛选器选项来源）走全局单例 store：与成员页共用同一份，
// 同步完成 / 增删成员后由 store 统一作废重拉，本页无需订阅事件
const { memberTree, loadTree } = useMemberTreeStore()

// 关注名单：与成员页 / 直播 tab 共用同一份（模块级单例），回放卡片据此打关注标识。
// 回放是历史归档、且列表常带成员筛选，故只做标识不重排（重排会打乱时间倒序与筛选语义）
const { refreshFollowedMembers, isFollowed } = useFollowedMembersStore()

// 快速筛选条的头像条目：昵称 / 头像 / 队色由关注名单经成员名录反查得到
const { entries: followedEntries } = useFollowedMemberEntries()

// 成员详情卡片：点卡片上的成员名打开，详情按 userId 反查（数据源见 stores/member-directory）
const {
  selectedMember,
  detailFollowed,
  detailBlocked,
  openMemberDetail,
  closeMemberDetail,
  toggleFollowMember,
  toggleBlockMember,
} = useMemberDetail()

/** 级联筛选器选项：由共享成员树派生（在团成员排前），树更新后自动重算 */
const memberOption = computed(() => sortMembersByStatus(memberTree.value))

// 级联筛选选中的路径：[groupId] / [groupId, teamId] / [groupId, teamId, userId]
const selectedFilter = ref<any[]>([])

/**
 * 快速筛选的旁路：只在成员树里查不到该账号（官方号 / 成员资料未同步）时使用。
 * 这种情况级联里没有对应层级，只能直接按 userId 请求；能与级联对上的一律走 selectedFilter，
 * 保证头像条与右上角筛选器始终是同一个状态。
 */
const quickMemberId = ref<string | null>(null)

/** 当前生效的快速筛选成员：级联选到成员层同样算（两处共用一个筛选轴） */
const activeQuickUserId = computed(() => {
  if (quickMemberId.value)
    return quickMemberId.value
  const path = selectedFilter.value || []
  return path.length === 3 ? String(path[2]) : null
})

// 列表滚动容器：绑给模板，并交给 usePagedLiveList 做回顶与触底判定
const playbackScrollRef = ref<any>(null)

// 分页状态与触底加载：见 composables/use-paged-live-list.ts（直播/回放共用）
const {
  list: playbackList,
  loading,
  noMore,
  onInfiniteScroll,
  refresh,
  refreshFromTop,
} = usePagedLiveList({
  scrollbarRef: playbackScrollRef,
  // 只发送被选中层级的对应参数，未选中层级保持 '0'
  loadPage: (next) => {
    const params: {
      userId: string
      teamId: string
      groupId: string
      next: string
    } = {
      userId: '0',
      teamId: '0',
      groupId: '0',
      next,
    }
    // 快速筛选的旁路优先：它生效时级联一定已被清空（见 selectQuickMember）
    if (quickMemberId.value) {
      params.userId = quickMemberId.value
      return Apis.playbackList(params)
    }
    const [groupId, teamId, userId] = selectedFilter.value || []
    if (userId != null)
      params.userId = String(userId)
    else if (teamId != null)
      params.teamId = String(teamId)
    else if (groupId != null)
      params.groupId = String(groupId)
    return Apis.playbackList(params)
  },
  // 封面/日期/成员信息补全：与直播页共用 enrichLiveItem；
  // 成员查询失败直接抛出，由 stopOnError 接管整批停止
  processItem: item => enrichLiveItem(item),
  stopOnError: true,
})

// 首屏/筛选刷新后列表为空时显示骨架屏；已有列表时刷新只反馈到右上角 dock
const showSkeleton = computed(() => loading.value && playbackList.value.length === 0)

// 空态文案区分「真的没有回放」与「筛的这个人没有回放」
const emptyText = computed(() => (activeQuickUserId.value ? '该成员暂无回放' : '暂无回放'))

const whitespaceRegex = /\s+/g

function filterMethod(node: any, keyword: string) {
  const label = node.text || node.label
  const pinyin = node.data?.pinyin?.replace(whitespaceRegex, '') || ''
  const abbr = node.data?.abbr?.replace(whitespaceRegex, '') || ''
  const searchText = keyword.toLowerCase()
  return (
    (label && label.toLowerCase().includes(searchText))
    || (pinyin && pinyin.toLowerCase().includes(searchText))
    || (abbr && abbr.toLowerCase().includes(searchText))
  )
}

// 只刷新当前可见列表
function onLivesRefresh() {
  if (route.path === '/lives/playbacks')
    refreshFromTop()
}

// 初始化
onMounted(async () => {
  // 双击 Dock 后由可见页刷新
  EventBus.on('lives-refresh', onLivesRefresh)

  // 关注名单与列表互不依赖：并行拉取，失败不影响列表本身
  refreshFollowedMembers()
  // 成员树仅用于筛选器选项，失败不应阻断回放列表本身
  try {
    await loadTree()
  }
  catch (error) {
    console.error('[Playbacks.vue]获取成员树失败:', error)
    ElMessage.error('成员筛选加载失败，请刷新页面重试')
  }
  // 先应用预置筛选再拉列表，避免挂载时重复请求
  if (!applyPreset())
    refresh()
})

/**
 * 末级成员排序：在团成员（status=Active）排在前，其余（暂休/退团）保持原有相对顺序排在后。
 * 纯派生、不改动入参 —— 树是 stores/member-tree 的单例缓存，就地排序会污染其他页面。
 */
function sortMembersByStatus(tree: MemberTreeGroupPayload[]): MemberTreeGroupPayload[] {
  return (tree || []).map(group => ({
    ...group,
    children: (group.children || []).map(team => ({
      ...team,
      children: [...(team.children || [])].sort(
        (a, b) => Number(b.status === Constants.MemberStatus.Active) - Number(a.status === Constants.MemberStatus.Active),
      ),
    })),
  }))
}

/** 在成员树里按 userId 找到 [groupId, teamId, userId] 完整路径 */
function findFilterPath(userId: string): any[] | null {
  for (const group of memberOption.value) {
    for (const team of group.children || []) {
      for (const member of team.children || []) {
        if (member.value === userId)
          return [group.value, team.value, member.value]
      }
    }
  }
  return null
}

/** 预置筛选本次落空（成员刚同步进库、树里还查不到该 memberPreset）：树重载后据此重试 */
let presetPending = false

/** 应用预置筛选；返回是否实际应用（预置为空或树里找不到时返回 false） */
function applyPreset(): boolean {
  const userId = props.memberPreset?.userId
  if (!userId) {
    presetPending = false
    return false
  }
  const path = findFilterPath(userId)
  if (!path) {
    presetPending = true
    return false
  }
  presetPending = false
  if (JSON.stringify(selectedFilter.value) !== JSON.stringify(path)) {
    // 筛选变化：交给下方 selectedFilter 的 watch 自动刷新
    selectedFilter.value = path
  }
  else {
    // 筛选没变也要重新拉取：上次请求可能失败或返回为空
    refreshFromTop()
  }
  return true
}

// 成员页每次跳转（含同一成员连续跳转）都应用预置筛选
watch(() => props.memberPreset, applyPreset)

/**
 * 成员树更新后重试落空的预置筛选：新增成员刚同步进来时，跳转与重载谁先到不确定，
 * 先到的那次会在树里找不到人（applyPreset 返回 false），必须等树到了再补一次。
 * 只在真正落空时重试，避免挂载时白白多拉一次列表。
 */
watch(memberOption, () => {
  if (presetPending)
    applyPreset()
})

/**
 * 点关注头像：同一成员再次点击取消筛选，换人则直接切到新成员。
 *
 * 成员树里查得到的人落到级联筛选（头像条与右上角筛选器始终一致，刷新交给 watch）；
 * 查不到的（官方号 / 资料未同步）走 quickMemberId 旁路，同时把级联清空 ——
 * 两路同时生效会让人分不清列表到底按谁筛的。
 */
function selectQuickMember(userId: string) {
  if (activeQuickUserId.value === userId) {
    clearQuickFilter()
    return
  }
  const path = findFilterPath(userId)
  if (path) {
    quickMemberId.value = null
    selectedFilter.value = path
    return
  }
  quickMemberId.value = userId
  if ((selectedFilter.value?.length ?? 0) > 0)
    selectedFilter.value = []
  else
    refreshFromTop()
}

/** 取消快速筛选：两路筛选一起清空，回到全部回放 */
function clearQuickFilter() {
  quickMemberId.value = null
  if ((selectedFilter.value?.length ?? 0) > 0)
    selectedFilter.value = []
  else
    refreshFromTop()
}

/** 用户改级联筛选 = 改用了筛选器：旁路让位，否则它会盖过新选择（见 loadPage 的优先级） */
function onFilterPickerChange() {
  quickMemberId.value = null
}

// 点击回放：以独立播放窗打开，可边看边继续浏览列表
function onPlaybackClick(item: LiveListItemView) {
  openPlayback({
    liveId: item.liveId,
    nickname: item.userInfo.nickname,
    // title 接口不保证下发，缺失时用主播名兜底（播放窗标题栏需要非空）
    title: item.title || item.userInfo.nickname,
    startTime: Number.parseInt(item.ctime),
    // 列表项自带 liveType，建窗时即可判定电台（见 main/float-window.ts 的 openFloatWindow），
    // 不必等详情接口回来
    liveType: item.liveType ?? 1,
  })
}

onUnmounted(() => {
  EventBus.off('lives-refresh', onLivesRefresh)
})

// 筛选内容变化（选中或清空）时自动触发查询，无需手动点刷新
watch(selectedFilter, () => {
  refreshFromTop()
})
</script>

<template>
  <div class="page-root">
    <!-- 页首工具行：左 tab 栏独占一侧；关注条与筛选/刷新成组贴右，二者是同一件事的两个入口
         （挑人 → 看她的录播），所以挨在一起。关注条窄时先压缩自己，不挤右侧控件 -->
    <div class="page-toolbar">
      <LiveTabBar :floating="false" @refresh="refreshFromTop" />

      <div class="page-toolbar__trail">
        <!-- 关注成员快速筛选条：只在有关注成员时出现，点头像只看她，再点一次取消；
             条目默认只列在役成员，暂休 / 退团 / 荣誉毕业生收在「+N」里 -->
        <FollowedMemberRail
          v-if="followedEntries.length"
          :members="followedEntries"
          :active-user-id="activeQuickUserId"
          @select="selectQuickMember"
        />

        <FloatingRefreshDock
          :floating="false"
          :loading="loading" title="刷新" @refresh="refreshFromTop"
        >
          <el-cascader
            v-model="selectedFilter"
            style="width: 240px" transfer
            clearable placeholder="请选择团体/队伍/成员"
            filterable :filter-method="filterMethod" :options="memberOption" :props="{
              label: 'label',
              value: 'value',
              children: 'children',
              checkStrictly: true,
              checkOnClickNode: true,
              emitPath: true,
              multiple: false,
              expandTrigger: 'hover',
              lazy: false,
            }"
            @change="onFilterPickerChange"
          />
        </FloatingRefreshDock>
      </div>
    </div>

    <el-scrollbar
      ref="playbackScrollRef"
      class="scrollbar-wrapper"
      :distance="10"
      @end-reached="onInfiniteScroll"
    >
      <CardSkeletonGrid
        v-if="showSkeleton"
        class="playback-skeleton"
      />
      <div v-else-if="playbackList.length === 0 && !loading" class="empty-block">
        {{ emptyText }}
      </div>
      <div v-else class="card-grid">
        <div
          v-for="item in playbackList" :key="item.liveId" class="playback-item"
          @click="onPlaybackClick(item)"
        >
          <LiveItem
            :item="item"
            class="live-card"
            :followed="isFollowed(item.userInfo.userId)"
            @select-member="openMemberDetail"
          />
        </div>
      </div>
      <div v-if="noMore && playbackList.length > 0" class="list-end">
        没有更多回放了
      </div>
    </el-scrollbar>

    <!-- 成员详情卡片：与成员页共用同一份合并详情（点成员名打开） -->
    <MemberDetailCard
      :member="selectedMember"
      :blocked="detailBlocked"
      :followed="detailFollowed"
      @close="closeMemberDetail"
      @toggle-block="toggleBlockMember"
      @toggle-follow="toggleFollowMember"
    />
  </div>
</template>

<style scoped lang="scss">
/* 页首工具行：三条浮层并排一行，高度与原先各自浮动时一致。
 * 容器本身不接收点击（中间空白处留给内容），只有胶囊可点 */
.page-toolbar {
  position: absolute;
  top: 12px;
  left: 6px;
  right: 8px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
}

/* 关注条 + 筛选/刷新：成组贴右。间距比工具行主间距略小，
 * 读起来是「同组」，而 tab 栏与它们之间仍留出分组的距离 */
.page-toolbar__trail {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
}

/* 筛选控件不压缩，避免窄窗口下按钮被挤掉文案 */
:deep(.el-button) {
  flex-shrink: 0;
}

/* 筛选控件：圆角化、弱化生硬边框，与胶囊标签呼应 */
:deep(.el-select__wrapper),
:deep(.el-cascader .el-input__wrapper) {
  border-radius: var(--radius-lg);
  background-color: color-mix(in srgb, var(--el-bg-color) 72%, transparent);
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
  transition:
    box-shadow 0.2s ease,
    background-color 0.2s ease;

  &:hover {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 55%, transparent) inset;
  }

  &.is-focused,
  &.is-focus {
    box-shadow: 0 0 0 1.5px var(--el-color-primary) inset;
  }
}

.playback-skeleton {
  padding: var(--page-pad);
}

.playback-item {
  cursor: pointer;
  min-width: 0;
}

/* 空态：样式见全局 .empty-block */
</style>
