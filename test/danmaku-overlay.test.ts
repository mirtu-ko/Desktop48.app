import type { DanmakuOverlayEntry } from '../src/renderer/src/composables/use-danmaku-overlay'
import { describe, expect, it } from 'vitest'
import { findBarrageIndex, useDanmakuOverlay } from '../src/renderer/src/composables/use-danmaku-overlay'

/**
 * 展示时长与堆叠上限是引擎的行为契约，此处按字面量独立表达：
 * 改动实现常量时这些用例应当失败，提醒契约已变（而不是跟着实现一起漂移）。
 */
const DISPLAY_SECONDS = 6
const MAX_ITEMS = 30

/** 造升序弹幕源，content 按序编号便于断言 */
function makeEntries(seconds: number[]): DanmakuOverlayEntry[] {
  return seconds.map((second, index) => ({
    seconds: second,
    content: `c${index}`,
    username: `u${index}`,
  }))
}

function setup(seconds: number[]) {
  const entries = makeEntries(seconds)
  return {
    entries,
    ...useDanmakuOverlay({ getEntries: () => entries }),
  }
}

/** 便于断言的紧凑形态：最新在前 */
function contents(items: { content: string }[]) {
  return items.map(item => item.content)
}

describe('findBarrageIndex', () => {
  it('空列表返回 0', () => {
    expect(findBarrageIndex([], 5)).toBe(0)
  })

  it('精确命中返回该条下标', () => {
    expect(findBarrageIndex(makeEntries([1, 3, 5]), 3)).toBe(1)
  })

  it('落在两条之间返回后一条下标（即第一条 >= target）', () => {
    expect(findBarrageIndex(makeEntries([1, 3, 5]), 4)).toBe(2)
  })

  it('小于全部返回 0，大于全部返回 length', () => {
    const list = makeEntries([1, 3, 5])
    expect(findBarrageIndex(list, 0.5)).toBe(0)
    expect(findBarrageIndex(list, 99)).toBe(3)
  })

  it('同秒重复时返回最前一条，游标不会跳过它们', () => {
    expect(findBarrageIndex(makeEntries([2, 2, 2]), 2)).toBe(0)
  })
})

describe('useDanmakuOverlay / advanceTo', () => {
  it('只投放 seconds <= time 的弹幕，最新一条排在首位', () => {
    const { items, advanceTo } = setup([1, 2, 3])

    advanceTo(2)

    expect(contents(items.value)).toEqual(['c1', 'c0'])
  })

  it('同一时刻重复推进不会重复投放', () => {
    const { items, advanceTo } = setup([1, 2])

    advanceTo(2)
    advanceTo(2)

    expect(items.value).toHaveLength(2)
  })

  it('逾期条目按 expireAt = seconds + 展示时长 挤出，等于边界时仍保留', () => {
    const { items, advanceTo } = setup([0])

    advanceTo(0)
    expect(items.value).toHaveLength(1)

    advanceTo(DISPLAY_SECONDS)
    expect(items.value).toHaveLength(1)

    advanceTo(DISPLAY_SECONDS + 0.1)
    expect(items.value).toHaveLength(0)
  })

  it('进度静止（暂停）不回收已投放的弹幕', () => {
    const { items, advanceTo } = setup([0])

    advanceTo(0)
    advanceTo(0)

    expect(items.value).toHaveLength(1)
  })

  it('超过堆叠上限时挤掉最旧的一条，只保留最新 MAX_ITEMS 条', () => {
    const { items, advanceTo } = setup(Array.from<number>({ length: MAX_ITEMS + 5 }).fill(0))

    advanceTo(0)

    expect(items.value).toHaveLength(MAX_ITEMS)
    expect(items.value[0].content).toBe(`c${MAX_ITEMS + 4}`)
    expect(items.value[MAX_ITEMS - 1].content).toBe('c5')
  })

  it('空内容不投放（引擎侧兜底，正常已在解析阶段过滤）', () => {
    const entries: DanmakuOverlayEntry[] = [{ seconds: 0, content: '', username: 'u' }]
    const { items, advanceTo } = useDanmakuOverlay({ getEntries: () => entries })

    advanceTo(0)

    expect(items.value).toHaveLength(0)
  })

  it('投放到堆叠的 id 互不相同（模板 :key 依赖它）', () => {
    const { items, advanceTo } = setup([1, 2, 3])

    advanceTo(3)

    const ids = items.value.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('useDanmakuOverlay / seekTo', () => {
  it('回跳清空堆叠后只填回展示窗口内的弹幕，不倒灌历史', () => {
    const { items, advanceTo, seekTo } = setup([1, 2, 3, 4])

    advanceTo(4)
    expect(items.value).toHaveLength(4)

    seekTo(1)

    // 窗口 (1 - 6, 1] 内只有秒 1 这一条
    expect(contents(items.value)).toEqual(['c0'])
  })

  it('seek 到弹幕密集处立刻可见最近几条（旧行为会空窗展示时长）', () => {
    const { items, seekTo } = setup([30, 31, 32, 33, 34])

    seekTo(34)

    expect(contents(items.value)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0'])
  })

  it('seek 到窗口内无弹幕的时刻则为空', () => {
    const { items, seekTo } = setup([10, 11, 12, 20])

    seekTo(19)

    // 窗口 (13, 19] 内没有弹幕；10/11/12 落在窗口起点之前，不得倒灌
    expect(items.value).toHaveLength(0)
  })

  it('seek 到超过最后一条的时刻结果为空', () => {
    const { items, seekTo } = setup([1, 2])

    seekTo(999)

    expect(items.value).toHaveLength(0)
  })

  it('seek 到 0（重播）从开头重新投放', () => {
    const { items, seekTo } = setup([0, 1, 2])

    seekTo(0)

    expect(contents(items.value)).toEqual(['c0'])
  })

  it('重复 seek 到同一时刻结果稳定（幂等）', () => {
    const { items, seekTo } = setup([1, 2, 3])

    seekTo(3)
    const first = contents(items.value)
    seekTo(3)

    expect(contents(items.value)).toEqual(first)
  })

  it('回退后不重复投放：游标随目标时刻前移，而非重置到 0', () => {
    const { items, seekTo } = setup([1, 2, 3, 4, 5])

    seekTo(5)
    expect(items.value).toHaveLength(5)

    seekTo(3)

    // 窗口 (-3, 3] → 秒 1/2/3，各自只出现一次
    expect(contents(items.value)).toEqual(['c2', 'c1', 'c0'])
  })

  it('seek 之后继续推进不漏投放也不重复', () => {
    const { items, seekTo, advanceTo } = setup([1, 2, 3, 4, 5])

    seekTo(2)
    expect(contents(items.value)).toEqual(['c1', 'c0'])

    advanceTo(3)
    expect(contents(items.value)).toEqual(['c2', 'c1', 'c0'])
  })
})
