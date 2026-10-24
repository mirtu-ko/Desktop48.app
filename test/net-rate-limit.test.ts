import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 渲染层 netRequest 的出口闸门（main/net-rate-limit.ts）。
 *
 * 白名单管「能打谁」，这里管「打多快」。闸门全在模块级状态里，
 * 每个用例重新 import 一份，避免令牌/队列跨用例累积。
 */
async function loadModule() {
  vi.resetModules()
  return import('../src/main/net-rate-limit')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('net-rate-limit / 在途与令牌', () => {
  it('空域立即放行；释放函数幂等', async () => {
    const { acquireNetSlot } = await loadModule()

    const release = await acquireNetSlot('a.test')
    release()
    // 重复释放不能把在途计数减成负数（否则后面的排队判定全乱）
    release()
    await expect(acquireNetSlot('a.test')).resolves.toBeTypeOf('function')
  })

  it('在途上限 4：占满后排队，释放一个即放行', async () => {
    const { acquireNetSlot } = await loadModule()
    const held: Array<() => void> = []
    for (let i = 0; i < 4; i++)
      held.push(await acquireNetSlot('a.test'))

    let fifthResolved = false
    const fifth = acquireNetSlot('a.test').then((release) => {
      fifthResolved = true
      return release
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fifthResolved).toBe(false)

    held[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(fifthResolved).toBe(true)
    ;(await fifth)()
  })

  it('令牌按时间补充：burst 用尽后排队，约 200ms 后放行（5 QPS）', async () => {
    const { acquireNetSlot } = await loadModule()
    // 先借满在途名额把令牌吃掉 4 个，再全部释放让在途归零
    const held: Array<() => void> = []
    for (let i = 0; i < 4; i++)
      held.push(await acquireNetSlot('a.test'))
    held.forEach(release => release())

    // 时间几乎没走，桶里还剩 1 个令牌：这次仍应立即放行
    const last = await acquireNetSlot('a.test')

    let resolved = false
    const waiting = acquireNetSlot('a.test').then((release) => {
      resolved = true
      return release
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(resolved).toBe(true)
    ;(await waiting)()
    last()
  })

  it('队列满即拒绝（24 个），不无限堆积', async () => {
    const { acquireNetSlot } = await loadModule()
    const held: Array<() => void> = []
    for (let i = 0; i < 4; i++)
      held.push(await acquireNetSlot('a.test'))
    // 24 个排队位填满后再来一个：直接拒绝，让调用方尽早失败
    const queued = Array.from({ length: 24 }, () => acquireNetSlot('a.test'))
    await expect(acquireNetSlot('a.test')).rejects.toThrow('排队已满')

    // 逐个「到了就释放」：占着名额不放会让在途上限把自己卡死
    const drained = queued.map(pending => pending.then(release => release()))
    held.forEach(release => release())
    for (let i = 0; i < 10; i++)
      await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(drained)
  })

  it('不同域名互不影响', async () => {
    const { acquireNetSlot } = await loadModule()
    const held: Array<() => void> = []
    for (let i = 0; i < 4; i++)
      held.push(await acquireNetSlot('a.test'))

    // a.test 在途已满，但 b.test 是独立桶
    await expect(acquireNetSlot('b.test')).resolves.toBeTypeOf('function')
    held.forEach(release => release())
  })
})

describe('net-rate-limit / 429 惩罚', () => {
  it('惩罚期内不发新请求，到期后放行', async () => {
    const { acquireNetSlot, penalizeHost } = await loadModule()
    penalizeHost('a.test', 5_000)

    let resolved = false
    const waiting = acquireNetSlot('a.test').then((release) => {
      resolved = true
      return release
    })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(resolved).toBe(true)
    ;(await waiting)()
  })

  it('parseRetryAfterMs：秒数 / 上限 / HTTP 日期 / 非法值', async () => {
    const { parseRetryAfterMs } = await loadModule()
    expect(parseRetryAfterMs('3')).toBe(3_000)
    // 服务端给得再长也不把整域锁死超过 60s
    expect(parseRetryAfterMs('120')).toBe(60_000)
    expect(parseRetryAfterMs(undefined)).toBe(0)
    expect(parseRetryAfterMs('abc')).toBe(0)

    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
    expect(parseRetryAfterMs(new Date('2026-10-24T00:00:05Z').toUTCString())).toBe(5_000)
  })
})
