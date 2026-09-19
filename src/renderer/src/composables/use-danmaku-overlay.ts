import { shallowRef } from 'vue'

/** 弹幕投放所需的最小字段：seconds 为解析时预计算的播放时刻（已排序） */
export interface DanmakuOverlayEntry {
  seconds: number
  content: string
  username: string
}

export interface DanmakuOverlayItem {
  id: number
  content: string
  // 发送者显示名，用于气泡内作者前缀
  username: string
  // 逾期即从顶部淡出（以播放进度为基准，seek/倍速自动同步）
  expireAt: number
}

interface UseDanmakuOverlayOptions {
  /** 全量弹幕数据源（按 seconds 升序） */
  getEntries: () => DanmakuOverlayEntry[]
}

// 新弹幕出现后展示的播放时长（秒）：这段时间内固定在堆叠条中，逾期后从顶部挤出
const DISPLAY_SECONDS = 6
// 堆叠条最多同时容纳的弹幕条数：超过后被最早（顶部）的挤出
const MAX_ITEMS = 30

/** 二分查找第一条 seconds >= target 的弹幕下标（列表须已按 seconds 升序） */
export function findBarrageIndex(entries: Array<{ seconds: number }>, target: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (entries[mid].seconds < target)
      low = mid + 1
    else
      high = mid
  }
  return low
}

/**
 * 视频弹幕叠加层引擎（左下角玻璃条模式）：弹幕纵向堆叠，最新一条在底部、旧的上移。
 * 数组即全部可见气泡，不自带渲染循环——回收由宿主在 timeupdate 路径（advanceTo）驱动，
 * seek/重播经 seekTo 清空重建；暂停时进度不推进，堆叠自然静止。
 */
export function useDanmakuOverlay(options: UseDanmakuOverlayOptions) {
  const { getEntries } = options

  // 可见气泡，[0] 为最新（渲染在底部）；旧的自数组尾部挤出
  const items = shallowRef<DanmakuOverlayItem[]>([])
  // 指向 getEntries() 的游标：advanceTo 推进、seekTo 二分重置
  let cursor = 0
  let nextId = 0

  function spawn(entry: DanmakuOverlayEntry) {
    if (!entry.content)
      return

    const item: DanmakuOverlayItem = {
      id: nextId++,
      content: entry.content,
      username: entry.username,
      expireAt: entry.seconds + DISPLAY_SECONDS,
    }
    // 新弹幕压到最前（底部）；超出上限时最旧的一条从尾部挤出
    items.value = [item, ...items.value].slice(0, MAX_ITEMS)
  }

  /** 把 seconds <= time 的弹幕投放进堆叠条 */
  function processUpTo(time: number) {
    const list = getEntries()
    while (cursor < list.length && list[cursor].seconds <= time) {
      spawn(list[cursor])
      cursor++
    }
  }

  /** 逾期条目从尾部（顶部）挤出；进度静止（暂停/seek）时不回收 */
  function prune(time: number) {
    const current = items.value
    if (current.length === 0)
      return
    let drop = 0
    while (drop < current.length && current[current.length - 1 - drop].expireAt < time)
      drop++
    if (drop > 0)
      items.value = current.slice(0, current.length - drop)
  }

  /**
   * 推进进度（timeupdate 唯一入口）。
   * 倒放/回跳无需额外判断：反向跳转一律走 seekTo，游标在那里被二分重置。
   */
  function advanceTo(time: number) {
    processUpTo(time)
    prune(time)
  }

  /**
   * seek / 重播统一入口：游标定位到「展示窗口起点」而非目标时刻本身，
   * 再经 advanceTo 把窗口内仍在展示期的弹幕填回 —— 否则拖到弹幕密集处会先空窗 DISPLAY_SECONDS 秒。
   * 左端为负时二分自然夹到 0（等价于从开头投放），更早的历史由 prune 剔除，不会倒灌。
   */
  function seekTo(time: number) {
    items.value = []
    cursor = findBarrageIndex(getEntries(), time - DISPLAY_SECONDS)
    advanceTo(time)
  }

  return { items, advanceTo, seekTo }
}
