<script setup lang="ts">
import type { MemberTreeGroupPayload } from '../../../preload/ipc-contract'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import MemberDetailDrawer from '@renderer/components/ui/MemberDetailDrawer.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberDetailDrawer } from '@renderer/composables/use-member-detail-drawer'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/use-paged-live-list'
import Apis from '@renderer/services/apis'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { useMemberTreeStore } from '@renderer/stores/member-tree'
import Constants from '@renderer/utils/constants'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'

// 组件 props：成员详情「看 TA 的回放」跳转时预置的成员筛选；每次跳转都是新对象，保证 watch 必触发
const props = withDefaults(defineProps<{ memberPreset?: { userId: string } | null }>(), {
  memberPreset: null,
})

// 独立播放窗：回放播放挂载点与直播共用同一套
const { openPlayback } = useFloatPlayersStore()

// 成员树（筛选器选项来源）走全局单例 store：与成员页共用同一份，
// 同步完成 / 增删成员后由 store 统一作废重拉，本页无需订阅事件
const { memberTree, loadTree } = useMemberTreeStore()

// 关注名单：与成员页 / 直播 tab 共用同一份（模块级单例），回放卡片据此打关注标识。
// 回放是历史归档、且列表常带成员筛选，故只做标识不重排（重排会打乱时间倒序与筛选语义）
const { refreshFollowedMembers, isFollowed } = useFollowedMembersStore()

// 成员详情抽屉：点卡片上的成员名打开，详情按 userId 反查（数据源见 stores/member-directory）
const {
  selectedMember,
  drawerFollowed,
  drawerBlocked,
  openMemberDetail,
  closeMemberDetail,
  toggleFollowMember,
  toggleBlockMember,
} = useMemberDetailDrawer()

/** 级联筛选器选项：由共享成员树派生（在团成员排前），树更新后自动重算 */
const memberOption = computed(() => sortMembersByStatus(memberTree.value))

// 级联筛选选中的路径：[groupId] / [groupId, teamId] / [groupId, teamId, userId]
const selectedFilter = ref<any[]>([])

// 分页状态与触底加载：见 composables/use-paged-live-list.ts（直播/回放共用）
const {
  list: playbackList,
  loading,
  noMore,
  scrollbarRef: playbackScrollRef,
  onInfiniteScroll,
  refresh,
} = usePagedLiveList({
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
    const [groupId, teamId, userId] = selectedFilter.value || []
    if (userId != null)
      params.userId = String(userId)
    else if (teamId != null)
      params.teamId = String(teamId)
    else if (groupId != null)
      params.groupId = String(groupId)
    return Apis.playbackList(params)
  },
  // 封面/队伍Logo/日期/成员信息补全：与直播页共用 enrichLiveItem；
  // 成员查询失败直接抛出，由 stopOnError 接管整批停止
  processItem: (item: any) => enrichLiveItem(item),
  stopOnError: true,
})

// 首屏/筛选刷新后列表为空时显示骨架屏；已有列表时刷新只反馈到右上角 dock
const showSkeleton = computed(() => loading.value && playbackList.value.length === 0)

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

// 初始化
onMounted(async () => {
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
    playbackScrollRef.value?.setScrollTop?.(0)
    refresh()
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

/** 供父组件（直播页双击「回放」tab）调用：回到顶部并刷新列表 */
function refreshFromTop() {
  playbackScrollRef.value?.setScrollTop?.(0)
  refresh()
}

defineExpose({ refreshFromTop })

// 点击回放：以独立播放窗打开，可边看边继续浏览列表
function onPlaybackClick(item: any) {
  openPlayback({
    liveId: item.liveId,
    nickname: item.userInfo.nickname,
    title: item.title,
    startTime: Number.parseInt(item.ctime),
    // 列表项自带 liveType，建窗时即可判定电台（见 main/float-window.ts 的 openFloatWindow），
    // 不必等详情接口回来
    liveType: item.liveType ?? 1,
  })
}

// 筛选内容变化（选中或清空）时自动触发查询，无需手动点刷新
watch(selectedFilter, () => {
  playbackScrollRef.value?.setScrollTop?.(0)
  refresh()
})
</script>

<template>
  <div class="page-root">
    <el-scrollbar
      ref="playbackScrollRef"
      class="scrollbar-wrapper"
      :distance="10"
      @end-reached="onInfiniteScroll"
    >
      <CardSkeletonGrid
        v-if="showSkeleton"
        class="playback-skeleton"
        :count="12"
        min-item-width="220px"
        gap="16px"
        aspect-ratio="1"
        :line-widths="[82, 56, 38]"
      />
      <div v-else-if="playbackList.length === 0 && !loading" class="empty-block">
        暂无回放
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

    <!-- 右上角浮动筛选/刷新工具条：不占行，内容滚过时呈现磨砂玻璃 -->
    <FloatingRefreshDock :loading="loading" title="刷新" @refresh="refresh">
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
      />
    </FloatingRefreshDock>

    <!-- 成员详情抽屉：与成员页共用同一份合并详情（点成员名打开） -->
    <MemberDetailDrawer
      :member="selectedMember"
      :blocked="drawerBlocked"
      :followed="drawerFollowed"
      @close="closeMemberDetail"
      @toggle-block="toggleBlockMember"
      @toggle-follow="toggleFollowMember"
    />
  </div>
</template>

<style scoped lang="scss">
/* 页面骨架（相对定位 + 裁剪）见模板上的全局 .page-root */

/* 筛选控件不压缩，避免窄窗口下按钮被挤掉文案 */
:deep(.el-select),
:deep(.filter-main),
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
