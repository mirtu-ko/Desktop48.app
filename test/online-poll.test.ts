import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { ONLINE_POLL_INTERVAL, useOnlinePoll } from '../src/renderer/src/composables/use-online-poll'

function setup(overrides: Partial<Parameters<typeof useOnlinePoll>[0]> = {}) {
  const enabled = ref(true)
  const fetchOnline = vi.fn(async () => 213)
  const onOnline = vi.fn()
  const onError = vi.fn()
  const poll = useOnlinePoll({
    enabled: () => enabled.value,
    fetchOnline,
    onOnline,
    onError,
    ...overrides,
  })
  return { enabled, fetchOnline, onOnline, onError, poll }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useOnlinePoll 游客在线人数轮询', () => {
  it('按 90s 间隔补拉，到点前不发请求', async () => {
    const { fetchOnline, onOnline } = setup()

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL - 1)
    expect(fetchOnline).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchOnline).toHaveBeenCalledTimes(1)
    expect(onOnline).toHaveBeenCalledWith(213)

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(fetchOnline).toHaveBeenCalledTimes(2)
  })

  it('enabled=false 时不计时（已登录 / 公演 / 结束态 / 隐藏都不该有请求）', async () => {
    const { enabled, fetchOnline } = setup()
    enabled.value = false
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL * 3)
    expect(fetchOnline).not.toHaveBeenCalled()
  })

  it('条件恢复后重新计时（窗口重新可见）', async () => {
    const { enabled, fetchOnline } = setup()
    enabled.value = false
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL * 2)
    expect(fetchOnline).not.toHaveBeenCalled()

    enabled.value = true
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(fetchOnline).toHaveBeenCalledTimes(1)
  })

  it('回包前已进结束态（enabled 翻假）则丢弃该值，不覆盖界面', async () => {
    // 结束态/隐藏发生在请求飞行中：回包到达时条件已不成立，必须整条丢弃
    const enabled = ref(true)
    const onOnline = vi.fn()
    useOnlinePoll({
      enabled: () => enabled.value,
      fetchOnline: async () => {
        enabled.value = false
        return 999
      },
      onOnline,
    })

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(onOnline).not.toHaveBeenCalled()
  })

  it('0 与 undefined 不采纳（与 LIVEUPDATE 同一口径）', async () => {
    const { fetchOnline, onOnline } = setup()
    fetchOnline.mockResolvedValue(0)
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(onOnline).not.toHaveBeenCalled()

    fetchOnline.mockResolvedValue(undefined as unknown as number)
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(onOnline).not.toHaveBeenCalled()
  })

  it('失败只回调 onError，下个周期照常再试（轮询不因一次失败停摆）', async () => {
    const { fetchOnline, onOnline, onError } = setup()
    fetchOnline.mockRejectedValueOnce(new Error('网络异常'))

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onOnline).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(ONLINE_POLL_INTERVAL)
    expect(fetchOnline).toHaveBeenCalledTimes(2)
    expect(onOnline).toHaveBeenCalledWith(213)
  })
})
