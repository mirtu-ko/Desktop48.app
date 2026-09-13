import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useStreamRetry } from '../src/renderer/src/composables/use-stream-retry'

// ElMessage 在 Node 环境没有可挂载的 DOM，且用例只关心"有没有提示"
const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { warning: warningMock } }))

const RETRY_DELAY = 1000

function setup(overrides: Partial<Parameters<typeof useStreamRetry>[0]> = {}) {
  const mediaLoading = ref(true)
  const attempt = vi.fn(async () => {})
  const onExhausted = vi.fn()
  const retry = useStreamRetry({
    maxRetries: 3,
    retryDelayMs: RETRY_DELAY,
    isDisposed: () => false,
    mediaLoading,
    attempt,
    onExhausted,
    ...overrides,
  })
  return { mediaLoading, attempt, onExhausted, retry }
}

beforeEach(() => {
  vi.useFakeTimers()
  // 失败分支会 console.error
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  warningMock.mockClear()
})

describe('useStreamRetry 重试节奏', () => {
  it('schedule 先计数、亮恢复态与加载态，到点才真正尝试', async () => {
    const { retry, attempt, mediaLoading } = setup()

    retry.schedule()
    expect(retry.retryCount.value).toBe(1)
    expect(retry.isRecoveringStream.value).toBe(true)
    expect(mediaLoading.value).toBe(true)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY - 1)
    expect(attempt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('重入守卫：恢复期间重复 schedule 只安排一次（错误事件连发时不消耗重试预算）', async () => {
    const { retry, attempt } = setup()

    retry.schedule()
    retry.schedule()
    retry.schedule()

    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(retry.retryCount.value).toBe(1)
  })

  it('isDisposed 后不再安排任何重试', async () => {
    const { retry, attempt } = setup({ isDisposed: () => true })

    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY * 5)

    expect(attempt).not.toHaveBeenCalled()
    expect(retry.retryCount.value).toBe(0)
  })

  it('attempt 抛错：进入下一次重试，计数递增（attempt 的契约：抛错 = 本次失败）', async () => {
    const { retry, attempt } = setup()
    attempt.mockRejectedValueOnce(new Error('boom'))

    retry.schedule() // → 1
    await vi.advanceTimersByTimeAsync(RETRY_DELAY) // 第 1 次失败 → 自动安排下一次
    expect(retry.retryCount.value).toBe(2)
    expect(retry.isRecoveringStream.value).toBe(true)
    expect(attempt).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('等待期内的重复错误事件被守卫拦下，不会加速消耗重试预算', async () => {
    const { retry, attempt } = setup()
    attempt.mockRejectedValueOnce(new Error('boom'))

    retry.schedule() // → 1
    await vi.advanceTimersByTimeAsync(RETRY_DELAY) // 失败 → 自动排上第 2 次

    // 重排后守卫立刻置回：等待期内的新错误事件进不来
    retry.schedule()
    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)

    expect(attempt).toHaveBeenCalledTimes(2)
    // 两次外部事件都没能挤进等待期：计数只被内部重排推进到 2，而不是 4
    expect(retry.retryCount.value).toBe(2)
  })
})

describe('useStreamRetry 恢复态复位', () => {
  it('attempt 成功且仍处于加载中：复位恢复态，后续错误可再次触发重试', async () => {
    const { retry, attempt } = setup()

    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(retry.isRecoveringStream.value).toBe(false)

    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(retry.retryCount.value).toBe(2)
  })

  it('attempt 成功但流已停止加载：不复位，避免把守卫提前撤销', async () => {
    const mediaLoading = ref(true)
    const { retry, attempt } = setup({ mediaLoading })
    attempt.mockImplementation(async () => {
      mediaLoading.value = false
    })

    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(retry.isRecoveringStream.value).toBe(true)

    retry.schedule() // 被守卫拦下
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('markRecovered 只清计数与恢复态，不撤销已安排的计时器', async () => {
    const { retry, attempt } = setup()

    retry.schedule()
    retry.markRecovered()

    expect(retry.retryCount.value).toBe(0)
    expect(retry.isRecoveringStream.value).toBe(false)

    // 等待期内的 canplay 迟到：已安排的重试照常执行，不会被无声吃掉
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('reset 清空计数并撤销挂起的计时器（新会话开始）', async () => {
    const { retry, attempt } = setup()

    retry.schedule()
    retry.reset()

    expect(retry.retryCount.value).toBe(0)
    expect(retry.isRecoveringStream.value).toBe(false)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY * 5)
    expect(attempt).not.toHaveBeenCalled()
  })
})

describe('useStreamRetry 重试耗尽', () => {
  it('计满上限后走 onExhausted：停加载、提示直播已结束、不再安排重试', async () => {
    const { retry, attempt, mediaLoading, onExhausted } = setup()
    attempt.mockRejectedValue(new Error('boom'))

    retry.schedule() // → 1
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)
    expect(retry.retryCount.value).toBe(3)

    // 第 3 次仍失败 → schedule() 发现已达上限
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)

    expect(attempt).toHaveBeenCalledTimes(3)
    expect(onExhausted).toHaveBeenCalledTimes(1)
    expect(mediaLoading.value).toBe(false)
    expect(retry.isRecoveringStream.value).toBe(false)
    expect(warningMock).toHaveBeenCalledWith('直播已结束')

    await vi.advanceTimersByTimeAsync(RETRY_DELAY * 5)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('maxRetries 可调：1 次即耗尽', async () => {
    const { retry, attempt, onExhausted } = setup({ maxRetries: 1 })
    attempt.mockRejectedValue(new Error('boom'))

    retry.schedule()
    await vi.advanceTimersByTimeAsync(RETRY_DELAY)

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onExhausted).toHaveBeenCalledTimes(1)
  })
})
