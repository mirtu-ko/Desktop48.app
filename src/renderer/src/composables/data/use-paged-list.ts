import type { Ref } from 'vue'
import { computed, ref } from 'vue'
import useLoadMore from './use-load-more'

/** 分页接口的归一化返回结构：next 为下一页游标（'0' 表示没有更多） */
export interface PagedPage<T> {
  next: string
  items: T[]
  [key: string]: any
}

export interface UsePagedListOptions<T> {
  /** 请求一页数据：返回 { next, items }；通过闭包可注入筛选参数 */
  loadPage: (_next: string) => Promise<PagedPage<T>> | PagedPage<T>
  /** 并行补全单个条目的展示信息（封面 / 成员 / 日期等）；在 filterItems 之后执行 */
  processItem?: (_item: T, _index: number) => Promise<void> | void
  /** 整页过滤钩子（如屏蔽成员过滤），在 processItem 之前执行 */
  filterItems?: (_items: T[]) => Promise<T[]> | T[]
  /** 列表条目唯一键：用于翻页去重，默认取 (item as any).liveId */
  itemKey?: (_item: T) => string
  /** 请求失败时是否标记为"没有更多"，从而停止触底重试；Lives 默认 false，Reviews 为 true */
  stopOnError?: boolean
}

/**
 * 分页列表通用逻辑（Lives / Reviews / Shows 三页共用）：
 * - 列表 / 游标 / loading / noMore 四件套
 * - 请求序号丢弃过期响应，避免刷新与滚动并发导致数据错乱
 * - 去重追加 + 触底加载（useLoadMore）
 * - 刷新重置（refresh）与仅重置（reset，供多列表联动场景使用）
 */
export function usePagedList<T>({
  loadPage,
  processItem,
  filterItems,
  itemKey = item => (item as any).liveId,
  stopOnError = false,
}: UsePagedListOptions<T>) {
  const list = ref<T[]>([]) as Ref<T[]>
  const listNext = ref('0')
  const loading = ref(false)
  const noMore = ref(false)
  /** 最近一次加载是否失败：useLoadMore 的“不足一屏自动补拉”据此终止，避免失败后无限重试 */
  const loadFailed = ref(false)

  const disabled = computed(() => loading.value || noMore.value)

  // 列表请求序号，用于丢弃过期响应，避免刷新/滚动并发时数据错乱
  let listRequestId = 0

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
      // console.info('[use-paged-list] 分页数据', 'requestId', requestId, 'listNext', page.next, page.items)
      if (requestId !== listRequestId)
        return false
      if (!page || !Array.isArray(page.items)) {
        console.warn('[use-paged-list] 分页数据不是数组或无内容', page?.items)
        loadFailed.value = true
        noMore.value = true
        return false
      }
      if (page.next === '0' || page.items.length === 0)
        noMore.value = true
      listNext.value = page.next

      // 先整页过滤（如屏蔽成员），再并行补全展示信息，避免逐条串行 await 拖慢列表加载
      let items = page.items
      if (filterItems)
        items = await filterItems(items)
      if (requestId !== listRequestId)
        return false
      if (processItem)
        await Promise.all(items.map((item, index) => processItem(item, index)))
      if (requestId !== listRequestId)
        return false
      // 兜底去重，避免接口分页边界返回重复项导致列表出现重复卡片
      const existedIds = new Set(list.value.map(item => itemKey(item)))
      list.value.push(...items.filter(item => !existedIds.has(itemKey(item))))
      return true
    }
    catch (error) {
      if (requestId !== listRequestId)
        return false
      console.info(error)
      loadFailed.value = true
      if (stopOnError)
        noMore.value = true
      return false
    }
    finally {
      loading.value = false
    }
  }

  // 统一的触底加载：直播 / 回放 / 公演共用同一套交互逻辑
  const scrollbarRef = ref<any>(null)
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
  }

  /** 重置后拉取第一页 */
  function refresh() {
    reset()
    getList()
  }

  return {
    list, // 列表数据
    listNext, // 分页游标
    loading, // 加载状态
    noMore, // 是否没有更多数据
    disabled, // 是否禁用加载更多
    /** 最近一次加载是否失败（供 useLoadMore 终止自动补拉；失败时 UI 也可据此显示重试入口） */
    loadFailed, // 最近一次加载是否失败
    scrollbarRef, // 滚动条引用
    onInfiniteScroll, // 触底加载事件
    getList, // 分页加载函数
    reset, // 仅重置列表状态，不发起请求（多列表联动的刷新序列里使用）
    refresh, // 刷新重置后拉取第一页
  }
}

export default usePagedList
