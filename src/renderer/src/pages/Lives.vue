<script setup lang="ts">
import type { LiveListItem, LiveListItemView, OpenLive } from '@renderer/services/api-types'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import LiveItem from '@renderer/components/ui/LiveItem.vue'
import LiveTabBar from '@renderer/components/ui/LiveTabBar.vue'
import MemberDetailCard from '@renderer/components/ui/MemberDetailCard.vue'
import ShowCard from '@renderer/components/ui/ShowCard.vue'
import CardSkeletonGrid from '@renderer/components/ui/skeleton/CardSkeletonGrid.vue'
import { useLiveIdle } from '@renderer/composables/use-live-idle'
import { useMemberDetail } from '@renderer/composables/use-member-detail'
import { enrichLiveItem, usePagedLiveList } from '@renderer/composables/use-paged-live-list'
import Apis from '@renderer/services/apis'
import EventBus from '@renderer/services/event-bus'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { useLiveStatusStore } from '@renderer/stores/live-status'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { resolveBilibiliRoomIdAsync } from '@renderer/utils/bilibili-room'
import { debugLog } from '@renderer/utils/debug'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

// 独立播放窗：直播/回放/公演共用全局播放挂载点
const { openLive, openPlayback } = useFloatPlayersStore()

// 关注名单：模块级共享状态（与成员页共用同一份），直播列表页据此优先展示并加标识。
// 页面被 keep-alive 缓存（只挂载一次），跨页同步靠这份共享状态而不是重新挂载
const { followedMembers, refreshFollowedMembers, isFollowed } = useFollowedMembersStore()
const { refreshLiveStatus } = useLiveStatusStore()

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
/** 列表是否已至少完成一次加载：空态判定的前提（见下方 useLiveIdle 的 isEmpty） */
const listSettled = ref(false)

/**
 * 空态（白天无人直播）的等待期内容：静默轮询自动感知开播 + 公演排期预告 + 最近回放。
 * 轮询只在「本页可见 + 列表为空」时运行，发现新直播即把展示权交回列表（refreshList）；
 * 可见性由 composable 自己挂 onMounted / onActivated / onDeactivated 维护，页面无需接线。
 */
const {
  shows: previewShows,
  showsTitle: previewShowsTitle,
  hasShows: hasPreviewShows,
  playbacks: previewPlaybacks,
  playbacksTitle: previewPlaybacksTitle,
  hasPlaybacks: hasPreviewPlaybacks,
  lastCheckText,
  waitedText,
} = useLiveIdle({
  // listSettled 是前提：挂载瞬间「列表还没开始加载」与「确实没有直播」长得一模一样，
  // 少了它会在每次进页面时白拉一次公演（有直播时这次请求纯属浪费）
  isEmpty: () => listSettled.value && !loading.value && liveList.value.length === 0,
  onLiveFound: () => refreshList(false),
})

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

/**
 * 空态里的公演预告：只有「进行中」（status === 2）可点开直播，
 * 选路与弹幕房间映射与公演页（Shows.vue 的 openLiveStream）保持一致。
 */
async function openShowStream(show: OpenLive) {
  if (show.status !== 2) {
    debugLog('show', `公演选路: ${show.liveId} 状态=${show.status}（非进行中），忽略本次点击`)
    return
  }
  openLive({
    liveId: show.liveId,
    nickname: show.teamList?.[0]?.teamName || '',
    title: show.subTitle || show.title,
    startTime: Number.parseInt(show.stime),
    source: 'open',
    // 公演没有主播头像，用封面作窗口头像（与公演页一致）
    avatar: show.coverPath,
    liveType: 1,
    liveMode: 0,
    // 弹幕房间三级解析（与公演页同口径）
    bilibiliRoomId: await resolveBilibiliRoomIdAsync({
      groupId: show.teamList?.[0]?.groupId,
      texts: [show.title, show.subTitle],
    }),
  })
}

/**
 * 空态里的回放卡片：以独立播放窗打开（与回放页 onPlaybackClick 同口径，
 * 标题缺失时用主播名兜底 —— 播放窗标题栏需要非空）。
 */
function openPlaybackItem(item: LiveListItemView) {
  openPlayback({
    liveId: item.liveId,
    nickname: item.userInfo.nickname,
    title: item.title || item.userInfo.nickname,
    startTime: Number.parseInt(item.ctime),
    liveType: item.liveType ?? 1,
  })
}

/** 空态分区的「查看全部」：跳到对应列表页；本页被 keep-alive 缓存，返回时等待状态仍在 */
function goToAll(path: string) {
  router.push(path)
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

// 手动/自动刷新：重置分页后拉取最新列表，并回到列表顶部。
// forceLiveStatus=false 用于空态检测已更新共享状态后的自动回列表，避免紧接着重复 getLiveList。
function refreshList(forceLiveStatus = true) {
  imageVersion.value += 1
  if (forceLiveStatus)
    void refreshLiveStatus(true).catch(error => debugLog('list', '手动刷新共享直播状态失败', error))
  refreshFromTop()
}

onMounted(() => {
  // getLiveList 内部收敛了所有异常（失败也 resolve），这里只用来标记「列表已加载过一轮」
  void getLiveList().then(() => {
    listSettled.value = true
  })
  refreshFollowedMembers()
  EventBus.on('live-unavailable', onLiveUnavailable)
  // 双击底部 Dock 的直播项（根组件广播）：回顶由根组件做，这里只负责刷新当前可见的列表
  EventBus.on('lives-refresh', onLivesRefresh)
})

// 空态轮询的启停由 useLiveIdle 自己挂生命周期（页面被 keep-alive 缓存，不能靠 onUnmounted 收尾）
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
      <!-- 空态灵动岛：脱离滚动流，固定在页面顶部 -->
      <div v-if="liveList.length === 0 && !loading" class="idle-head frosted-surface" role="status">
        <span class="idle-dot" aria-hidden="true" />
        <div class="idle-head-main">
          <p class="idle-title">
            当前没有直播
          </p>
          <p class="idle-sub">
            监控中，每 120 秒自动刷新检查
          </p>
        </div>
        <div class="idle-meta">
          <span class="idle-waited">{{ waitedText }}</span>
          <span class="idle-check">上次检查 {{ lastCheckText }}</span>
        </div>
      </div>
      <!-- 首屏骨架：比全屏 loading 蒙层更稳定，能预先表达卡片布局和即将出现的内容 -->
      <el-scrollbar
        v-if="showSkeleton"
        class="scrollbar-wrapper"
      >
        <CardSkeletonGrid
          class="live-skeleton"
        />
      </el-scrollbar>

      <!-- 空态：白天无人直播时的等待位 —— 自动轮询 + 公演排期预告，而不是一句干等 -->
      <el-scrollbar
        v-else-if="liveList.length === 0 && !loading"
        class="scrollbar-wrapper"
      >
        <div class="live-idle">
          <template v-if="hasPreviewShows">
            <h2 class="section-title section-title--live">
              {{ previewShowsTitle }}
              <button
                type="button"
                class="section-more"
                aria-label="查看全部公演"
                @click="goToAll('/shows')"
              >
                查看全部
              </button>
            </h2>
            <div class="idle-shows">
              <div
                v-for="show in previewShows"
                :key="show.liveId"
                class="idle-show lift-card"
                :class="{ clickable: show.status === 2 }"
                @click="openShowStream(show)"
              >
                <ShowCard :show="show" />
              </div>
            </div>
          </template>
          <p v-else class="idle-hint">
            近期也没有公演排期，晚点再来看看吧
          </p>

          <template v-if="hasPreviewPlaybacks">
            <h2 class="section-title">
              {{ previewPlaybacksTitle }}
              <button
                type="button"
                class="section-more"
                aria-label="查看全部回放"
                @click="goToAll('/lives/playbacks')"
              >
                查看全部
              </button>
            </h2>
            <div class="idle-playbacks">
              <div
                v-for="item in previewPlaybacks"
                :key="item.liveId"
                class="idle-playback"
                @click="openPlaybackItem(item)"
              >
                <!-- enrichLiveItem 已在取数阶段补全 cover/date/member，渲染时必然就绪 -->
                <LiveItem
                  :item="item"
                  date-mode="relative"
                  :followed="isFollowed(item.userInfo.userId)"
                  @select-member="id => openMemberDetail(id, 'live')"
                />
              </div>
            </div>
          </template>
        </div>
      </el-scrollbar>

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
              @select-member="id => openMemberDetail(id, 'live')"
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
        <span v-if="liveList.length" class="dock-note">
          已加载 {{ liveList.length }} 个直播<template v-if="followedLiveCount"> · 关注 {{ followedLiveCount }} 条置顶</template>
        </span>
      </FloatingRefreshDock>
    </div>

    <!-- 成员详情卡片：与成员页共用同一份合并详情（点卡片上的成员名打开） -->
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

/* 空态（白天无人直播）：顶部灵动岛 + 公演预告。
 * 外层是 el-scrollbar，内容随页面滚动，故这里只负责内边距与纵向节奏 */
.live-idle {
  display: flex;
  flex-direction: column;
  padding: var(--page-pad);

  /* 全局 .section-title--live 是硬编码暖粉；空态统一到直播语义色。
   * 只在本页覆写，不影响公演页等其它使用方 */
  .section-title--live {
    --st-accent: var(--color-lives);
  }
}

/* 空态灵动岛：与左上 FloatingTabBar / 右上 FloatingRefreshDock 同用 .frosted-surface
 * 浅色玻璃，三个浮层同在顶部才是一套观感；这里只负责布局、文字层级与直播语义色点缀。
 * 严格按页面水平居中（left:50% + translateX(-50%)）；左上 tab 栏右边界约 216px，
 * 故两侧各预留 224px 作为宽度上限，居中时也不会压住任一浮层。
 * 主窗口 minWidth 为 900px，正常宽度下内容不会收缩；max() 兜住缩放后的极窄视口 */
.idle-head {
  --idle-side-reserve: 224px;

  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 6;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 14px;
  width: fit-content;
  max-width: max(160px, calc(100% - var(--idle-side-reserve) - var(--idle-side-reserve)));
  padding: 8px 20px;
  border-radius: var(--radius-pill);
  animation: idle-head-in 0.32s ease-out;

  /* 直播语义色呼吸点：静态柔光底 + 雷达扩散圈，表达「正在自动检查开播」而非纯装饰 */
  .idle-dot {
    position: relative;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-lives);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-lives) 14%, transparent);

    &::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--color-lives) 32%, transparent);
      animation: idle-dot-ping 2.4s ease-out infinite;
    }
  }

  .idle-head-main {
    min-width: 0;
  }

  .idle-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
    color: var(--el-text-color-primary);
  }

  .idle-sub {
    margin: 2px 0 0;
    overflow: hidden;
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
    color: var(--el-text-color-secondary);
    text-overflow: ellipsis;
  }

  /* 右侧动态信息区：两行右对齐，与左侧标题/副题的高度节奏对齐，发丝线分隔 */
  .idle-meta {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding-left: 14px;
    border-left: 1px solid var(--el-border-color-lighter);
  }

  /* 已等待时长是唯一随时间跳动的值，用加深的直播玫红提亮：原色直接做文字对比度不足，混黑压深一档 */
  .idle-waited {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
    color: color-mix(in srgb, var(--color-lives) 72%, #000);
    white-space: nowrap;
  }

  .idle-check {
    font-size: 11px;
    line-height: 1.4;
    color: var(--el-text-color-placeholder);
    white-space: nowrap;
  }
}

/* 居中依赖 transform，入场动画必须连同横向 -50% 一起写，否则入场瞬间会横向跳动 */
@keyframes idle-head-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }

  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@keyframes idle-dot-ping {
  0% {
    opacity: 0.5;
    transform: scale(0.6);
  }

  100% {
    opacity: 0;
    transform: scale(1.9);
  }
}

@media (prefers-reduced-motion: reduce) {
  .idle-head {
    animation: none;
  }

  .idle-dot::after {
    opacity: 0;
    animation: none;
  }
}

/* 公演预告网格：与公演页的卡片网格同口径（16 / 9 封面 + 队伍角标） */
.idle-shows {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}

.idle-show {
  min-width: 0;
}

/* 回放预告网格：列宽与直播/回放列表页的 .card-grid 同口径（1:1 封面） */
.idle-playbacks {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.idle-playback {
  min-width: 0;
}

.idle-hint {
  margin: 20px 0 0;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

/* 分区标题右侧的「查看全部」：.section-title 的 ::after 尾线 flex:1 且 order 为 0，
 * 按钮设 order:1 排到尾线右侧，颜色继承所在分区的 --st-accent */
.section-more {
  order: 1;
  flex: none;
  margin-left: 8px;
  padding: 2px 8px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--st-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    box-shadow 0.2s ease;

  &::after {
    content: '→';
    margin-left: 4px;
  }

  &:hover {
    background: color-mix(in srgb, var(--st-accent) 14%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--st-accent) 30%, transparent);
  }
}

/* 正常窗口不会触发（minWidth 900px）；仅在页面缩放或日后调小窗口下限时逐级精简：
 * 先收起右侧动态信息，再收起副题，始终不让胶囊压住左 tab 栏 */
@media (max-width: 760px) {
  .idle-head .idle-meta {
    display: none;
  }
}

@media (max-width: 680px) {
  .idle-head .idle-sub {
    display: none;
  }
}

.live-item {
  min-width: 0;
}
</style>
