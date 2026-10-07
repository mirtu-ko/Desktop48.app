import type { LiveListItem, LiveListItemView, OpenLive } from '@renderer/services/api-types'
import Apis from '@renderer/services/apis'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { enrichLiveItem } from './use-paged-live-list'

/** 空态自动检查开播的间隔：白天无人直播是常态，用户不该靠反复点刷新来等 */
const POLL_INTERVAL = 60_000

/** 「今晚公演」最多展示几场：空态是等待位，不该被排期挤满 */
const MAX_PREVIEW_SHOWS = 6

/** 「看看回放」最多展示几条 */
const MAX_PREVIEW_PLAYBACKS = 6

/**
 * 关注成员逐个查回放的并发上限：`playbackList` 只支持单个 userId 过滤，
 * 关注几十人时不能全量并发打满，取最近关注的前 N 个探测即可。
 */
const MAX_FOLLOWED_PROBE = 6

export interface UseLiveIdleOptions {
  /** 列表是否处于空态（已加载完且无数据）：只有空态才需要轮询与公演预告 */
  isEmpty: () => boolean
  /** 轮询发现新直播时回调：由页面刷新列表接管展示 */
  onLiveFound: () => void
}

/**
 * 直播页空态的「等待期」行为：
 * 1. 静默轮询列表，一开播就把展示权交回列表（见 onLiveFound）；
 * 2. 拉取公演排期，把「今晚公演」填进空态（复用公演页的 openLives 排期接口）。
 *
 * 轮询只在该页面「可见 + 空态」时运行 —— 主窗口页面被 keep-alive 缓存，
 * 切页不会触发 onUnmounted，故启停由 onActivated / onDeactivated 驱动（见 activate / deactivate）。
 */
export function useLiveIdle({ isEmpty, onLiveFound }: UseLiveIdleOptions) {
  // 关注 / 屏蔽名单都是跨页共享的模块级单例，直接读，不另建副本
  const { followedMembers, ensureFollowedLoaded } = useFollowedMembersStore()
  const { ensureBlockedLoaded, isBlocked } = useBlockedMembersStore()

  /** 公演排期（按开演时间升序）：封面已归一化为完整 URL */
  const shows = ref<OpenLive[]>([])

  /** 「看看回放」条目（按开播时间倒序）：已补全封面 / 日期 / 成员 */
  const playbacks = ref<LiveListItemView[]>([])

  /** 回放来源：followed=取自关注成员，latest=全站最新 */
  const playbackSource = ref<'followed' | 'latest'>('latest')

  /** 页面是否可见：由 activate / deactivate 维护 */
  const pageActive = ref(false)

  /** 本轮等待开始时刻 / 最近一次检查时刻 / 用于推进「已等待」文案的时钟 */
  const waitingSince = ref(0)
  const lastCheckAt = ref(0)
  const clock = ref(Date.now())

  let timer: ReturnType<typeof setInterval> | null = null

  /** 上次检查时间：列表刚拉过的那一刻也算一次检查，故 startPolling 时会一并写入 */
  const lastCheckText = computed(() => (lastCheckAt.value ? dayjs(lastCheckAt.value).format('HH:mm') : '—'))

  /** 已等待时长：时钟每次轮询推进一次，文案按分钟粒度刷新即可 */
  const waitedText = computed(() => {
    if (!waitingSince.value)
      return '刚刚开始等待'
    const minutes = Math.floor((clock.value - waitingSince.value) / 60_000)
    return minutes >= 1 ? `已等待 ${minutes} 分钟` : '刚刚开始等待'
  })

  /** 今日开演的公演（含未开始与进行中）：空态优先展示这一组 */
  const todayShows = computed(() => shows.value.filter(show => isToday(show.stime)))

  /** 空态实际展示的公演：今日没有排期时退化为最近几场（比什么都不显示更有出路） */
  const previewShows = computed(() => (todayShows.value.length ? todayShows.value : shows.value).slice(0, MAX_PREVIEW_SHOWS))

  const previewTitle = computed(() => (todayShows.value.length ? `今晚公演 · ${todayShows.value.length} 场` : '近期公演'))

  /** 公演排期是否为空：为空时页面显示一句提示而不是空标题 */
  const hasShows = computed(() => previewShows.value.length > 0)

  /** 「看看回放」标题：取自关注成员时点明来源，否则就是全站最新 */
  const playbacksTitle = computed(() => (playbackSource.value === 'followed' ? '看看回放 · 你关注的成员' : '看看回放'))

  const hasPlaybacks = computed(() => playbacks.value.length > 0)

  /** 是否同一天（公演页分组用的同一判据） */
  function isToday(stime: string): boolean {
    const date = new Date(Number.parseInt(stime))
    const now = new Date()
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate()
  }

  /**
   * 拉取公演排期填进空态：失败静默降级为空列表（白天拉不到排期不是错误，不该弹提示）。
   * 封面可能是相对路径，统一补全为完整 URL；返回新对象，不原地改接口 payload。
   */
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
   * 关注成员的最近回放：`playbackList` 只支持单个 userId 过滤，故逐个成员并发各查一页，
   * 合并去重后按开播时间倒序取前几条。单条失败不拖累其它（各自 catch 成 null）。
   */
  async function fetchFollowedPlaybacks(): Promise<LiveListItem[]> {
    const userIds = followedMembers.value.slice(0, MAX_FOLLOWED_PROBE).map(member => String(member.userId))
    if (userIds.length === 0)
      return []
    const pages = await Promise.all(userIds.map(userId =>
      Apis.playbackList({ next: '0', userId, teamId: '0', groupId: '0' }, { silent: true }).catch(() => null),
    ))
    return pages.flatMap(page => page?.liveList ?? [])
  }

  /** 全站最新回放：关注名单为空、或关注成员近期都没有回放时的兜底 */
  async function fetchLatestPlaybacks(): Promise<LiveListItem[]> {
    const page = await Apis.playbackList({ next: '0', userId: '0', teamId: '0', groupId: '0' }, { silent: true })
    return page.liveList ?? []
  }

  /** 合并候选 → 过滤屏蔽成员 → 按 liveId 去重 → 按开播时间倒序 → 取前 N 条 → 补全展示信息 */
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
    // 逐条补全封面 / 日期 / 成员；成员查询失败降级为 member=null，不中断其余条目
    return await Promise.all(picked.map(item => enrichLiveItem(item, 'fallback')))
  }

  /**
   * 拉取「看看回放」：优先关注成员的最近回放，关注为空或都没回放时退化为全站最新。
   * 失败静默降级为空列表（空态里的后台请求不该弹提示）。
   */
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
      playbacks.value = await pickRecentPlaybacks(raw)
      playbackSource.value = source
      debugLog('list', `空态回放：来源=${source}，展示 ${playbacks.value.length} 条（候选 ${raw.length} 条）`)
    }
    catch (e: any) {
      playbacks.value = []
      debugLog('list', `空态回放拉取失败（静默忽略）: ${e?.message || e}`)
    }
  }

  /** 检查一次是否已有人开播：有则停轮询并把展示权交回列表 */
  async function checkLiveOnce(): Promise<void> {
    lastCheckAt.value = Date.now()
    clock.value = lastCheckAt.value
    try {
      const content = await Apis.lives('0', { silent: true })
      if ((content.liveList?.length ?? 0) > 0) {
        debugLog('list', '空态轮询：检测到新直播 → 交回列表刷新')
        stopPolling()
        onLiveFound()
      }
    }
    catch (e: any) {
      // 轮询失败是常态（网络抖动），静默重试即可，下一轮再来
      debugLog('list', `空态轮询失败（静默忽略）: ${e?.message || e}`)
    }
  }

  function startPolling(): void {
    if (timer)
      return
    waitingSince.value = Date.now()
    clock.value = waitingSince.value
    // 进入空态的前提就是列表刚返回过，把这一刻记为「上次检查」，避免立刻重复请求
    lastCheckAt.value = waitingSince.value
    timer = setInterval(() => {
      void checkLiveOnce()
    }, POLL_INTERVAL)
    void loadShows()
    void loadPlaybacks()
  }

  function stopPolling(): void {
    if (!timer)
      return
    clearInterval(timer)
    timer = null
  }

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

  /** 页面可见：恢复轮询；若离开期间一直是空态，回来时立刻补查一次 */
  function activate(): void {
    const wasActive = pageActive.value
    pageActive.value = true
    // 首次挂载不补查（列表正在加载，本身就是一次检查）；只有「离开后回来」才值得立刻重查
    if (!wasActive && waitingSince.value > 0 && isEmpty())
      void checkLiveOnce()
  }

  /** 页面不可见：停掉轮询，避免在后台空转 */
  function deactivate(): void {
    pageActive.value = false
  }

  // 生命周期自己接：主窗口页面被 keep-alive 缓存，切页只触发 deactivated / activated，
  // 永远不会 unmount —— 只挂 onMounted/onUnmounted 会让轮询在切页后一直空转。
  // onMounted 一并接上，是为了不依赖「外层一定包了 KeepAlive」（否则 onActivated 永不触发，静默失效）。
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
