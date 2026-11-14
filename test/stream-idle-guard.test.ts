import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamIdleGuard, STREAM_IDLE_TIMEOUT_MS } from '../src/main/stream-idle-guard'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStreamIdleGuard（FFmpeg 输出空闲守卫）', () => {
  it('从创建起算，首帧迟迟不来也触发一次重建', () => {
    const onIdle = vi.fn()
    createStreamIdleGuard(onIdle)

    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 3)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('持续出流时每次数据刷新计时，不误触发', () => {
    const onIdle = vi.fn()
    const guard = createStreamIdleGuard(onIdle, 1000)

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(900)
      guard.touch()
    }
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('dispose 后不再触发：响应结束 / 进程退出不能干扰新会话', () => {
    const onIdle = vi.fn()
    const guard = createStreamIdleGuard(onIdle, 1000)
    guard.dispose()

    vi.advanceTimersByTime(5000)
    guard.touch()
    vi.advanceTimersByTime(5000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('已触发后 touch 不复活守卫', () => {
    const onIdle = vi.fn()
    const guard = createStreamIdleGuard(onIdle, 1000)
    vi.advanceTimersByTime(1000)
    guard.touch()

    vi.advanceTimersByTime(5000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})
