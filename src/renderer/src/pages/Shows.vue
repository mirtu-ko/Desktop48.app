<script setup lang="ts">
import type { OpenLive } from '../services/apis'
import { computed, onMounted, ref, watch } from 'vue'
import FloatingRefreshDock from '../components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '../components/ui/FloatingTabBar.vue'
import ShowCard from '../components/ui/ShowCard.vue'
import useLoadMore from '../composables/data/use-load-more'
import usePagedList from '../composables/data/use-paged-list'
import useFloatPlayers from '../composables/use-float-players'
import Apis from '../services/apis'
import Constants from '../utils/constants'
import { debugLog } from '../utils/debug'
import Tools from '../utils/tools'

// 画中画迷你窗：与直播/回放页共用全局播放挂载点
const { openLive, openReview } = useFloatPlayers()

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
    const content = await Apis.instance().openLives(Number.parseInt(groupId.value), next, false)
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
    const content = await Apis.instance().openLives(Number.parseInt(groupId.value), next, true)
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
function isToday(stime: string): boolean {
  const d = new Date(Number.parseInt(stime))
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

const todayShows = computed(() => showList.value.filter(show => isToday(show.stime)))
const recentShows = computed(() => showList.value.filter(show => !isToday(show.stime)))

/** 进行中的公演：以画中画迷你窗直接打开直播，停留当前页继续浏览 */
function openLiveStream(show: OpenLive) {
  if (show.status !== 2) {
    debugLog('show', `公演选路: ${show.liveId} 状态=${show.status}（非进行中），忽略本次点击`)
    return
  }
  debugLog('show', `公演选路: ${show.liveId} 进行中 → 进入直播链（LivePlayer, source=open）`, show)
  openLive({
    liveId: show.liveId,
    nickname: show.teamList?.[0]?.teamName || '',
    title: show.subTitle || show.title,
    startTime: Number.parseInt(show.stime),
    source: 'open',
    // 公演没有主播头像，用封面作窗口头像（与录播窗口一致）
    avatar: show.coverPath,
    liveType: 1,
    liveMode: 0,
  })
}

/** 历史公演（已结束）：以画中画回放迷你窗打开 VOD 流，停留当前页继续浏览 */
function openHistoryStream(show: OpenLive) {
  debugLog('show', `公演选路: ${show.liveId} 已结束 → 进入录播链（ReviewPlayer, source=open）`, show)
  openReview({
    liveId: show.liveId,
    nickname: '',
    title: show.subTitle || show.title,
    startTime: Number.parseInt(show.stime),
    source: 'open',
    // 公演没有主播头像，用封面作窗口头像（与录播窗口一致）
    avatar: show.coverPath,
    liveType: 1,
    liveMode: 0,
  })
}
</script>

<template>
  <div
    v-loading="initialLoading"
    class="page-root"
  >
    <!-- 左上角浮动团体切换：不占行，内容滚过时呈现磨砂玻璃；双击当前分团刷新列表 -->
    <FloatingTabBar :tabs="groupTabs" :active="groupId" @change="groupId = $event" @refresh="refresh" />
    <div class="page-root">
      <el-scrollbar
        ref="showsScrollRef"
        class="scrollbar-wrapper"
        :distance="10"
        @end-reached="onInfiniteScroll"
      >
        <div class="shows-container">
          <template v-if="todayShows.length">
            <h2 class="section-title section-title--live">
              即将开始
            </h2>
            <div class="shows-list">
              <div
                v-for="show in todayShows"
                :key="show.liveId"
                class="show-item lift-card"
                :class="{ clickable: show.status === 2 }"
                @click="openLiveStream(show)"
              >
                <ShowCard :show="show" />
              </div>
            </div>
          </template>

          <template v-if="recentShows.length">
            <h2 class="section-title">
              最近公演
            </h2>
            <div class="shows-list">
              <div
                v-for="show in recentShows"
                :key="show.liveId"
                class="show-item lift-card"
                :class="{ clickable: show.status === 2 }"
                @click="openLiveStream(show)"
              >
                <ShowCard :show="show" />
              </div>
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
                @click="openHistoryStream(show)"
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
    </div>
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
  padding: var(--tabbar-offset-top) 16px 8px;
}

.shows-list {
  padding-bottom: 20px;
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}

/* 卡片皮肤（实底白卡 + hover 上浮）见全局 .lift-card */
</style>
