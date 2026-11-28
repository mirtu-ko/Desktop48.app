import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { usePlayerControlsVisibility } from '../src/renderer/src/composables/use-player-controls-visibility'

describe('usePlayerControlsVisibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('播放中无操作超过 idleMs 后自动淡出，移动指针立即唤醒', () => {
    const scope = effectScope()
    const isFullscreen = ref(false)
    const state = scope.run(() => usePlayerControlsVisibility({
      isFullscreen,
      keepVisible: () => false,
      idleMs: 2500,
    }))!

    expect(state.controlsVisible.value).toBe(true)
    vi.advanceTimersByTime(2499)
    expect(state.controlsVisible.value).toBe(true)

    vi.advanceTimersByTime(1)
    expect(state.controlsVisible.value).toBe(false)

    state.reveal()
    expect(state.controlsVisible.value).toBe(true)
    vi.advanceTimersByTime(2500)
    expect(state.controlsVisible.value).toBe(false)

    scope.stop()
  })

  it('keepVisible 或悬停在控件上时锁定常驻，解除后恢复空闲淡出', async () => {
    const scope = effectScope()
    const isFullscreen = ref(false)
    const paused = ref(true)
    const state = scope.run(() => usePlayerControlsVisibility({
      isFullscreen,
      keepVisible: () => paused.value,
      idleMs: 2000,
    }))!

    vi.advanceTimersByTime(5000)
    expect(state.controlsVisible.value).toBe(true)

    paused.value = false
    await nextTick()
    vi.advanceTimersByTime(1999)
    expect(state.controlsVisible.value).toBe(true)

    state.onControlEnter()
    vi.advanceTimersByTime(5000)
    expect(state.controlsVisible.value).toBe(true)

    state.onControlLeave()
    vi.advanceTimersByTime(2000)
    expect(state.controlsVisible.value).toBe(false)

    scope.stop()
  })

  it('全屏淡出时同步隐藏鼠标指针，退出或唤醒后恢复', async () => {
    const scope = effectScope()
    const isFullscreen = ref(true)
    const state = scope.run(() => usePlayerControlsVisibility({
      isFullscreen,
      keepVisible: () => false,
      idleMs: 1000,
    }))!

    expect(state.cursorHidden.value).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(state.controlsVisible.value).toBe(false)
    expect(state.cursorHidden.value).toBe(true)

    state.reveal()
    expect(state.cursorHidden.value).toBe(false)

    vi.advanceTimersByTime(1000)
    expect(state.cursorHidden.value).toBe(true)

    isFullscreen.value = false
    await nextTick()
    expect(state.controlsVisible.value).toBe(true)
    expect(state.cursorHidden.value).toBe(false)

    scope.stop()
  })

  it('非全屏指针离开窗口后按 leaveMs 快速淡出', () => {
    const scope = effectScope()
    const isFullscreen = ref(false)
    const state = scope.run(() => usePlayerControlsVisibility({
      isFullscreen,
      keepVisible: () => false,
      idleMs: 2800,
      leaveMs: 300,
    }))!

    state.onContainerLeave()
    vi.advanceTimersByTime(299)
    expect(state.controlsVisible.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(state.controlsVisible.value).toBe(false)

    scope.stop()
  })
})
