<script setup lang="ts">
import type { OpenLive } from '@renderer/services/api-types'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import ShowCard from '@renderer/components/ui/ShowCard.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import useLoadMore from '@renderer/composables/use-load-more'
import usePagedList from '@renderer/composables/use-paged-list'
import { isShowLive, isTodayShow, showLockedHint, useShowActions } from '@renderer/composables/use-show-actions'
import Apis from '@renderer/services/apis'
import Constants from '@renderer/utils/constants'
import Tools from '@renderer/utils/tools'
import { computed, onMounted, ref, watch } from 'vue'

// 公演卡片点击选路（进行中开直播 / 其余提示原因 / 历史开回放）：与直播页空态预告共用，见 use-show-actions
const { onShowClick, openShowPlayback } = useShowActions()

/** 当前团体 groupId：取值见 Constants.GroupTabs（'0'=全部） */
const groupId = ref('0')

/** 团体切换 tab 选项（左上角浮动磨砂玻璃切换器），与成员页共用同一份分团配置 */
const groupTabs = Constants.GroupTabs

/** 排期/进行中公演（按开演时间升序）：分页状态、追加去重、触底补拉由 usePagedList 管理 */
const {
  list: showList,
  loading,
  noMore,
  reset: resetShows,
  getList: fetchShows,
} = usePagedList<OpenLive>({
  loadPage: async (next) => {
    const content = await Apis.openLives(Number.parseInt(groupId.value), next, false)
    // getOpenLiveList 的 next 是"最后一场开演时间"游标：有数据时永远是时间戳，
    // 只有拉回空列表（或返回 '0'）才算没有更多
    return {
      next: content.next || '0',
      items: [...(content.liveList || [])].sort((a, b) => Number.parseInt(a.stime) - Number.parseInt(b.stime)),
    }
  },
  processItem: (item) => {
    // coverPath 可能是相对路径（如 /mediasource/...），统一补全为 source.48.cn 完整 URL
    if (item.coverPath)
      item.coverPath = Tools.sourceUrl(item.coverPath)
  },
})

/** 历史公演（已结束可回放，按开演时间降序新→旧）：与排期列表同一套分页骨架 */
const {
  list: historyList,
  loading: historyLoading,
  noMore: historyNoMore,
  reset: resetHistory,
  getList: fetchHistoryShows,
} = usePagedList<OpenLive>({
  loadPage: async (next) => {
    const content = await Apis.openLives(Number.parseInt(groupId.value), next, true)
    return {
      next: content.next || '0',
      items: [...(content.liveList || [])].sort((a, b) => Number.parseInt(b.stime) - Number.parseInt(a.stime)),
    }
  },
  processItem: (item) => {
    if (item.coverPath)
      item.coverPath = Tools.sourceUrl(item.coverPath)
  },
})

/** 触底加载禁用态：任一列表加载中、或两份列表都无更多时禁用 */
const disabled = computed(() =>
  loading.value || historyLoading.value || (noMore.value && historyNoMore.value))

const showsScrollRef = ref<any>(null)

// 统一的触底加载：直播/回放/公演三页共用同一套交互逻辑。
// 最近的公演翻完后无缝衔接历史公演，避免用户需要再滚一次触底。
// 返回 false 表示本轮加载失败：useLoadMore 据此终止“不足一屏自动补拉”，
// 否则空列表 + 不足一屏会让补拉无限递归（网络错误时页面卡死刷错误提示的根因）
const { onInfiniteScroll } = useLoadMore({
  load: async () => {
    if (!noMore.value) {
      const ok = await fetchShows()
      if (noMore.value)
        await fetchHistoryShows()
      return ok
    }
    return await fetchHistoryShows()
  },
  disabled,
  scrollbarRef: showsScrollRef,
})

/** 首屏加载中：覆盖“拉第一页 → 补满首屏（含衔接历史公演）”的整段串行请求，
 *  全页遮罩只呈现一次；避免多接口轮流置 loading 导致页面连续刷新多次 */
const initialLoading = ref(false)

/** 首次进入 / 刷新 / 切换团体共用的首屏加载序列 */
async function loadFirstScreen() {
  initialLoading.value = true
  try {
    await fetchShows()
    showsScrollRef.value?.setScrollTop?.(0)
    // 首屏数据太少（不足一屏）时不会触发 end-reached，主动补拉下一页直到填满或无更多
    await onInfiniteScroll()
  }
  finally {
    initialLoading.value = false
  }
}

onMounted(async () => {
  await loadFirstScreen()
})

/** 刷新/切换团体共用：重置两份列表的翻页游标后重新拉取，并回到列表顶部 */
async function reload() {
  resetShows()
  resetHistory()
  await loadFirstScreen()
}

const refresh = reload

/** 切换团体：重置分页后重新拉取该团体公演 */
watch(groupId, reload)

/** 分组：当日开演 → “即将开始”，其余 → “最近公演” */
const todayShows = computed(() => showList.value.filter(show => isTodayShow(show)))
const recentShows = computed(() => showList.value.filter(show => !isTodayShow(show)))

// 首屏/切换团体时展示接近真实分区的骨架；已有数据刷新不整页遮罩
const showSkeleton = computed(() =>
  initialLoading.value && showList.value.length === 0 && historyList.value.length === 0)
</script>

<template>
  <div class="page-root">
    <!-- 左上角浮动团体切换：不占行，内容滚过时呈现磨砂玻璃；双击当前分团刷新列表 -->
    <FloatingTabBar :tabs="groupTabs" :active="groupId" @change="groupId = $event" @refresh="refresh" />
    <el-scrollbar
      ref="showsScrollRef"
      class="scrollbar-wrapper"
      :distance="10"
      @end-reached="onInfiniteScroll"
    >
      <div v-if="showSkeleton" class="shows-container">
        <CardSkeletonGrid
          :count="3"
          min-item-width="var(--show-min)"
          gap="var(--show-gap)"
          aspect-ratio="16 / 9"
          :line-widths="[72, 42]"
          heading
        />
        <CardSkeletonGrid
          class="skeleton-section"
          :count="3"
          min-item-width="var(--show-min)"
          gap="var(--show-gap)"
          aspect-ratio="16 / 9"
          :line-widths="[72, 42]"
          heading
        />
      </div>

      <div v-else class="shows-container">
        <template v-if="todayShows.length">
          <h2 class="section-title section-title--live">
            即将开始
          </h2>
          <div class="shows-list">
            <el-tooltip
              v-for="show in todayShows"
              :key="show.liveId"
              :content="showLockedHint(show)"
              :disabled="isShowLive(show)"
              placement="top"
              :show-after="300"
            >
              <div
                class="show-item lift-card"
                :class="isShowLive(show) ? 'clickable' : 'is-disabled'"
                @click="onShowClick(show)"
              >
                <ShowCard :show="show" :hint="showLockedHint(show)" />
              </div>
            </el-tooltip>
          </div>
        </template>

        <template v-if="recentShows.length">
          <h2 class="section-title">
            最近公演
          </h2>
          <div class="shows-list">
            <el-tooltip
              v-for="show in recentShows"
              :key="show.liveId"
              :content="showLockedHint(show)"
              :disabled="isShowLive(show)"
              placement="top"
              :show-after="300"
            >
              <div
                class="show-item lift-card"
                :class="isShowLive(show) ? 'clickable' : 'is-disabled'"
                @click="onShowClick(show)"
              >
                <ShowCard :show="show" :hint="showLockedHint(show)" />
              </div>
            </el-tooltip>
          </div>
        </template>

        <template v-if="historyList.length">
          <h2 class="section-title section-title--muted">
            历史公演
          </h2>
          <div class="shows-list">
            <div
              v-for="show in historyList"
              :key="show.liveId"
              class="show-item lift-card clickable"
              @click="openShowPlayback(show)"
            >
              <ShowCard :show="show" />
            </div>
          </div>
        </template>

        <el-empty
          v-if="!showList.length && !historyList.length && !initialLoading && !loading && !historyLoading"
          class="page-empty"
          :image-size="120"
          description="暂无演出信息，换个团体看看吧"
        />
      </div>
      <div v-if="noMore && historyNoMore" class="list-end">
        没有更多公演了
      </div>
    </el-scrollbar>
    <!-- 右上角浮动操作条：磨砂玻璃 dock 衬托刷新按钮，空数据时也可用 -->
    <FloatingRefreshDock
      :loading="loading || historyLoading"
      @refresh="refresh"
    />
  </div>
</template>

<style scoped>
/* 页面骨架（相对定位 + 裁剪）见全局 .page-root */

.shows-container {
  /* 顶部留出左上角浮动切换器的空间（--tabbar-offset-top），避免遮挡内容 */
  padding: var(--page-pad);
}

.skeleton-section {
  margin-top: 20px;
}

.shows-list {
  padding-bottom: 20px;
  display: grid;
  gap: var(--show-gap);
  grid-template-columns: repeat(auto-fill, minmax(var(--show-min), 1fr));
}

/* 排期卡片外层的 el-tooltip 包裹层承接 grid 列宽，卡片自己撑满 */
.shows-list :deep(.el-tooltip__trigger) {
  display: block;
  min-width: 0;
  height: 100%;
}

.show-item {
  min-width: 0;
  height: 100%;
  /* 拉满行高，与其他卡片等高 */
  display: flex;
  flex-direction: column;
}

.show-item > :deep(.show-card) {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* 卡片皮肤与 .clickable / .is-disabled 的差别见全局 .lift-card */
</style>
