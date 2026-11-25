import type { Ref } from 'vue'
import { debugLog } from '@renderer/utils/debug'
import { computed, ref } from 'vue'
import useLoadMore from './use-load-more'

/** 分页接口的归一化返回结构：next 为下一页游标（'0' 表示没有更多） */
export interface PagedPage<T> {
  next: string
  items: T[]
  [key: string]: any
}

export interface UsePagedListOptions<TIn, TOut extends TIn = TIn> {
  /** 请求一页数据：返回 { next, items }；通过闭包可注入筛选参数 */
  loadPage: (_next: string) => Promise<PagedPage<TIn>> | PagedPage<TIn>
  /**
   * 并行补全单个条目的展示信息（封面 / 成员 / 日期等）；在 filterItems 之后执行。
   * 返回新对象 → 用它替换列表中的条目；返回 undefined → 沿用原对象（就地修改的旧写法仍可用）
   */
  processItem?: (_item: TIn, _index: number) => Promise<TOut | void> | TOut | void
  /** 整页过滤钩子（如屏蔽成员过滤），在 processItem 之前执行 */
  filterItems?: (_items: TIn[]) => Promise<TIn[]> | TIn[]
  /** 列表条目唯一键：用于翻页去重，默认取 (item as any).liveId */
  itemKey?: (_item: TIn) => string
  /** 请求失败时是否标记为"没有更多"，从而停止触底重试；Lives 默认 false，Playbacks 为 true */
  stopOnError?: boolean
  /** 绑定到 el-scrollbar 的 ref（列表滚动容器）：回顶与触底位置判定都读它；不传则内部自建（同 useLoadMore） */
  scrollbarRef?: Ref<any>
}

/** refreshFromTop 的选项 */
export interface RefreshOptions {
  /** 软刷新：刷新期间保留旧列表，第一页回包后整体替换；失败则旧列表与游标原样保留 */
  keepList?: boolean
}

/**
 * 分页列表通用逻辑（Lives / Playbacks / Shows 三页共用）：
 * - 列表 / 游标 / loading / noMore 四件套
 * - 请求序号丢弃过期响应，避免刷新与滚动并发导致数据错乱
 * - 去重追加 + 触底加载（useLoadMore）
 * - 刷新重置（refresh）、软刷新（softRefresh）、回顶刷新（refreshFromTop）与仅重置（reset）
 */
export function usePagedList<TIn, TOut extends TIn = TIn>({
  loadPage,
  processItem,
  filterItems,
  itemKey = item => (item as any).liveId,
  stopOnError = false,
  scrollbarRef = ref<any>(null),
}: UsePagedListOptions<TIn, TOut>) {
  const list = ref<TOut[]>([]) as Ref<TOut[]>
  const listNext = ref('0')
  const loading = ref(false)
  const noMore = ref(false)
  /** 最近一次加载是否失败：useLoadMore 的“不足一屏自动补拉”据此终止，避免失败后无限重试 */
  const loadFailed = ref(false)

  const disabled = computed(() => loading.value || noMore.value)

  // 列表请求序号，用于丢弃过期响应，避免刷新/滚动并发时数据错乱
  let listRequestId = 0

  /**
   * 软刷新挂起标记：为 true 时下一次成功落地的页整体替换列表而不是追加。
   * 由 softRefresh 置位、成功落地或 reset 时清除
   */
  let replaceOnSuccess = false

  /**
   * 整页过滤（如屏蔽成员）+ 并行补全展示信息：
   * 返回 null 表示期间已有更新请求发出，本次结果应整体丢弃
   */
  async function transformItems(items: TIn[], requestId: number): Promise<TOut[] | null> {
    // 过滤与补全都在 TIn 上进行，末尾按「TOut 是补全后的 TIn」窄化一次
    let result: TIn[] = items
    if (filterItems)
      result = await filterItems(result)
    if (requestId !== listRequestId)
      return null
    if (processItem) {
      const enriched = await Promise.all(result.map((item, index) => processItem(item, index)))
      // 返回新对象的条目用它替换自身；返回 undefined 的条目沿用原对象
      result = result.map((item, index) => (enriched[index] ?? item) as TIn)
    }
    if (requestId !== listRequestId)
      return null
    return result as TOut[]
  }

  /**
   * 分页加载入口，返回是否成功（供 useLoadMore 终止自动补拉递归）：
   * 失败时不抛错，以 false 返回（调用方据此终止自动补拉，而不是靠 try/catch）
   */
  async function getList(): Promise<boolean> {
    const requestId = ++listRequestId
    loading.value = true
    loadFailed.value = false
    try {
      const page = await loadPage(listNext.value)
      debugLog('list', `①翻页: 请求 #${requestId}，next=${listNext.value}，items=${page.items.length}`, page)
      if (requestId !== listRequestId) {
        debugLog('list', `①翻页: 请求 #${requestId} 的回包已过期（更新请求 #${listRequestId} 已发出），整页丢弃`)
        return false
      }
      if (!page || !Array.isArray(page.items)) {
        debugLog('list', '分页数据不是数组或无内容', page?.items)
        loadFailed.value = true
        noMore.value = true
        return false
      }
      if (page.next === '0' || page.items.length === 0)
        noMore.value = true
      listNext.value = page.next

      // 先整页过滤（如屏蔽成员），再并行补全展示信息，避免逐条串行 await 拖慢列表加载
      const items = await transformItems(page.items, requestId)
      if (!items)
        return false
      // 软刷新：旧列表一直展示到此刻，用新的第一页一次性替换（与 reset + 追加的结果一致）
      if (replaceOnSuccess) {
        replaceOnSuccess = false
        list.value = [...items]
        debugLog('list', `①翻页: 软刷新落地，整体替换为 ${items.length} 条，next=${page.next}${noMore.value ? '（无更多）' : ''}`)
        return true
      }
      // 兜底去重，避免接口分页边界返回重复项导致列表出现重复卡片
      const existedIds = new Set(list.value.map(item => itemKey(item)))
      const fresh = items.filter(item => !existedIds.has(itemKey(item)))
      list.value.push(...fresh)
      debugLog('list', `①翻页: 拉取 ${page.items.length} 条 → 过滤后 ${items.length} 条 → 去重后新增 ${fresh.length} 条${items.length - fresh.length > 0 ? `（丢弃重复 ${items.length - fresh.length} 条）` : ''}，next=${page.next}${noMore.value ? '（无更多）' : ''}`)
      return true
    }
    catch (error) {
      if (requestId !== listRequestId)
        return false
      console.error('[use-paged-list] 分页加载失败', error)
      loadFailed.value = true
      if (stopOnError)
        noMore.value = true
      return false
    }
    finally {
      // 只有最新一次请求才有权收 loading：过期请求落地时仍有新请求在飞，
      // 此时置 false 会让触底守卫放行出第三次请求
      if (requestId === listRequestId)
        loading.value = false
    }
  }

  // 统一的触底加载：直播 / 回放 / 公演共用同一套交互逻辑
  const { onInfiniteScroll } = useLoadMore({
    load: getList,
    disabled,
    scrollbarRef,
  })

  /** 仅重置列表状态，不发起请求（多列表联动的刷新序列里使用） */
  function reset() {
    list.value = []
    listNext.value = '0'
    noMore.value = false
    loadFailed.value = false
    replaceOnSuccess = false
  }

  /** 重置后拉取第一页；返回 getList 的 Promise，调用方需要时可 await 其成功与否 */
  function refresh(): Promise<boolean> {
    reset()
    return getList()
  }

  /**
   * 软刷新：不清空列表，直接从第一页重拉，成功后整体替换。
   * 刷新期间旧卡片继续展示（列表非空 → 页面不会切到骨架屏 / 空态），
   * 失败时恢复原游标与 noMore，旧列表保持可用、可继续触底翻页。
   */
  async function softRefresh(): Promise<boolean> {
    const snapshot = { next: listNext.value, noMore: noMore.value }
    listNext.value = '0'
    noMore.value = false
    replaceOnSuccess = true
    const pending = getList()
    // getList 同步递增序号：记下本次请求号，用来判断回包时是否已被更新的请求取代
    const requestId = listRequestId
    const ok = await pending
    if (!ok && requestId === listRequestId && replaceOnSuccess) {
      replaceOnSuccess = false
      listNext.value = snapshot.next
      noMore.value = snapshot.noMore
      debugLog('list', `①翻页: 软刷新失败，保留旧列表 ${list.value.length} 条并恢复游标 next=${snapshot.next}`)
    }
    return ok
  }

  /**
   * 回到列表顶部并拉取第一页：手动刷新按钮与「双击回顶」手势的统一入口；列表未渲染时静默跳过。
   * keepList=true 走软刷新（见 softRefresh），默认仍是清空后重拉
   */
  function refreshFromTop(options?: RefreshOptions): Promise<boolean> {
    scrollbarRef.value?.setScrollTop?.(0)
    return options?.keepList ? softRefresh() : refresh()
  }

  return {
    list, // 列表数据
    listNext, // 分页游标
    loading, // 加载状态
    noMore, // 是否没有更多数据
    disabled, // 是否禁用加载更多
    /** 最近一次加载是否失败：供 useLoadMore 终止自动补拉，也供调用方判断是否展示重试入口 */
    loadFailed,
    scrollbarRef, // 滚动条引用
    onInfiniteScroll, // 触底加载事件
    getList, // 分页加载函数
    reset, // 仅重置列表状态，不发起请求（多列表联动的刷新序列里使用）
    refresh, // 刷新重置后拉取第一页
    softRefresh, // 保留旧列表的刷新：成功整体替换，失败原样保留
    refreshFromTop, // 回顶 + 刷新重置（手动刷新 / 双击回顶手势）
  }
}

export default usePagedList
