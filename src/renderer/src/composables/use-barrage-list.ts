import type { BarrageListItem } from '@renderer/components/danmaku/Barrage.vue'
import Apis from '@renderer/services/apis'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { ref, shallowRef } from 'vue'
import { findBarrageIndex } from './use-danmaku-overlay'

// 右侧列表与叠加层的进度基准不同（列表滞后 1s），各自维护一个游标；
// 叠加层游标在 use-danmaku-overlay 内部，这里只管列表游标
const MAX_LIST_ITEMS = 500
const LIST_DELAY_SECONDS = 1

/**
 * 录播弹幕数据源与右侧列表游标：
 * 解析时就把 [hh:mm:ss] 转成秒并排序，所有消费方（列表 / 叠加层）
 * 只持有指向 entries 的游标，不再复制数组。
 */
export function useBarrageList() {
  // 弹幕唯一数据源（按 seconds 升序）
  const entries = shallowRef<BarrageListItem[]>([])
  // 右侧列表当前展示的弹幕：从头累积到当前进度，超出上限时丢弃最早的
  const items = shallowRef<BarrageListItem[]>([])
  const loaded = ref(false)
  const loadedUrl = ref('')
  let cursor = 0

  /** 加载并解析指定 url 的弹幕；url 未变化时跳过；返回是否拿到了新数据 */
  async function load(url: string): Promise<boolean> {
    if (!url || loadedUrl.value === url)
      return false

    try {
      const response = await Apis.barrage(url)
      loadedUrl.value = url
      // 预计算秒数并排序，之后游标推进与二分查找都不必再解析时间字符串
      entries.value = Tools.lyricsParse(response)
        .map((item: any, index: number) => ({
          id: index,
          seconds: Tools.timeToSecond(item.time),
          time: item.time,
          username: item.username,
          content: item.content,
        }))
        .sort((a, b) => a.seconds - b.seconds)
      loaded.value = true
      return true
    }
    catch (error: any) {
      console.error('[use-barrage-list] 弹幕加载失败:', error)
      ElMessage({ message: '弹幕加载失败', type: 'error' })
      return false
    }
  }

  /** seek / 重播：游标二分定位到目标时刻，列表按“从头到当前”重建 */
  function buildUpTo(time: number) {
    cursor = findBarrageIndex(entries.value, time - LIST_DELAY_SECONDS)
    // 保持原有体验：拖动进度后列表展示视频开始到当前时刻的全部弹幕
    items.value = cursor > MAX_LIST_ITEMS
      ? entries.value.slice(cursor - MAX_LIST_ITEMS, cursor)
      : entries.value.slice(0, cursor)
  }

  /** timeupdate：推进游标，把新出现的弹幕追加进列表 */
  function advanceTo(time: number) {
    const list = entries.value
    const threshold = time - LIST_DELAY_SECONDS
    const start = cursor
    while (cursor < list.length && list[cursor].seconds <= threshold)
      cursor++

    if (cursor === start)
      return

    const merged = items.value.concat(list.slice(start, cursor))
    items.value = merged.length > MAX_LIST_ITEMS
      ? merged.slice(merged.length - MAX_LIST_ITEMS)
      : merged
  }

  /** 切换弹幕源：清空数据与全部标记 */
  function reset() {
    entries.value = []
    items.value = []
    loaded.value = false
    loadedUrl.value = ''
    cursor = 0
  }

  return { entries, items, loaded, load, buildUpTo, advanceTo, reset }
}
