import type { Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import useMinVisibleLoading from '../src/renderer/src/composables/use-min-visible-loading'

/** 受控 loading 源 + 独立作用域（组件卸载靠 onScopeDispose 清理） */
function setup(source = false, minMs?: number) {
  const loading = ref(source)
  const scope = effectScope()
  const visible = scope.run(() => useMinVisibleLoading(() => loading.value, minMs)) as Ref<boolean>
  return { loading, visible, stop: () => scope.stop() }
}

describe('useMinVisibleLoading', () => {
  beforeEach(() => {
    // Date 一起 fake：判定全靠 Date.now() 与定时器的相对关系
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始未加载时不会先亮一下', () => {
    const { visible } = setup()
    expect(visible.value).toBe(false)
  })

  it('挂载时已在加载则立即点亮', () => {
    const { visible } = setup(true)
    expect(visible.value).toBe(true)
  })

  it('回包极快（80ms）时指示被拉长到最短可见时长', async () => {
    const { loading, visible } = setup()
    loading.value = true
    await nextTick()
    expect(visible.value).toBe(true)

    vi.advanceTimersByTime(80)
    loading.value = false
    await nextTick()
    expect(visible.value).toBe(true)

    vi.advanceTimersByTime(519)
    expect(visible.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(visible.value).toBe(false)
  })

  it('真实耗时超过保底时长时不额外延长', async () => {
    const { loading, visible } = setup()
    loading.value = true
    await nextTick()
    vi.advanceTimersByTime(2000)
    loading.value = false
    await nextTick()
    expect(visible.value).toBe(false)
  })

  it('抖动时不闪灭：落下后又立刻升起，指示保持常亮', async () => {
    const { loading, visible } = setup()
    loading.value = true
    await nextTick()
    loading.value = false
    await nextTick()

    vi.advanceTimersByTime(100)
    loading.value = true
    await nextTick()
    vi.advanceTimersByTime(600)
    // 原定 500ms 后的收起已被取消，否则这里会看到「灭一下又亮」
    expect(visible.value).toBe(true)

    // 这一轮已亮满时长，落下即熄
    loading.value = false
    await nextTick()
    expect(visible.value).toBe(false)
  })

  it('自定义时长生效', async () => {
    const { loading, visible } = setup(false, 1200)
    loading.value = true
    await nextTick()
    loading.value = false
    await nextTick()
    vi.advanceTimersByTime(1100)
    expect(visible.value).toBe(true)
    vi.advanceTimersByTime(100)
    expect(visible.value).toBe(false)
  })

  it('作用域停止后挂起的收起不再改动状态', async () => {
    const { loading, visible, stop } = setup()
    loading.value = true
    await nextTick()
    loading.value = false
    await nextTick()
    expect(visible.value).toBe(true)

    stop()
    vi.advanceTimersByTime(2000)
    expect(visible.value).toBe(true)
  })
})
