import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useLoadMore } from '../src/renderer/src/composables/use-load-more'

// 被测的是「什么时候该拉下一页」，与日志无关
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface FakeWrap {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** el-scrollbar 替身：只需要 wrapRef 上参与触底判定的三个尺寸字段 */
function scrollbarOf(wrap: FakeWrap) {
  return ref({ wrapRef: wrap as unknown as HTMLElement })
}

function setup(options: {
  wrap?: FakeWrap
  disabled?: boolean | (() => boolean)
  load?: () => void | boolean
  distance?: number
}) {
  const load = vi.fn(options.load ?? (() => true))
  const { onInfiniteScroll } = useLoadMore({
    load,
    disabled: typeof options.disabled === 'function' ? options.disabled : ref(options.disabled ?? false),
    scrollbarRef: scrollbarOf(options.wrap ?? { scrollTop: 0, clientHeight: 100, scrollHeight: 100 }),
    distance: options.distance,
  })
  return { load, onInfiniteScroll }
}

describe('useLoadMore 触底判定', () => {
  it('贴底时发起加载', async () => {
    const { load, onInfiniteScroll } = setup({ wrap: { scrollTop: 900, clientHeight: 100, scrollHeight: 1000 } })
    await onInfiniteScroll()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('离底部还远时拦截，不发起加载', async () => {
    const { load, onInfiniteScroll } = setup({ wrap: { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 } })
    await onInfiniteScroll()
    expect(load).not.toHaveBeenCalled()
  })

  it('distance 可调：放宽阈值后同一滚动位置即视为贴底', async () => {
    const wrap = { scrollTop: 800, clientHeight: 100, scrollHeight: 1000 }
    expect(wrap.scrollTop + wrap.clientHeight).toBe(900)

    const tight = setup({ wrap: { ...wrap }, distance: 10 })
    await tight.onInfiniteScroll()
    expect(tight.load).not.toHaveBeenCalled()

    const loose = setup({ wrap: { ...wrap }, distance: 150 })
    await loose.onInfiniteScroll()
    expect(loose.load).toHaveBeenCalledTimes(1)
  })

  it('滚动条尚未挂载时跳过位置校验，直接加载（但也不自动补拉）', async () => {
    const load = vi.fn(() => true)
    const { onInfiniteScroll } = useLoadMore({
      load,
      disabled: ref(false),
      scrollbarRef: ref({ wrapRef: undefined }),
    })
    await onInfiniteScroll()
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('useLoadMore 禁用态', () => {
  it('加载中 / 无更多（disabled 为真）时不重复请求', async () => {
    const { load, onInfiniteScroll } = setup({
      disabled: true,
      wrap: { scrollTop: 900, clientHeight: 100, scrollHeight: 1000 },
    })
    await onInfiniteScroll()
    expect(load).not.toHaveBeenCalled()
  })

  it('disabled 传函数时同样生效', async () => {
    const { load, onInfiniteScroll } = setup({
      disabled: () => true,
      wrap: { scrollTop: 900, clientHeight: 100, scrollHeight: 1000 },
    })
    await onInfiniteScroll()
    expect(load).not.toHaveBeenCalled()
  })

  it('补拉过程中转为禁用：立即停止，不再递归', async () => {
    const disabled = ref(false)
    const wrap: FakeWrap = { scrollTop: 0, clientHeight: 500, scrollHeight: 300 }
    const load = vi.fn(() => {
      disabled.value = true
      wrap.scrollHeight = 300 // 内容始终不足一屏，只有禁用态能刹住
    })
    const { onInfiniteScroll } = useLoadMore({ load, disabled, scrollbarRef: scrollbarOf(wrap) })

    await onInfiniteScroll()

    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('useLoadMore 不足一屏自动补拉', () => {
  it('内容撑满视口即停（首屏零星几条时不会无限拉下去）', async () => {
    let calls = 0
    const wrap: FakeWrap = { scrollTop: 0, clientHeight: 500, scrollHeight: 300 }
    const load = vi.fn(() => {
      calls += 1
      wrap.scrollHeight = 300 + calls * 100
    })
    const { onInfiniteScroll } = useLoadMore({ load, disabled: ref(false), scrollbarRef: scrollbarOf(wrap) })

    await onInfiniteScroll()

    // 300 → 400 → 500（仍不满）→ 600（撑满，停）
    expect(load).toHaveBeenCalledTimes(3)
    expect(wrap.scrollHeight).toBe(600)
  })

  it('load 返回 false（本次加载失败）即终止，避免空列表下无限递归', async () => {
    const wrap: FakeWrap = { scrollTop: 0, clientHeight: 500, scrollHeight: 300 }
    const load = vi.fn(() => false)
    const { onInfiniteScroll } = useLoadMore({ load, disabled: ref(false), scrollbarRef: scrollbarOf(wrap) })

    await onInfiniteScroll()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('load 返回 true / void 视为成功，继续补拉', async () => {
    const wrap: FakeWrap = { scrollTop: 0, clientHeight: 500, scrollHeight: 300 }
    const load = vi.fn(() => {
      wrap.scrollHeight += 400 // 一次就撑满
    })
    const { onInfiniteScroll } = useLoadMore({ load, disabled: ref(false), scrollbarRef: scrollbarOf(wrap) })

    await onInfiniteScroll()

    expect(load).toHaveBeenCalledTimes(1)
    expect(wrap.scrollHeight).toBe(700)
  })
})
