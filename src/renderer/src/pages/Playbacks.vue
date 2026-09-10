<script setup lang="ts">
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/data/use-paged-live-list'
import useFloatPlayers from '@renderer/composables/use-float-players'
import Apis from '@renderer/services/apis'
import Constants from '@renderer/utils/constants'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'

// 组件 props：成员详情「看 TA 的回放」跳转时预置的成员筛选；每次跳转都是新对象，保证 watch 必触发
const props = withDefaults(defineProps<{ memberPreset?: { userId: string } | null }>(), {
  memberPreset: null,
})

// 画中画迷你窗：回放播放挂载点与直播共用同一套
const { openPlayback } = useFloatPlayers()

const memberOption = ref<any[]>([])
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
    return Apis.instance().playbackList(params)
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
  // 成员树仅用于筛选器选项，失败不应阻断回放列表本身
  try {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    memberOption.value = sortMembersByStatus(await window.mainAPI.getMemberTree())
  }
  catch (error) {
    console.error('[Playbacks.vue]获取成员树失败:', error)
    ElMessage.error('成员筛选加载失败，请刷新页面重试')
  }
  // 先应用预置筛选再拉列表，避免挂载时重复请求
  if (!applyPreset())
    refresh()
})

/** 末级成员排序：在团成员（status=Active）排在前，其余（暂休/退团）保持原有相对顺序排在后 */
function sortMembersByStatus(tree: any[]): any[] {
  for (const group of tree || []) {
    for (const team of group.children || []) {
      team.children?.sort(
        (a: any, b: any) => Number(b.status === Constants.MemberStatus.Active) - Number(a.status === Constants.MemberStatus.Active),
      )
    }
  }
  return tree || []
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

/** 应用预置筛选；返回是否实际应用（预置为空或树里找不到时返回 false） */
function applyPreset(): boolean {
  const userId = props.memberPreset?.userId
  if (!userId)
    return false
  const path = findFilterPath(userId)
  if (!path)
    return false
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

/** 供父组件（直播页双击「回放」tab）调用：回到顶部并刷新列表 */
function refreshFromTop() {
  playbackScrollRef.value?.setScrollTop?.(0)
  refresh()
}

defineExpose({ refreshFromTop })

// 点击回放：以画中画迷你窗打开，可边看边继续浏览列表
function onPlaybackClick(item: any) {
  openPlayback({
    liveId: item.liveId,
    nickname: item.userInfo.nickname,
    title: item.title,
    startTime: Number.parseInt(item.ctime),
  })
}

// 筛选内容变化（选中或清空）时自动触发查询，无需手动点刷新
watch(selectedFilter, () => {
  playbackScrollRef.value?.setScrollTop?.(0)
  refresh()
})
</script>

<template>
  <div class="playbacks-root page-root">
    <div class="playback-container page-root">
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
        <div v-else class="playback-list">
          <div
            v-for="item in playbackList" :key="item.liveId" class="playback-item"
            @click="onPlaybackClick(item)"
          >
            <LiveItem :item="item" class="live-card" />
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
    </div>
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
  border-radius: 16px;
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
  padding: var(--tabbar-offset-top) 16px 8px;
}

.playback-list {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  /* 顶部留出左上角 tab 栏（--tabbar-offset-top），底留卡片悬停上浮与阴影的空间 */
  padding: var(--tabbar-offset-top) 16px 8px;
}

.playback-item {
  cursor: pointer;
  min-width: 0;
}

/* 空态：样式见全局 .empty-block */
</style>
