import type { LiveListContent, LiveListItem, LiveListItemView } from '@renderer/services/api-types'
import type { Ref } from 'vue'
import type { UsePagedListOptions } from './use-paged-list'
import { useBlockedMembersStore } from '@renderer/stores/member-flags'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { usePagedList } from './use-paged-list'

export interface UsePagedLiveListOptions {
  /** 请求一页数据：返回 { next, liveList }；通过闭包可注入筛选参数 */
  loadPage: (_next: string) => Promise<LiveListContent> | LiveListContent
  /**
   * 并行补全单个条目的展示信息；在过滤屏蔽成员之后执行。
   * 返回新对象 → 用它替换列表中的条目；返回 undefined → 沿用原对象
   */
  processItem?: (_item: LiveListItem, _index: number) => Promise<LiveListItemView | void> | LiveListItemView | void
  /** 是否按屏蔽名单过滤被屏蔽成员，默认 true */
  filterBlocked?: boolean
  /** 请求失败时是否标记为"没有更多"，从而停止触底重试；Lives 默认 false，Playbacks 为 true */
  stopOnError?: boolean
  /** 列表滚动容器 ref：透传给 usePagedList，见 use-paged-list.ts */
  scrollbarRef?: Ref<any>
}

/**
 * 直播 / 回放列表共用的分页加载逻辑：在通用 usePagedList（use-paged-list.ts）
 * 之上叠加「按屏蔽名单过滤」的领域行为，并适配 { next, liveList } 响应结构。
 *
 * 列表元素类型固定为 LiveListItemView：上游给的是 LiveListItem，
 * 经 processItem（enrichLiveItem）补全后才具备 cover/date/member。
 */
export function usePagedLiveList({
  loadPage,
  processItem,
  filterBlocked = true,
  stopOnError = false,
  scrollbarRef,
}: UsePagedLiveListOptions) {
  // 屏蔽名单读 store（跨页共享的唯一一份），不另建本地副本：
  // 另建会在用户于成员页屏蔽后、回直播页要等下次翻页才生效，且每翻页多一次 IPC
  const { ensureBlockedLoaded, isBlocked } = useBlockedMembersStore()

  const options: UsePagedListOptions<LiveListItem, LiveListItemView> = {
    itemKey: item => item.liveId,
    stopOnError,
    scrollbarRef,
    loadPage: async (next) => {
      const content = await loadPage(next)
      return { next: content.next, items: content.liveList || [] }
    },
    processItem,
  }

  if (filterBlocked) {
    // 过滤前确保名单已加载：不能假定调用方一定先访问过成员页 / 设置页 ——
    // 启动后直奔直播页时 store 仍是空名单，直接过滤等于放行全部被屏蔽成员。
    // ensureBlockedLoaded 幂等，仅首次真正请求，后续翻页不产生额外 IPC。
    options.filterItems = async (items) => {
      await ensureBlockedLoaded()
      return items.filter((item: any) => !isBlocked(item.userInfo?.userId))
    }
  }

  return usePagedList(options)
}

/**
 * 直播 / 回放列表条目的展示信息补全：封面归一化、日期格式化、关联成员。
 *
 * 返回**新对象**，不原地改入参：入参是接口 payload，混进派生字段会让
 * LiveListItem 的类型声明失真（teamLogo 曾被从 string 原地改成 string[]）。
 *
 * memberError 决定成员查询失败时的行为：
 * - 'fallback'：成员置 null 并打错误日志（直播页逐条容错）
 * - 'throw'：向上抛出，交由 usePagedList 的 stopOnError 接管（回放页整批停止）
 */
export async function enrichLiveItem(
  item: LiveListItem,
  memberError: 'fallback' | 'throw' = 'throw',
): Promise<LiveListItemView> {
  const view: LiveListItemView = {
    ...item,
    cover: Tools.pictureUrls(item.coverPath),
    date: dayjs(Number.parseFloat(item.ctime)).format('YYYY-MM-DD HH:mm:ss'),
    member: null,
  }
  if (memberError === 'fallback') {
    try {
      view.member = await window.mainAPI.getMemberInfo(Tools.normalizeUserId(view.userInfo.userId)) ?? null
    }
    catch (e) {
      view.member = null
      console.error('获取成员信息失败:', e)
      debugLog('list', `②补全降级: liveId=${view.liveId} 成员 ${view.userInfo.userId} 查询失败 → member=null（卡片降级渲染）`)
    }
    return view
  }
  view.member = await window.mainAPI.getMemberInfo(Tools.normalizeUserId(view.userInfo.userId)) ?? null
  return view
}

export default usePagedLiveList
