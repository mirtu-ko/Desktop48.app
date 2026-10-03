<script setup lang="ts">
import type { LiveListItem } from '@renderer/services/api-types'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import LiveTabBar from '@renderer/components/ui/LiveTabBar.vue'
import MemberDetailDrawer from '@renderer/components/ui/MemberDetailDrawer.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useMemberDetailDrawer } from '@renderer/composables/use-member-detail-drawer'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/use-paged-live-list'
import Apis from '@renderer/services/apis'
import EventBus from '@renderer/services/event-bus'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { debugLog } from '@renderer/utils/debug'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// 独立播放窗：直播/回放/公演共用全局播放挂载点
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

// 列表滚动容器：绑给模板，并交给 usePagedLiveList 做回顶与触底判定
const liveScrollRef = ref<any>(null)

// 分页状态与触底加载：见 composables/use-paged-live-list.ts（直播/回放共用）
const {
  list: liveList,
  loading,
  noMore,
  onInfiniteScroll,
  getList: getLiveList,
  refreshFromTop,
} = usePagedLiveList({
  scrollbarRef: liveScrollRef,
  loadPage: next => Apis.lives(next),
  // 封面/日期/成员信息补全：与回放页共用 enrichLiveItem，成员查询失败逐条容错
  processItem: item => enrichLiveItem(item, 'fallback'),
  stopOnError: false,
})

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

// 点击卡片：以独立播放窗打开直播，可边看边继续浏览列表
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

// 只刷新当前可见列表
function onLivesRefresh() {
  if (route.path === '/lives')
    refreshList()
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
  refreshFromTop()
}

onMounted(() => {
  getLiveList()
  refreshFollowedMembers()
  EventBus.on('live-unavailable', onLiveUnavailable)
  // 双击底部 Dock 的直播项（根组件广播）：回顶由根组件做，这里只负责刷新当前可见的列表
  EventBus.on('lives-refresh', onLivesRefresh)
})

onUnmounted(() => {
  EventBus.off('live-unavailable', onLiveUnavailable)
  EventBus.off('lives-refresh', onLivesRefresh)
})
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮层 tab：在直播与回放之间切换，悬浮于列表之上；双击当前 tab 刷新 -->
    <LiveTabBar @refresh="refreshList" />

    <div class="live-main">
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
            <!-- enrichLiveItem 在 processItem 阶段已补全 cover/date/member，渲染时必然就绪 -->
            <LiveItem
              :item="item"
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
