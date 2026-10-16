/**
 * 语音条互斥（utils/voice-solo.ts）：全局同时只允许一条在播。
 *
 * 这条链路的原始 bug 是「暂停器存在 <script setup> 顶层」——每个实例一份，
 * 后点的语音条停不掉先点的。本测试盯住两件事：抢占是否真停了旧的、让位是否会误伤新的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimVoiceSlot, releaseVoiceSlot } from '../src/renderer/src/utils/voice-solo'

describe('voice-solo / 语音条互斥', () => {
  const a = vi.fn()
  const b = vi.fn()

  beforeEach(() => {
    // 先清空上个用例留下的坑位（会回调它的 pause），再重置计数，否则上个用例的让位调用会串进来
    const reset = vi.fn()
    claimVoiceSlot(reset)
    releaseVoiceSlot(reset)
    a.mockReset()
    b.mockReset()
  })

  it('开播新条目会停掉正在播的那条', () => {
    claimVoiceSlot(a)
    claimVoiceSlot(b)
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('同一条重复占位不自停', () => {
    claimVoiceSlot(a)
    claimVoiceSlot(a)
    expect(a).not.toHaveBeenCalled()
  })

  it('旧实例让位不会误伤刚接手的那条', () => {
    claimVoiceSlot(a)
    claimVoiceSlot(b)
    releaseVoiceSlot(a)
    expect(b).not.toHaveBeenCalled()
    // a 已不是占位者：它退出（卸载）时不该把正在播的 b 停掉
    releaseVoiceSlot(a)
    expect(b).not.toHaveBeenCalled()
  })

  it('占位者播完让位后，坑位空出来', () => {
    claimVoiceSlot(a)
    releaseVoiceSlot(a)
    claimVoiceSlot(b)
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  // RoomVoiceBar 的 pause 自带让位（谁停谁交还），确认这种写法与抢占顺序不冲突
  it('占位者的 pause 自带让位时，交接不会重复回调', () => {
    const stops: string[] = []
    const make = (name: string) => {
      const stop = () => {
        stops.push(name)
        releaseVoiceSlot(stop)
      }
      return stop
    }
    const x = make('x')
    const y = make('y')
    claimVoiceSlot(x)
    claimVoiceSlot(y)
    claimVoiceSlot(x)
    expect(stops).toEqual(['x', 'y'])
  })
})
