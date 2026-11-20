import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../src/common/concurrency'

/** 手动门控的 Promise：精确控制在途数量 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('mapWithConcurrency（保序有界并发映射）', () => {
  it('结果保序：与任务完成顺序无关', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const running = mapWithConcurrency([0, 1, 2], 3, index => gates[index].promise)
    gates[2].resolve('c')
    gates[0].resolve('a')
    gates[1].resolve('b')
    await expect(running).resolves.toEqual(['a', 'b', 'c'])
  })

  it('在途数量不超过 limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, index) => index)
    await mapWithConcurrency(items, 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight--
    })
    expect(peak).toBe(3)
  })

  it('空列表直接返回空数组', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([])
  })

  it('任一任务抛错即整体拒绝', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2)
        throw new Error('boom')
      return item
    })).rejects.toThrow('boom')
  })
})
