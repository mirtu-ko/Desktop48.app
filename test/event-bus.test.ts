import { describe, expect, expectTypeOf, it } from 'vitest'
import EventBus from '../src/renderer/src/services/event-bus'

/**
 * 渲染层事件总线：订阅 / 退订 / 分发语义，以及**事件名与参数在编译期被校验**。
 *
 * 后者是换掉 mitt 的全部理由：mitt 的泛型约束逼着 Events 带 `[key: string]: unknown` 兜底，
 * 拼错事件名不报错。这里用 @ts-expect-error 把「必须报错」固化下来 ——
 * 如果哪天兜底 index signature 被加回来，这些指令会变成「未使用」而让测试失败。
 */
describe('eventBus 分发语义', () => {
  it('具参事件把 payload 传给订阅者', () => {
    const received: string[] = []
    const handler = (liveId: string) => received.push(liveId)
    EventBus.on('live-unavailable', handler)

    EventBus.emit('live-unavailable', 'live-1')
    EventBus.emit('live-unavailable', 'live-2')

    expect(received).toEqual(['live-1', 'live-2'])
    EventBus.off('live-unavailable', handler) // 模块级单例：本文件内用完即退订
  })

  it('无参事件发射时不用传第二个参数', () => {
    let count = 0
    const handler = () => {
      count++
    }
    EventBus.on('lives-refresh', handler)

    EventBus.emit('lives-refresh')

    expect(count).toBe(1)
    EventBus.off('lives-refresh', handler)
  })

  it('off 只移除对应回调，其他订阅者照常收到', () => {
    const a: string[] = []
    const b: string[] = []
    const handlerA = (liveId: string) => a.push(liveId)
    const handlerB = (liveId: string) => b.push(liveId)
    EventBus.on('live-unavailable', handlerA)
    EventBus.on('live-unavailable', handlerB)

    EventBus.off('live-unavailable', handlerA)
    EventBus.emit('live-unavailable', 'live-3')

    expect(a).toEqual([])
    expect(b).toEqual(['live-3'])
    EventBus.off('live-unavailable', handlerB)
  })

  it('on 返回的取消函数等价于 off', () => {
    let count = 0
    const unsubscribe = EventBus.on('members-updated', () => {
      count++
    })

    EventBus.emit('members-updated')
    unsubscribe()
    EventBus.emit('members-updated')

    expect(count).toBe(1)
  })

  it('同一回调重复订阅只注册一次（Set 语义）', () => {
    let count = 0
    const handler = () => {
      count++
    }
    EventBus.on('members-updated', handler)
    EventBus.on('members-updated', handler)

    EventBus.emit('members-updated')

    expect(count).toBe(1)
    EventBus.off('members-updated', handler)
  })

  it('回调内部退订不会打乱本次分发（遍历的是快照）', () => {
    const seen: string[] = []
    const second = () => seen.push('second')
    const first = () => {
      seen.push('first')
      EventBus.off('lives-refresh', second)
    }
    EventBus.on('lives-refresh', first)
    EventBus.on('lives-refresh', second)

    EventBus.emit('lives-refresh')

    // 快照保证 second 仍收到本次事件；退订只影响下一次
    expect(seen).toEqual(['first', 'second'])
    EventBus.off('lives-refresh', first)
    EventBus.off('lives-refresh', second)
  })

  it('没有订阅者时发射是空操作', () => {
    expect(() => EventBus.emit('members-updated')).not.toThrow()
  })
})

describe('eventBus 编译期校验', () => {
  it('事件名拼错/未登记时编译失败', () => {
    // @ts-expect-error 未登记的事件名
    EventBus.emit('members-updatd')
    // @ts-expect-error 未登记的事件名
    EventBus.on('lives-refeshed', () => {})
    // @ts-expect-error 未登记的事件名
    EventBus.off('unknown-event', () => {})

    expect(true).toBe(true) // 这些调用在运行期不会发生（类型层面已拒绝）
  })

  it('具参事件漏传/错传参数时编译失败，无参事件多传也失败', () => {
    // @ts-expect-error 缺 payload
    EventBus.emit('live-unavailable')
    // @ts-expect-error payload 类型不符
    EventBus.emit('live-unavailable', 42)
    // @ts-expect-error 无参事件不接受 payload
    EventBus.emit('members-updated', 'x')

    expect(true).toBe(true)
  })

  it('订阅回调的参数类型由事件决定', () => {
    const handler = (liveId: string) => liveId
    expectTypeOf(handler).toEqualTypeOf<(liveId: string) => string>()
    // @ts-expect-error 回调参数类型与事件不符
    EventBus.on('live-unavailable', (liveId: number) => liveId)
  })
})
