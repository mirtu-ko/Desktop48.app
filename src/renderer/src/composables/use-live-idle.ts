import type { LiveListItem, LiveListItemView, OpenLive } from '@renderer/services/api-types'
import Apis from '@renderer/services/apis'
import { useLiveStatusStore } from '@renderer/stores/live-status'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { enrichLiveItem } from './use-paged-live-list'

/** 空态公演最多展示几场。 */
const MAX_PREVIEW_SHOWS = 4

/** 「看看回放」最多展示几条 */
const MAX_PREVIEW_PLAYBACKS = 5

/** 关注成员回放最多向后扫描的页数。 */
const MAX_FOLLOWED_PLAYBACK_PAGES = 5

export interface UseLiveIdleOptions {
  /** 列表是否处于空态（已加载完且无数据）：只有空态才需要轮询与公演预告 */
  isEmpty: () => boolean
  /** 轮询发现新直播时回调：由页面刷新列表接管展示 */
  onLiveFound: () => void
}

/**
 * 直播页空态：静默轮询开播，并加载公演/回放预告。
 * 仅页面可见且空态时运行；由 keep-alive 生命周期驱动启停。
 */
export function useLiveIdle({ isEmpty, onLiveFound }: UseLiveIdleOptions) {
  const { followedMembers, ensureFollowedLoaded, isFollowed } = useFollowedMembersStore()
  const { ensureBlockedLoaded, isBlocked } = useBlockedMembersStore()
  const { liveItems, refreshLiveStatus, acquireLiveStatusPolling } = useLiveStatusStore()

  /** 公演排期。 */
  const shows = ref<OpenLive[]>([])

  /** 回放条目。 */
  const playbacks = ref<LiveListItemView[]>([])

  /** 回放来源。 */
  const playbackSource = ref<'followed' | 'latest'>('latest')

  const pageActive = ref(false)

  /** 等待与检查状态。 */
  const waitingSince = ref(0)
  const lastCheckAt = ref(0)
  const clock = ref(Date.now())

  let releaseLiveStatusPolling: (() => void) | null = null

  /** 上次检查时间。 */
  const lastCheckText = computed(() => (lastCheckAt.value ? dayjs(lastCheckAt.value).format('HH:mm') : '—'))

  /** 已等待时长。 */
  const waitedText = computed(() => {
    if (!waitingSince.value)
      return '刚刚开始等待'
    const minutes = Math.floor((clock.value - waitingSince.value) / 60_000)
    return minutes >= 1 ? `已等待 ${minutes} 分钟` : '刚刚开始等待'
  })

  /** 今日开演的公演。 */
  const todayShows = computed(() => shows.value.filter(show => isToday(show.stime)))

  /** 今日优先，其次最近公演。 */
  const previewShows = computed(() => (todayShows.value.length ? todayShows.value : shows.value).slice(0, MAX_PREVIEW_SHOWS))

  const previewTitle = computed(() => (todayShows.value.length ? `今晚公演 · ${todayShows.value.length} 场` : '近期公演'))

  const hasShows = computed(() => previewShows.value.length > 0)

  /** 回放标题。 */
  const playbacksTitle = computed(() => (playbackSource.value === 'followed' ? '看看回放 · 你关注的成员' : '看看回放'))

  const hasPlaybacks = computed(() => playbacks.value.length > 0)

  function isToday(stime: string): boolean {
    const date = new Date(Number.parseInt(stime))
    const now = new Date()
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate()
  }

  /** 拉取公演排期；失败静默降级。 */
  async function loadShows(): Promise<void> {
    try {
      const content = await Apis.openLives(0, '0', false, { silent: true })
      shows.value = [...(content.liveList || [])]
        .sort((a, b) => Number.parseInt(a.stime) - Number.parseInt(b.stime))
        .map(show => ({
          ...show,
          coverPath: show.coverPath ? Tools.sourceUrl(show.coverPath) : show.coverPath,
        }))
      debugLog('list', `空态预告：公演 ${shows.value.length} 场（今日 ${todayShows.value.length} 场）`)
    }
    catch (e: any) {
      shows.value = []
      debugLog('list', `空态预告：公演排期拉取失败（静默忽略）: ${e?.message || e}`)
    }
  }

  /**
   * 逐页扫描全站回放，筛出关注成员的回放。
   * 每页过滤后累计，拿满预览条数或扫描满 5 页即停。
   */
  async function fetchFollowedPlaybacks(): Promise<LiveListItem[]> {
    if (followedMembers.value.length === 0)
      return []

    await ensureBlockedLoaded()
    const picked: LiveListItem[] = []
    const seen = new Set<string>()
    let next = '0'

    for (let page = 0; page < MAX_FOLLOWED_PLAYBACK_PAGES && picked.length < MAX_PREVIEW_PLAYBACKS; page += 1) {
      const content = await Apis.playbackList({
        next,
        userId: '0',
        teamId: '0',
        groupId: '0',
      }, { silent: true }).catch((e: any) => {
        debugLog('list', `空态回放：关注成员扫描第 ${page + 1} 页失败（静默停止）: ${e?.message || e}`)
        return null
      })
      if (!content)
        break

      const items = content.liveList ?? []
      for (const item of items) {
        if (picked.length >= MAX_PREVIEW_PLAYBACKS)
          break
        if (seen.has(item.liveId) || isBlocked(item.userInfo?.userId) || !isFollowed(item.userInfo?.userId))
          continue
        seen.add(item.liveId)
        picked.push(item)
      }

      if (!items.length || !content.next || content.next === '0' || content.next === next)
        break
      next = content.next
    }

    return picked
  }

  /** 全站最新回放兜底。 */
  async function fetchLatestPlaybacks(): Promise<LiveListItem[]> {
    const page = await Apis.playbackList({ next: '0', userId: '0', teamId: '0', groupId: '0' }, { silent: true })
    return page.liveList ?? []
  }

  /** 过滤、去重、排序并取前 N 条回放。 */
  async function pickRecentPlaybacks(raw: LiveListItem[]): Promise<LiveListItemView[]> {
    await ensureBlockedLoaded()
    const seen = new Set<string>()
    const picked = raw
      .filter(item => !isBlocked(item.userInfo?.userId))
      .filter((item) => {
        if (seen.has(item.liveId))
          return false
        seen.add(item.liveId)
        return true
      })
      .sort((a, b) => Number.parseInt(b.ctime) - Number.parseInt(a.ctime))
      .slice(0, MAX_PREVIEW_PLAYBACKS)
    return await Promise.all(picked.map(item => enrichLiveItem(item, 'fallback')))
  }

  /** 优先关注成员回放，否则全站最新；失败静默降级。 */
  async function loadPlaybacks(): Promise<void> {
    try {
      // 关注名单必须先就位：还在请求中时会被误判成「没有关注成员」，直接跳去全站最新
      await ensureFollowedLoaded()
      let raw = await fetchFollowedPlaybacks()
      let source: 'followed' | 'latest' = 'followed'
      if (raw.length === 0) {
        raw = await fetchLatestPlaybacks()
        source = 'latest'
      }
      debugLog('list', `空态回放：拉取 ${source}`, raw)
      playbacks.value = await pickRecentPlaybacks(raw)
      playbackSource.value = source
      debugLog('list', `空态回放：来源=${source}，展示 ${playbacks.value.length} 条（候选 ${raw.length} 条）`)
    }
    catch (e: any) {
      playbacks.value = []
      debugLog('list', `空态回放拉取失败（静默忽略）: ${e?.message || e}`)
    }
  }

  /** 有直播时停止空态轮询，并把展示权交回列表。 */
  function handleLiveFound(): void {
    debugLog('list', '空态轮询：检测到新直播 → 交回列表刷新')
    stopPolling()
    waitingSince.value = 0
    onLiveFound()
  }

  /** 检查一次共享直播状态；有直播则交回列表。 */
  async function checkLiveOnce(): Promise<void> {
    lastCheckAt.value = Date.now()
    clock.value = lastCheckAt.value
    try {
      const items = await refreshLiveStatus()
      if (items.length > 0)
        handleLiveFound()
    }
    catch (e: any) {
      debugLog('list', `空态轮询失败（静默忽略）: ${e?.message || e}`)
    }
  }

  function startPolling(): void {
    if (releaseLiveStatusPolling)
      return
    // 离开页面再回来沿用原等待周期；只有发现直播后重置，下一轮空态才重新计时
    if (!waitingSince.value) {
      waitingSince.value = Date.now()
      lastCheckAt.value = waitingSince.value
    }
    clock.value = Date.now()
    releaseLiveStatusPolling = acquireLiveStatusPolling()
    if (liveItems.value.length > 0) {
      handleLiveFound()
      return
    }
    void checkLiveOnce()
    void loadShows()
    void loadPlaybacks()
  }

  function stopPolling(): void {
    releaseLiveStatusPolling?.()
    releaseLiveStatusPolling = null
  }

  // 共享 store 的 120s 轮询发现开播后，空态页立即交回列表展示。
  watch(liveItems, (items) => {
    if (!pageActive.value || !items.length || !isEmpty())
      return
    lastCheckAt.value = Date.now()
    clock.value = lastCheckAt.value
    handleLiveFound()
  })

  // 「可见 + 空态」才轮询：任一条件变化都重新判定
  watch(
    () => pageActive.value && isEmpty(),
    (shouldPoll) => {
      if (shouldPoll)
        startPolling()
      else
        stopPolling()
    },
    { immediate: true },
  )

  /** 页面可见：恢复轮询；离开后回来可立即补查一次。 */
  function activate(): void {
    const wasActive = pageActive.value
    pageActive.value = true
    if (!wasActive && waitingSince.value > 0 && isEmpty())
      void checkLiveOnce()
  }

  function deactivate(): void {
    pageActive.value = false
  }

  // keep-alive 页面不会 unmount，需同时兼容普通挂载与激活/停用。
  onMounted(activate)
  onActivated(activate)
  onDeactivated(deactivate)
  onUnmounted(deactivate)

  return {
    shows: previewShows,
    showsTitle: previewTitle,
    hasShows,
    playbacks,
    playbacksTitle,
    hasPlaybacks,
    lastCheckText,
    waitedText,
  }
}

export default useLiveIdle
