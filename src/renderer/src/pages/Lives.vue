<script setup lang="ts">
import type { LiveListItem } from '@renderer/services/api-types'
import { Film, VideoCamera } from '@element-plus/icons-vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import MemberDetailDrawer from '@renderer/components/ui/MemberDetailDrawer.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberDetailDrawer } from '@renderer/composables/use-member-detail-drawer'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/use-paged-live-list'
import Apis from '@renderer/services/apis'
import EventBus from '@renderer/services/event-bus'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useFollowedMembersStore } from '@renderer/stores/followed-members'
import { debugLog } from '@renderer/utils/debug'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Playbacks from './Playbacks.vue'

const route = useRoute()

// 画中画迷你窗：直播/回放/公演共用全局播放挂载点
const { openLive } = useFloatPlayersStore()

// 关注名单：模块级共享状态（与成员页共用同一份），直播列表页据此优先展示并加标识。
// 页面被 keep-alive 缓存（只挂载一次），跨页同步靠这份共享状态而不是重新挂载
const { followedMembers, refreshFollowedMembers, isFollowed } = useFollowedMembersStore()

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

// 顶部浮层 tab 当前选中的视图：live（直播）/ playback（回放）
const activeTab = ref<'live' | 'playback'>('live')
// 是否加载过回放面板，首次切换到回放时才渲染，避免进入页面即请求回放列表
const playbackMounted = ref(false)
// 成员详情「看 TA 的回放」预置筛选：每次跳转都新建对象，同一成员连续跳转也能触发 Playbacks 的 watch
const memberPreset = ref<{ userId: string } | null>(null)

const viewTabs = [
  { label: '直播', key: 'live', icon: VideoCamera },
  { label: '回放', key: 'playback', icon: Film },
]

function switchTab(tab: string) {
  if (tab === 'playback')
    playbackMounted.value = true
  activeTab.value = tab as 'live' | 'playback'
}

// 成员详情抽屉跳转（/lives?tab=playback&member=<userId>）：
// 切到回放面板并按该成员预置级联筛选，跳转语义由路由 query 承载
function applyMemberPlaybacksRoute(query: { tab?: string, member?: string }) {
  if (query.member) {
    memberPreset.value = { userId: String(query.member) }
    switchTab('playback')
  }
  else if (query.tab === 'playback') {
    switchTab('playback')
  }
}

// 双击当前 tab：直播 tab 刷新直播列表，回放 tab 转发给回放组件刷新
const playbackRef = ref<InstanceType<typeof Playbacks> | null>(null)

function onTabsRefresh() {
  if (activeTab.value === 'playback')
    playbackRef.value?.refreshFromTop()
  else
    refreshList()
}

// 分页状态与触底加载：见 composables/use-paged-live-list.ts（直播/回放共用）
const {
  list: liveList,
  loading,
  noMore,
  scrollbarRef: liveScrollRef,
  onInfiniteScroll,
  getList: getLiveList,
  refresh,
} = usePagedLiveList({
  loadPage: next => Apis.lives(next),
  // 封面/队伍Logo/日期/成员信息补全：与回放页共用 enrichLiveItem，成员查询失败逐条容错
  processItem: item => enrichLiveItem(item, 'fallback'),
  stopOnError: false,
})

/** enrichLiveItem 补全后的条目（cover/date/member 由 processItem 就地写入，渲染时必然就绪） */
type EnrichedLiveItem = LiveListItem & {
  cover: string[]
  date: string
  member: { teamName: string, teamColor: string } | null
}

// 首屏/刷新后列表为空时展示骨架屏；已有列表时刷新只反馈到刷新按钮，避免整页蒙层闪烁
const showSkeleton = computed(() => loading.value && liveList.value.length === 0)
/** 手动刷新递增，让同一封面的失败图也强制重新请求 */
const imageVersion = ref(0)

/** 关注名单非空才值得重排：空名单直接复用原数组，省掉一次全量拷贝 + 排序 */
const hasFollowed = computed(() => followedMembers.value.length > 0)

/** 关注成员优先展示：比较器只输出布尔值差，配合稳定排序，组内各自保持接口返回顺序。
 * userId 归一化集中在 store 的 isFollowed，页面不自己 parseInt */
const orderedLiveList = computed(() => {
  const list = liveList.value
  if (!hasFollowed.value)
    return list
  return [...list].sort(
    (a, b) => Number(isFollowed(b.userInfo.userId)) - Number(isFollowed(a.userInfo.userId)),
  )
})

/** 已加载列表里关注成员的直播条数：dock 文案据此说明「优先展示」是否已生效 */
const followedLiveCount = computed(() => liveList.value.filter(item => isFollowed(item.userInfo.userId)).length)

// 点击卡片：以画中画迷你窗打开直播，可边看边继续浏览列表
function play(item: LiveListItem) {
  openLive({
    liveId: item.liveId,
    nickname: item.userInfo.nickname,
    title: item.title ?? '',
    startTime: Number.parseInt(item.ctime),
    liveType: item.liveType ?? 1,
    liveMode: item.liveMode ?? 0,
  })
}

// 浮窗放流失败（流已不存在/直播下架）时，若该直播属于本页列表则自动刷新
function onLiveUnavailable(liveId: string) {
  const inList = liveList.value.some(item => item.liveId === liveId)
  debugLog('list', `③收到下架广播: ${liveId}（来自播放器链的 live-unavailable 事件）在本页列表中: ${inList}${inList ? ' → 重置并刷新列表' : ' → 忽略'}`)
  if (inList)
    refreshList()
}

// 手动/自动刷新：重置分页后拉取最新列表，并回到列表顶部
function refreshList() {
  imageVersion.value += 1
  liveScrollRef.value?.setScrollTop?.(0)
  refresh()
}

onMounted(() => {
  getLiveList()
  refreshFollowedMembers()
  // 首次挂载即读取跳转参数（从成员页抽屉跳转过来的场景）
  applyMemberPlaybacksRoute(route.query as { tab?: string, member?: string })
  EventBus.on('live-unavailable', onLiveUnavailable)
})

// keep-alive 下 Lives 只挂载一次，抽屉的后续跳转通过 query 变化触发
watch(() => route.query, (query) => {
  // 仅在当前路由就是 /lives 时响应，避免其他页面 query 变化误触发
  if (route.path === '/lives')
    applyMemberPlaybacksRoute(query as { tab?: string, member?: string })
})

onUnmounted(() => {
  EventBus.off('live-unavailable', onLiveUnavailable)
})
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮层 tab：在直播与回放之间切换，悬浮于列表之上；双击当前 tab 刷新 -->
    <FloatingTabBar :tabs="viewTabs" :active="activeTab" @change="switchTab" @refresh="onTabsRefresh" />

    <div v-show="activeTab === 'live'" class="live-main">
      <!-- 首屏骨架：比全屏 loading 蒙层更稳定，能预先表达卡片布局和即将出现的内容 -->
      <el-scrollbar
        v-if="showSkeleton"
        class="scrollbar-wrapper"
      >
        <CardSkeletonGrid
          class="live-skeleton"
          :count="12"
          min-item-width="220px"
          gap="16px"
          aspect-ratio="1"
          :line-widths="[82, 56, 38]"
        />
      </el-scrollbar>

      <div v-else-if="liveList.length === 0 && !loading" class="live-empty">
        <el-empty description="当前没有直播" />
      </div>

      <el-scrollbar
        v-else
        ref="liveScrollRef"
        class="scrollbar-wrapper"
        :distance="10"
        @end-reached="onInfiniteScroll"
      >
        <div class="card-grid">
          <div
            v-for="item in orderedLiveList"
            :key="item.liveId"
            class="live-item"
            @click="play(item)"
          >
            <!-- enrichLiveItem 在 processItem 阶段已就地补全 cover/date/member，渲染时必然就绪 -->
            <LiveItem
              :item="item as EnrichedLiveItem"
              :image-version="imageVersion"
              :followed="isFollowed(item.userInfo.userId)"
              @select-member="openMemberDetail"
            />
          </div>
        </div>
        <div v-if="noMore" class="list-end">
          没有更多直播了
        </div>
      </el-scrollbar>

      <!-- 右上角浮动操作条：不占行，内容从下方滚过呈现磨砂玻璃 -->
      <FloatingRefreshDock
        :loading="loading"
        title="刷新"
        @refresh="refreshList"
      >
        <!-- 关注条数只在有置顶项时出现：让「优先展示」是可见的，而不是用户自己去数卡片位置 -->
        <span class="dock-note">
          已加载 {{ liveList.length }} 个直播<template v-if="followedLiveCount"> · 关注 {{ followedLiveCount }} 条置顶</template>
        </span>
      </FloatingRefreshDock>
    </div>

    <!-- 回放面板：复用回放组件，首次切换时才渲染并保持状态 -->
    <div v-show="activeTab === 'playback'" class="playback-main">
      <Playbacks v-if="playbackMounted" ref="playbackRef" :member-preset="memberPreset" />
    </div>

    <!-- 成员详情抽屉：与成员页共用同一份合并详情（点卡片上的成员名打开） -->
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
/* 页面骨架（相对定位 + 裁剪）由模板上的全局 .page-root 提供 */

/* 回放面板与直播共用整页高度 */
.playback-main {
  height: 100%;
}

.live-main {
  position: relative;
  height: 100%;
  overflow: hidden;
}

/* 滚动区给 Dock 的底部预留见全局 .page-root .el-scrollbar__view */

.live-skeleton {
  padding: var(--page-pad);
}

.live-empty {
  height: calc(100% - var(--dock-reserve));
  display: flex;
  justify-content: center;
  align-items: center;
}

.live-item {
  min-width: 0;
}
</style>
