import type { LiveDanmaku } from '../src/common/live-danmaku'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { DANMAKU_DELAY_DEFAULT, useLiveDanmaku } from '../src/renderer/src/composables/use-live-danmaku'

// ElMessage 在 Node 环境没有可挂载的 DOM，且用例只关心「有没有提示」
const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { warning: warningMock } }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/** 主进程下发的批次（与 preload 的 DanmakuBatch 同形，此处独立表达以便断言） */
interface Batch {
  roomId: number
  items: LiveDanmaku[]
}

type BatchHandler = (batch: Batch) => void

/** 假的 mainAPI：订阅关系、起停调用与握手回包都留痕，供用例断言 */
function createMainApi() {
  const handlers = new Set<BatchHandler>()
  const started: number[] = []
  const stopped: number[] = []
  let resolveHandshake: (ok: boolean) => void = () => {}

  return {
    started,
    stopped,
    handlerCount: () => handlers.size,
    /** 回包握手结果（真实链路里是三个网络请求的结果） */
    finishHandshake: (ok: boolean) => resolveHandshake(ok),
    /** 模拟主进程推送一批弹幕 */
    emit: (batch: Batch) => {
      for (const handler of [...handlers])
        handler(batch)
    },
    mainAPI: {
      danmakuBatch(callback: BatchHandler) {
        handlers.add(callback)
        return () => handlers.delete(callback)
      },
      danmakuStart(roomId: number) {
        started.push(roomId)
        return new Promise<boolean>((resolve) => {
          resolveHandshake = resolve
        })
      },
      danmakuStop(roomId: number) {
        stopped.push(roomId)
        return Promise.resolve()
      },
    },
  }
}

function setup(options: { roomId?: number, enabled?: boolean, delaySeconds?: number } = {}) {
  const roomId = ref(options.roomId)
  const enabled = ref(options.enabled ?? true)
  const delaySeconds = ref(options.delaySeconds ?? DANMAKU_DELAY_DEFAULT)

  const api = createMainApi()
  vi.stubGlobal('window', { mainAPI: api.mainAPI })

  const scope = effectScope()
  const danmakuItems = scope.run(() => useLiveDanmaku({
    roomId: () => roomId.value,
    enabled: () => enabled.value,
    delaySeconds: () => delaySeconds.value,
  }))!.danmakuItems

  return { roomId, enabled, delaySeconds, danmakuItems, api, stop: () => scope.stop() }
}

/** 让已排队的 await 链跑完（不推进假时钟，避免顺手触发回收节拍） */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useLiveDanmaku / 订阅生命周期', () => {
  beforeEach(() => {
    // Date 一起 fake：延迟补偿靠 Date.now() 与回收节拍的相对关系；
    // setInterval 也要 fake —— 回收节拍走的是 useIntervalFn
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    warningMock.mockClear()
  })

  it('房间号有效且开启时立即订阅并起停主进程会话', () => {
    const { api } = setup({ roomId: 391199 })

    expect(api.started).toEqual([391199])
    expect(api.stopped).toEqual([])
    expect(api.handlerCount()).toBe(1)
  })

  it('没有对应房间（个人直播）时不订阅', () => {
    const { api } = setup({ roomId: undefined })

    expect(api.started).toEqual([])
    expect(api.handlerCount()).toBe(0)
  })

  it('初始就关闭时不订阅', () => {
    const { api } = setup({ roomId: 48, enabled: false })

    expect(api.started).toEqual([])
    expect(api.handlerCount()).toBe(0)
  })

  it('关闭开关：退订并通知主进程停会话', async () => {
    const { enabled, api } = setup({ roomId: 48 })

    enabled.value = false
    await nextTick()

    expect(api.stopped).toEqual([48])
    expect(api.handlerCount()).toBe(0)
  })

  it('重新打开开关：重新订阅', async () => {
    const { enabled, api } = setup({ roomId: 48, enabled: false })

    enabled.value = true
    await nextTick()

    expect(api.started).toEqual([48])
    expect(api.handlerCount()).toBe(1)
  })

  it('换房间：先停旧会话再起新会话', async () => {
    const { roomId, api } = setup({ roomId: 48 })

    roomId.value = 383045
    await nextTick()

    expect(api.stopped).toEqual([48])
    expect(api.started).toEqual([48, 383045])
  })

  it('房间号不变时重复触发不重连（避免无谓重连）', async () => {
    const { enabled, api } = setup({ roomId: 48 })

    enabled.value = true
    await nextTick()

    expect(api.started).toEqual([48])
    expect(api.stopped).toEqual([])
  })

  it('作用域销毁：退订并通知主进程停会话', () => {
    const { api, stop } = setup({ roomId: 48 })

    stop()

    expect(api.stopped).toEqual([48])
    expect(api.handlerCount()).toBe(0)
  })

  it('非本房间的批次被丢弃（多窗口同订阅时靠它过滤）', async () => {
    const { api, danmakuItems } = setup({ roomId: 48, delaySeconds: 0 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 383045, items: [{ text: '别人的', username: 'u' }] })
    vi.advanceTimersByTime(500)

    expect(danmakuItems.value).toHaveLength(0)
  })

  it('握手失败：退订并提示一次（不影响直播播放）', async () => {
    const { api, danmakuItems } = setup({ roomId: 48 })
    api.finishHandshake(false)
    await flushMicrotasks()

    expect(api.handlerCount()).toBe(0)
    expect(api.stopped).toEqual([48])
    expect(warningMock).toHaveBeenCalledTimes(1)

    // 失败后不再产出弹幕
    api.emit({ roomId: 48, items: [{ text: 'x', username: 'u' }] })
    vi.advanceTimersByTime(1000)
    expect(danmakuItems.value).toHaveLength(0)
  })

  it('握手期间关掉开关：握手成功回包后把会话还回去，不留没人收的连接', async () => {
    const { enabled, api } = setup({ roomId: 48 })

    // 此刻主进程还没登记会话，这次 stop 是空转
    enabled.value = false
    await nextTick()
    expect(api.stopped).toEqual([48])

    api.finishHandshake(true)
    await flushMicrotasks()

    // 会话是握手成功后才登记的，必须再补一次 stop 才收得回来
    expect(api.stopped).toEqual([48, 48])
    expect(api.handlerCount()).toBe(0)
    expect(warningMock).not.toHaveBeenCalled()
  })
})

describe('useLiveDanmaku / 延迟补偿', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('弹幕按补偿秒数延后出现（画面比弹幕慢几秒就推后几秒）', async () => {
    const { api, danmakuItems } = setup({ roomId: 48, delaySeconds: 5 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'hi', username: 'u' }] })

    vi.advanceTimersByTime(4000)
    expect(danmakuItems.value).toHaveLength(0)

    vi.advanceTimersByTime(1400)
    expect(danmakuItems.value).toHaveLength(1)
    expect(danmakuItems.value[0].content).toBe('hi')
  })

  it('补偿为 0 时立即投放', async () => {
    const { api, danmakuItems } = setup({ roomId: 48, delaySeconds: 0 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'hi', username: 'u' }] })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value).toHaveLength(1)
  })

  it('同一批弹幕共用同一投放时刻，批内后到的排在前', async () => {
    const { api, danmakuItems } = setup({ roomId: 48, delaySeconds: 0 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({
      roomId: 48,
      items: [
        { text: '先到', username: 'u1' },
        { text: '后到', username: 'u2' },
      ],
    })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value.map(item => item.content)).toEqual(['后到', '先到'])
  })

  it('展示时长到期后回收（默认 6 秒）', async () => {
    const { api, danmakuItems } = setup({ roomId: 48, delaySeconds: 0 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'hi', username: 'u' }] })
    vi.advanceTimersByTime(250)
    expect(danmakuItems.value).toHaveLength(1)

    // 到期时刻（投放 + 6 秒）上仍保留，越过才回收
    vi.advanceTimersByTime(6000)
    expect(danmakuItems.value).toHaveLength(1)

    vi.advanceTimersByTime(250)
    expect(danmakuItems.value).toHaveLength(0)
  })

  it('关掉再打开会清空堆叠（时间轴原点已重置，旧时刻全是错的）', async () => {
    const { enabled, api, danmakuItems } = setup({ roomId: 48, delaySeconds: 0 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'hi', username: 'u' }] })
    vi.advanceTimersByTime(250)
    expect(danmakuItems.value).toHaveLength(1)

    enabled.value = false
    await nextTick()

    expect(danmakuItems.value).toHaveLength(0)
  })
})
