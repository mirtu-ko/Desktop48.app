import type { LiveDanmaku } from '../src/common/live-danmaku'
import type { PocketChatMessage } from '../src/renderer/src/utils/pocket-chat-message'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useLiveDanmaku } from '../src/renderer/src/composables/use-live-danmaku'
import { pocketAuthState, refreshPocketAuthState } from '../src/renderer/src/stores/pocket-auth'

// ElMessage 在 Node 环境没有可挂载的 DOM，且用例只关心「有没有提示」
const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { warning: warningMock } }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/**
 * 口袋聊天室 service 打了桩：真实实现要经 IPC 建 TCP 会话，用例只关心
 * 「会话回调把消息交回 composable」与「发送回执的 uuid」这两段契约。
 */
const { pocketStub } = vi.hoisted(() => ({
  pocketStub: {
    /** 每次建会话时的 onMessage 回调 */
    handlers: [] as Array<(message: PocketChatMessage) => void>,
    /** 发送回执：默认沿用同一 ID，用例可改 */
    send: vi.fn(async (): Promise<{ uuid: string, time: number }> => ({ uuid: 'sent-1', time: 0 })),
  },
}))
vi.mock('@renderer/services/pocket-chatroom', () => ({
  connectPocketChatroom: (options: { onMessage: (message: PocketChatMessage) => void }) => {
    pocketStub.handlers.push(options.onMessage)
  },
  disconnectPocketChatroom: () => {},
  sendPocketBarrage: pocketStub.send,
}))

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

function setup(options: { roomId?: number, pocketRoomId?: string, liveId?: string, enabled?: boolean } = {}) {
  const roomId = ref(options.roomId)
  const pocketRoomId = ref(options.pocketRoomId)
  const enabled = ref(options.enabled ?? true)

  const api = createMainApi()
  vi.stubGlobal('window', {
    mainAPI: {
      ...api.mainAPI,
      // 登录态 store 启动时会拉一次快照：返回用例预设的身份，别让它覆盖成未登录
      pocketGetAuthState: async () => ({ ...pocketAuthState.value }),
    },
  })

  const scope = effectScope()
  const danmaku = scope.run(() => useLiveDanmaku({
    roomId: () => roomId.value,
    pocketRoomId: () => pocketRoomId.value,
    liveId: () => options.liveId ?? '',
    enabled: () => enabled.value,
  }))!

  return {
    roomId,
    pocketRoomId,
    enabled,
    danmakuItems: danmaku.danmakuItems,
    sendBarrage: danmaku.sendBarrage,
    api,
    stop: () => scope.stop(),
  }
}

/** 让已排队的 await 链跑完（不推进假时钟，避免顺手触发回收节拍） */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useLiveDanmaku / 订阅生命周期', () => {
  beforeEach(() => {
    // Date 一起 fake：投放时刻与回收时刻都取自 Date.now()；
    // setInterval 也要 fake —— 投放与回收节拍走的是 useIntervalFn
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
    const { api, danmakuItems } = setup({ roomId: 48 })
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

describe('useLiveDanmaku / 投放节拍与回收', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('弹幕到手即投放：不额外延后，下一个节拍就出现', async () => {
    const { api, danmakuItems } = setup({ roomId: 48 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'hi', username: 'u' }] })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value).toHaveLength(1)
    expect(danmakuItems.value[0].content).toBe('hi')
  })

  it('同一批弹幕共用同一投放时刻，批内后到的排在前', async () => {
    const { api, danmakuItems } = setup({ roomId: 48 })
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
    const { api, danmakuItems } = setup({ roomId: 48 })
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
    const { enabled, api, danmakuItems } = setup({ roomId: 48 })
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

describe('useLiveDanmaku / 表情片段', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('带表情的弹幕在主进程下发后切成文本 + 表情片段（端到端）', async () => {
    const { api, danmakuItems } = setup({ roomId: 48 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({
      roomId: 48,
      items: [{
        text: 'TEAM Hii[喝彩][喝彩][喝彩]',
        username: '小思念VENUS',
        emots: { '[喝彩]': { url: 'https://i0.hdslb.com/bfs/live/x.png', width: 20, height: 20 } },
      }],
    })
    vi.advanceTimersByTime(250)

    const segments = danmakuItems.value[0].segments
    expect(segments.map(segment => segment.type)).toEqual(['text', 'emote', 'emote', 'emote'])
    expect(segments[0]).toEqual({ type: 'text', text: 'TEAM Hii' })
    expect(segments[1]).toEqual({
      type: 'emote',
      text: '[喝彩]',
      url: 'https://i0.hdslb.com/bfs/live/x.png',
      width: 20,
      height: 20,
    })
  })

  it('没带 emots 的弹幕保持纯文本片段', async () => {
    const { api, danmakuItems } = setup({ roomId: 48 })
    api.finishHandshake(true)
    await flushMicrotasks()

    api.emit({ roomId: 48, items: [{ text: 'TEAM Hii[喝彩]', username: 'u' }] })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value[0].segments).toEqual([{ type: 'text', text: 'TEAM Hii[喝彩]' }])
  })
})

describe('useLiveDanmaku / 自发弹幕回推认领', () => {
  /** 每个用例自己收摊：泄漏的实例会留着 watch 与轮询节拍，后续用例的登录态变化会把它们唤醒 */
  const stops: Array<() => void> = []

  function setupPocket() {
    const ctx = setup({ pocketRoomId: 'room-9', liveId: 'live-9' })
    stops.push(ctx.stop)
    return ctx
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    pocketStub.handlers.length = 0
    pocketStub.send.mockClear()
    pocketStub.send.mockImplementation(async () => ({ uuid: 'sent-1', time: 0 }))
    // 发送与认领都以登录态里的口袋 userId 为身份锚点
    pocketAuthState.value = { ...pocketAuthState.value, loggedIn: true, userId: '711741', nickname: '我' }
    // 先把登录态 store 推到「已初始化」：否则 composable 起会话时会再拉一次快照，
    // 快照晚到会翻动 loggedIn 触发一轮 stop/start，把在途的待认领记录和投放队列一起清掉
    // 桩要覆盖全套 danmaku API：前面用例泄漏的实例仍挂着 watch，
    // 登录态一变它们会被唤醒并去 start()，缺方法就成了未捕获异常
    const stubApi = createMainApi()
    vi.stubGlobal('window', {
      mainAPI: {
        ...stubApi.mainAPI,
        pocketGetAuthState: async () => ({ ...pocketAuthState.value }),
      },
    })
    await refreshPocketAuthState()
  })

  afterEach(() => {
    // 先收摊再拆 window：stop() 会走 danmakuStop / disconnect，晚一步就打到空桩上
    while (stops.length)
      stops.pop()!()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    pocketAuthState.value = { ...pocketAuthState.value, loggedIn: false, userId: '', nickname: '' }
  })

  it('自己发的消息立刻上屏（不等回推）', async () => {
    const { danmakuItems, sendBarrage } = setupPocket()

    await sendBarrage('666')
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value.map(item => item.content)).toEqual(['666'])
    expect(pocketStub.send).toHaveBeenCalledWith('room-9', 'live-9', '666')
  })

  it('他人发的同文消息不会被认领吞掉', async () => {
    const { danmakuItems, sendBarrage } = setupPocket()
    await sendBarrage('666')
    vi.advanceTimersByTime(250)

    pocketStub.handlers[0]({ kind: 'barrage', uuid: 'other-9', text: '666', nick: '路人', userId: '999' })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value.map(item => item.content)).toEqual(['666', '666'])
  })

  it('自己的回推按消息 ID 认领，不再重复上屏', async () => {
    const { danmakuItems, sendBarrage } = setupPocket()
    await sendBarrage('666')
    vi.advanceTimersByTime(250)

    pocketStub.handlers[0]({ kind: 'barrage', uuid: 'sent-1', text: '666', nick: '我', userId: '711741' })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value).toHaveLength(1)
  })

  it('回推 ID 被服务端改写时，用 userId + 正文兜底认领', async () => {
    const { danmakuItems, sendBarrage } = setupPocket()
    await sendBarrage('666')
    vi.advanceTimersByTime(250)

    pocketStub.handlers[0]({ kind: 'barrage', uuid: 'server-77', text: '666', nick: '我', userId: '711741' })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value).toHaveLength(1)
  })

  it('回推缺 userId 时不认领（宁可重复，也不误吞）', async () => {
    const { danmakuItems, sendBarrage } = setupPocket()
    await sendBarrage('666')
    vi.advanceTimersByTime(250)

    // 归一器在身份字段缺失时给空串，这里照样传空串以贴合真实入参
    pocketStub.handlers[0]({ kind: 'barrage', uuid: 'other-9', text: '666', nick: '', userId: '' })
    vi.advanceTimersByTime(250)

    expect(danmakuItems.value).toHaveLength(2)
  })
})
