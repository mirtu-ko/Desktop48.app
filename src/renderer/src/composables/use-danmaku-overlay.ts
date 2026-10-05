import type { DanmakuSegment } from '@renderer/utils/danmaku-content'
import type { DanmakuEmoteMap } from '../../../common/live-danmaku'
import { splitDanmakuContent } from '@renderer/utils/danmaku-content'
import { shallowRef } from 'vue'

/** 弹幕条目：seconds 为预计算的播放时刻（已排序） */
export interface DanmakuOverlayEntry {
  seconds: number
  content: string
  username: string
  /** 表情表；缺省表示这条弹幕没有表情 */
  emots?: DanmakuEmoteMap
}

export interface DanmakuOverlayItem {
  id: number
  content: string
  // 发送者显示名（气泡内作者前缀）
  username: string
  /** 渲染片段：文本与表情图交替。切分在入队时收口，模板只管画 */
  segments: DanmakuSegment[]
  // 逾期即从顶部淡出，以播放进度为基准
  expireAt: number
}

interface UseDanmakuOverlayOptions {
  /** 全量弹幕数据源（按 seconds 升序） */
  getEntries: () => DanmakuOverlayEntry[]
}

// 每条弹幕在堆叠中的展示时长（秒），逾期自顶部挤出
const PLAYBACK_DISPLAY_SECONDS = 6
// 与录播分开：两边弹幕密度差一个数量级，要能各自调
const LIVE_DISPLAY_SECONDS = 6
// 堆叠条容量上限，超出后挤出最旧的
const MAX_ITEMS = 30

/** 二分查找第一条 seconds >= target 的弹幕下标（列表须按 seconds 升序） */
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
 * 掐掉数组尾部已过期的气泡（最新一条在 [0]）。只在宿主推进时调用，故暂停 / seek 期间不回收。
 * 一条都没过期时原样返回同一个数组：引用不变，shallowRef 不触发重渲染。
 */
function dropExpired(items: DanmakuOverlayItem[], time: number): DanmakuOverlayItem[] {
  let drop = 0
  while (drop < items.length && items[items.length - 1 - drop].expireAt < time)
    drop++
  return drop > 0 ? items.slice(0, items.length - drop) : items
}

/**
 * 录播弹幕叠加层引擎（左下角玻璃条）：数组即全部可见气泡，最新一条在 [0]（渲染于底部）。
 * 不自带渲染循环 —— 由宿主在 timeupdate 调 advanceTo 推进，seek/重播走 seekTo 重建。
 */
export function useDanmakuOverlay(options: UseDanmakuOverlayOptions) {
  const { getEntries } = options

  // 可见气泡，[0] 为最新；旧的自数组尾部挤出
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
      segments: splitDanmakuContent(entry.content, entry.emots),
      expireAt: entry.seconds + PLAYBACK_DISPLAY_SECONDS,
    }
    items.value = [item, ...items.value].slice(0, MAX_ITEMS)
  }

  /** 把到点的弹幕投放进堆叠条 */
  function processUpTo(time: number) {
    const list = getEntries()
    while (cursor < list.length && list[cursor].seconds <= time) {
      spawn(list[cursor])
      cursor++
    }
  }

  /** 推进进度（timeupdate 唯一入口）。反向跳转一律走 seekTo，此处无需判向 */
  function advanceTo(time: number) {
    processUpTo(time)
    items.value = dropExpired(items.value, time)
  }

  /**
   * seek / 重播统一入口。游标定位到「展示窗口起点」而非目标时刻本身，再交给 advanceTo
   * 把窗口内仍在展示期的弹幕填回 —— 否则拖到弹幕密集处会先空窗 PLAYBACK_DISPLAY_SECONDS 秒。
   */
  function seekTo(time: number) {
    items.value = []
    cursor = findBarrageIndex(getEntries(), time - PLAYBACK_DISPLAY_SECONDS)
    advanceTo(time)
  }

  return { items, advanceTo, seekTo }
}

/** 待投放弹幕：showAt 为宿主时钟下的应显示时刻（秒），到点才进 items */
interface PendingDanmaku {
  content: string
  username: string
  segments: DanmakuSegment[]
  showAt: number
}

// 待投放队列上限：正常一个节拍就清空，兜住宿主定时器停摆或瞬时爆发；超出时丢排队最久的那条
const MAX_PENDING = 300

/**
 * 直播弹幕叠加层引擎。与录播引擎的关键差别：条目到达即排入待投放队列，不保留历史条目 ——
 * 录播用游标索引数组，从头部裁剪会让游标错位，两者不能共用同一份状态。
 * 时间轴由宿主提供，投放与回收都由宿主定时器驱动。
 */
export function useLiveDanmakuOverlay() {
  // 可见气泡，[0] 为最新；旧的自数组尾部挤出
  const items = shallowRef<DanmakuOverlayItem[]>([])
  let pending: PendingDanmaku[] = []
  let nextId = 0

  /** 排入一条弹幕；showAt 到点后由 tick 投放（同一批共用同一时刻，批内先后由 push 顺序保证） */
  function push(content: string, username: string, showAt: number, emots?: DanmakuEmoteMap) {
    if (!content)
      return

    // 切分在入队时做一次：模板里同一条会被 patch 多次，放那儿是白烧 CPU
    pending.push({ content, username, segments: splitDanmakuContent(content, emots), showAt })
    if (pending.length > MAX_PENDING)
      pending.shift()
  }

  /**
   * 宿主定时器唯一入口：先投放到点弹幕，再回收逾期气泡。
   * 投放用整表扫描而非「遇到第一条未到点就停」—— showAt 由调用方给，后入队的可以更早，队列不保证有序。
   */
  function tick(time: number) {
    if (pending.length > 0) {
      const due: PendingDanmaku[] = []
      const waiting: PendingDanmaku[] = []
      for (const item of pending)
        (item.showAt <= time ? due : waiting).push(item)
      pending = waiting

      if (due.length > 0) {
        // 后到的排在前（items[0] 渲染在底部），故 due 反转后整体前插
        const spawned: DanmakuOverlayItem[] = due.reverse().map(item => ({
          id: nextId++,
          content: item.content,
          username: item.username,
          segments: item.segments,
          expireAt: time + LIVE_DISPLAY_SECONDS,
        }))
        items.value = [...spawned, ...items.value].slice(0, MAX_ITEMS)
      }
    }

    items.value = dropExpired(items.value, time)
  }

  /** 会话切换时清空：时间轴原点会重置，遗留的待投放弹幕在新轴上全是错时刻 */
  function reset() {
    pending = []
    items.value = []
  }

  return { items, push, tick, reset }
}
