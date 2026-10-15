/**
 * 全站直播状态共享 store（模块级单例）。
 *
 * Lives 与 Rooms 都需要「当前有哪些人在播」，但两页各自轮询会重复请求全站
 * getLiveList。这里统一负责分页拉取、120s 轮询、并发去重与新鲜度判断：
 * - Rooms 用它匹配房间 LIVE 状态与分享消息的直播/回放选路；
 * - Lives 空态用它检测开播，非空态仍由分页列表自己加载；
 * - 手动刷新通过 force=true 立即更新，跳过新鲜度缓存。
 */
import type { LiveListItem } from '@renderer/services/api-types'
import Apis from '@renderer/services/apis'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import { computed, ref } from 'vue'

/** 全站直播状态轮询间隔。 */
export const LIVE_STATUS_POLL_MS = 120_000
/** 全站直播分页上限：防接口异常时无限翻页。 */
const MAX_LIVE_PAGES = 10

const liveItems = ref<LiveListItem[]>([])
const loaded = ref(false)
const refreshing = ref(false)
const lastFetchedAt = ref(0)

/** 进行中的全量刷新：并发调用共用同一请求。 */
let inflight: Promise<LiveListItem[]> | null = null
/** 轮询消费者的引用计数：没有页面需要时停止定时器。 */
let pollConsumers = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

/** userId → 当前直播；用于 Rooms 按成员匹配。 */
const liveByUserId = computed(() => {
  const map = new Map<number, LiveListItem>()
  for (const item of liveItems.value) {
    const userId = Tools.normalizeUserId(item.userInfo?.userId)
    if (Number.isFinite(userId) && !map.has(userId))
      map.set(userId, item)
  }
  return map
})

/** 当前直播 liveId 集合；null = 尚未成功加载过。 */
const liveIdSet = computed<Set<string> | null>(() => {
  if (!loaded.value)
    return null
  return new Set(liveItems.value.map(item => String(item.liveId)))
})

/** 拉取全站直播并分页去重。 */
async function fetchAllLiveItems(): Promise<LiveListItem[]> {
  const items: LiveListItem[] = []
  let next = '0'
  for (let page = 0; page < MAX_LIVE_PAGES; page++) {
    const content = await Apis.lives(next, { silent: true })
    items.push(...(content.liveList || []))
    if (!content.next || content.next === '0' || !(content.liveList || []).length)
      break
    next = content.next
  }

  const unique = new Map<string, LiveListItem>()
  for (const item of items) {
    if (item.liveId && !unique.has(item.liveId))
      unique.set(item.liveId, item)
  }
  return [...unique.values()]
}

/**
 * 刷新共享直播状态。
 * force=true 用于手动刷新；否则在 120s 新鲜期内直接复用缓存。
 */
async function refreshLiveStatus(force = false): Promise<LiveListItem[]> {
  if (!force && loaded.value && Date.now() - lastFetchedAt.value < LIVE_STATUS_POLL_MS)
    return liveItems.value
  if (inflight)
    return inflight

  refreshing.value = true
  inflight = (async () => {
    try {
      const items = await fetchAllLiveItems()
      liveItems.value = items
      loaded.value = true
      lastFetchedAt.value = Date.now()
      debugLog('live-status', `刷新完成：${items.length} 个直播`)
      return items
    }
    finally {
      refreshing.value = false
    }
  })()

  try {
    return await inflight
  }
  finally {
    inflight = null
  }
}

/** 页面进入或恢复时使用：优先复用新鲜缓存。 */
function ensureLiveStatusFresh(): Promise<LiveListItem[]> {
  return refreshLiveStatus(false)
}

function stopPollTimer(): void {
  if (!pollTimer)
    return
  clearInterval(pollTimer)
  pollTimer = null
}

function startPollTimer(): void {
  if (pollTimer)
    return
  pollTimer = setInterval(() => {
    void refreshLiveStatus().catch(error => debugLog('live-status', '轮询失败', error))
  }, LIVE_STATUS_POLL_MS)
}

/**
 * 订阅共享轮询；返回释放函数。
 * 第一个消费者会立即检查一次新鲜度并启动 120s 定时器，最后一个释放时停止。
 */
function acquireLiveStatusPolling(): () => void {
  pollConsumers++
  if (pollConsumers === 1) {
    startPollTimer()
    void ensureLiveStatusFresh().catch(error => debugLog('live-status', '首次刷新失败', error))
  }

  let released = false
  return () => {
    if (released)
      return
    released = true
    pollConsumers = Math.max(0, pollConsumers - 1)
    if (pollConsumers === 0)
      stopPollTimer()
  }
}

export function useLiveStatusStore() {
  return {
    liveItems,
    liveByUserId,
    liveIdSet,
    loaded,
    refreshing,
    lastFetchedAt,
    refreshLiveStatus,
    ensureLiveStatusFresh,
    acquireLiveStatusPolling,
  }
}
