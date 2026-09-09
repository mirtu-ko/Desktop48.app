<script setup lang="ts">
import type { LiveListItem } from '../services/api-types'
import { Film, VideoCamera } from '@element-plus/icons-vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import FloatingRefreshDock from '../components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '../components/ui/FloatingTabBar.vue'
import LiveItem from '../components/ui/LiveItem.vue'
import CardSkeletonGrid from '../components/ui/skeleton/CardSkeletonGrid.vue'
import { enrichLiveItem, usePagedLiveList } from '../composables/data/use-paged-live-list'
import useFloatPlayers from '../composables/use-float-players'
import Apis from '../services/apis'
import EventBus from '../services/event-bus'
import { debugLog } from '../utils/debug'
import Playbacks from './Playbacks.vue'

const route = useRoute()

// 画中画迷你窗：直播/回放/公演共用全局播放挂载点
const { openLive } = useFloatPlayers()

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
// 切到回放面板并按该成员预置级联筛选。跳转语义由路由 query 承载（原 EventBus 事件已移除）
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
  loadPage: next => Apis.instance().lives(next),
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
  <div class="lives-root page-root">
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
        <div class="live-list">
          <div v-for="item in liveList" :key="item.liveId" class="live-item" @click="play(item)">
            <!-- enrichLiveItem 在 processItem 阶段已就地补全 cover/date/member，渲染时必然就绪 -->
            <LiveItem :item="item as EnrichedLiveItem" :image-version="imageVersion" />
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
        <span class="live-count">已加载 {{ liveList.length }} 个直播</span>
      </FloatingRefreshDock>
    </div>

    <!-- 回放面板：复用回放组件，首次切换时才渲染并保持状态 -->
    <div v-show="activeTab === 'playback'" class="playback-main">
      <Playbacks v-if="playbackMounted" ref="playbackRef" :member-preset="memberPreset" />
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 页面骨架（相对定位 + 裁剪）由模板上的全局 .page-root 提供 */

/* 回放面板与直播共用整页高度 */
.playback-main {
  height: 100%;
}

.live-count {
  margin-left: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.live-main {
  position: relative;
  height: 100%;
  overflow: hidden;
}

/* 底部留出 Dock 空间（--dock-reserve） */
:deep(.el-scrollbar__view) {
  padding-bottom: var(--dock-reserve);
}

.live-skeleton {
  padding: var(--tabbar-offset-top) 16px 8px;
}

.live-empty {
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.live-list {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  /* 顶部留出左上角 tab 栏（--tabbar-offset-top），底留卡片悬停上浮与阴影的空间 */
  padding: var(--tabbar-offset-top) 16px 8px;
}

.live-item {
  min-width: 0;
}
</style>
