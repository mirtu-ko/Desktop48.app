import type { Ref } from 'vue'
import { nextTick, ref } from 'vue'
import { debugLog } from '../../utils/debug'

export interface UseLoadMoreOptions {
  /**
   * 触底加载回调：内部负责追加数据并维护 loading / noMore 状态。
   * 返回 false 表示本次加载失败（供自动补拉递归终止）；返回 void/true 视为成功
   */
  load: () => Promise<void | boolean> | void | boolean
  /** 是否禁用触底加载（加载中或已无更多数据时返回 true，拦截重复请求） */
  disabled: Ref<boolean> | (() => boolean)
  /** 绑定到 el-scrollbar 的 ref，用于读取滚动位置；不传时内部自动创建 */
  scrollbarRef?: Ref<any>
  /** 距离底部多少像素视为触底，默认 10 */
  distance?: number
}

/**
 * 直播 / 回放 / 公演三个列表页共用的"加载更多"交互逻辑。
 * 依赖 el-scrollbar 的 end-reached 事件触发，同时手动校验滚动位置与禁用态，
 * 避免加载中 / 已无更多数据时重复请求导致分页数据错乱。
 */
export function useLoadMore({
  load,
  disabled,
  scrollbarRef = ref<any>(null),
  distance = 10,
}: UseLoadMoreOptions) {
  const isDisabled = (): boolean =>
    typeof disabled === 'function' ? disabled() : disabled.value

  /** 补拉前的守卫：load 返回 false 表示本次加载失败，终止“不足一屏自动补拉”的递归 */
  async function onInfiniteScroll(): Promise<void> {
    if (isDisabled())
      return
    const wrap: HTMLElement | undefined = scrollbarRef.value?.wrapRef
    if (wrap) {
      const nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - distance - 1
      if (!nearBottom)
        return
    }
    const ok = await load()
    // 首屏只有零星几条时内容不足一屏，滚动条都不出现，end-reached 永远不会触发；
    // 这里在渲染完成后自动补齐下一页，直到填满视口或没有更多数据。
    // 加载失败（ok===false）时必须终止：列表为空 → 内容永远不足一屏 → 无限递归
    if (ok === false || !wrap || isDisabled()) {
      debugLog('load-more', `本次加载结束（${ok === false ? '加载失败，终止自动补拉' : '无更多数据或已禁用'}）`)
      return
    }
    await nextTick()
    if (wrap.scrollHeight <= wrap.clientHeight) {
      debugLog('load-more', '内容不足一屏，自动补拉下一页')
      await onInfiniteScroll()
    }
  }

  return { scrollbarRef, onInfiniteScroll }
}

export default useLoadMore
