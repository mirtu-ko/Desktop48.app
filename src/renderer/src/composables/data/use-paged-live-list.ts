import type { LiveListContent, LiveListItem } from '../../services/api-types'
import type { UsePagedListOptions } from './use-paged-list'
import { ref } from 'vue'
import Tools from '../../utils/tools'
import { usePagedList } from './use-paged-list'

// 条目与分页响应的结构定义已收敛至 services/api-types.ts，
// 这里保留历史命名的类型别名，既有导入不受影响
export type PagedLive = LiveListItem
export type PagedLiveResponse<T = LiveListItem> = LiveListContent<T>

export interface UsePagedLiveListOptions<T> {
  /** 请求一页数据：返回 { next, liveList }；通过闭包可注入筛选参数 */
  loadPage: (_next: string) => Promise<PagedLiveResponse<T>> | PagedLiveResponse<T>
  /** 并行补全单个条目的展示信息（封面 / 成员 / 日期等）；在过滤屏蔽成员之后执行 */
  processItem?: (_item: T, _index: number) => Promise<void> | void
  /** 是否在每次翻页前拉取并过滤被屏蔽成员，默认 true */
  filterBlocked?: boolean
  /** 请求失败时是否标记为"没有更多"，从而停止触底重试；Lives 默认 false，Reviews 为 true */
  stopOnError?: boolean
}

/**
 * 直播 / 回放列表共用的分页加载逻辑：在通用 usePagedList（use-paged-list.ts）
 * 之上叠加「拉取被屏蔽成员并过滤」的领域行为，并适配 { next, liveList } 响应结构。
 */
export function usePagedLiveList<T extends PagedLive = PagedLive>({
  loadPage,
  processItem,
  filterBlocked = true,
  stopOnError = false,
}: UsePagedLiveListOptions<T>) {
  const blockedMemberIds = ref<number[]>([])
  async function updateBlockedMemberIds() {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    const blockedMembers = await window.mainAPI.getBlockedMembers()
    blockedMemberIds.value = blockedMembers.map(member => member.userId)
  }

  const options: UsePagedListOptions<T> = {
    itemKey: item => item.liveId,
    stopOnError,
    loadPage: async (next) => {
      const content = await loadPage(next)
      return { next: content.next, items: content.liveList || [] }
    },
    processItem,
  }

  if (filterBlocked) {
    options.filterItems = async (items) => {
      await updateBlockedMemberIds()
      return items.filter(
        (item: any) => !blockedMemberIds.value.includes(Number.parseInt(item.userInfo.userId)),
      )
    }
  }

  return usePagedList(options)
}

/**
 * 直播 / 回放列表条目的展示信息补全：封面 / 队伍 Logo 归一化、日期格式化、关联成员。
 * Lives 与 Reviews 的 processItem 共用；memberError 决定成员查询失败时的行为：
 * - 'fallback'：成员置 null 并打错误日志（直播页逐条容错）
 * - 'throw'：向上抛出，交由 usePagedList 的 stopOnError 接管（回放页整批停止）
 */
export async function enrichLiveItem(item: any, memberError: 'fallback' | 'throw' = 'throw'): Promise<void> {
  item.cover = Tools.pictureUrls(item.coverPath)
  item.userInfo.teamLogo = Tools.pictureUrls(item.userInfo.teamLogo)
  item.date = Tools.dateFormat(Number.parseFloat(item.ctime), 'yyyy-MM-dd hh:mm:ss')
  if (memberError === 'fallback') {
    try {
      item.member = await window.mainAPI.getMemberInfo(item.userInfo.userId)
    }
    catch (e) {
      item.member = null
      console.error('获取成员信息失败:', e)
    }
    return
  }
  item.member = await window.mainAPI.getMemberInfo(item.userInfo.userId)
}

export default usePagedLiveList
