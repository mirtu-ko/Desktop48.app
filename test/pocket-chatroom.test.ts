import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPocketChatroom, disconnectPocketChatroom } from '../src/renderer/src/services/pocket-chatroom'

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface PocketBatch {
  chatroomId: string
  kind: 'status' | 'messages'
  status?: string
  message?: string
  items?: unknown[]
}

type BatchHandler = (batch: PocketBatch) => void

/** 归一化在真实用例里由 pocket-chat-message 完成；这里只需最小可识别形状 */
function barrage(text: string) {
  return { type: 'text', text, messageType: 'BARRAGE_TEXT', fromNick: '用户' }
}

/**
 * 假的 mainAPI：起停调用与订阅关系留痕；start 暂不回包，
 * 用来控制「起会话在途」窗口（真实链路里凭据获取是异步的）。
 */
function createMainApi() {
  const handlers = new Set<BatchHandler>()
  const started: string[] = []
  const stopped: string[] = []
  const pending: Array<(ok: boolean) => void> = []

  return {
    started,
    stopped,
    handlerCount: () => handlers.size,
    /** 回包最早一个在途 start */
    resolveStart: (ok: boolean) => pending.shift()?.(ok),
    /** 模拟主进程推送一批消息 / 一条状态 */
    emit: (batch: PocketBatch) => {
      for (const handler of [...handlers])
        handler(batch)
    },
    mainAPI: {
      pocketDanmakuBatch(callback: BatchHandler) {
        handlers.add(callback)
        return () => handlers.delete(callback)
      },
      pocketDanmakuStart(chatroomId: string) {
        started.push(chatroomId)
        return new Promise<boolean>((resolve) => {
          pending.push(resolve)
        })
      },
      pocketDanmakuStop(chatroomId: string) {
        stopped.push(chatroomId)
        return Promise.resolve()
      },
    },
  }
}

function setup() {
  const api = createMainApi()
  vi.stubGlobal('window', { mainAPI: api.mainAPI })
  return api
}

/** 让 start 回包后的微任务链跑完（回包处理是 async 函数里的续体） */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('pocket-chatroom / 会话在册管理', () => {
  // 每个用例用独立聊天室 ID：entries 是模块级在册表，同房号会串味
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同房间重复 connect 复用在途会话：不双订阅、不双连', () => {
    const api = setup()

    const first = connectPocketChatroom({ chatroomId: '100', liveId: '1', onMessage: () => {} })
    // 第二个 connect 时第一个的 start 还没回包（在途）：应直接复用
    const second = connectPocketChatroom({ chatroomId: '100', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)

    // 每个订阅者拿独立会话句柄，但底层只有一条连接、一条批次订阅
    expect(second).not.toBe(first)
    expect(api.started).toEqual(['100'])
    expect(api.handlerCount()).toBe(1)
  })

  it('消息与状态 fan-out 给同房间所有订阅者', () => {
    const api = setup()
    const onMessageA = vi.fn()
    const onMessageB = vi.fn()
    const onStatusB = vi.fn()

    connectPocketChatroom({ chatroomId: '110', liveId: '1', onMessage: onMessageA })
    connectPocketChatroom({ chatroomId: '110', liveId: '1', onMessage: onMessageB, onStatus: onStatusB })
    api.resolveStart(true)

    api.emit({ chatroomId: '110', kind: 'status', status: 'connected' })
    api.emit({ chatroomId: '110', kind: 'messages', items: [barrage('大家好')] })

    expect(onMessageA).toHaveBeenCalledTimes(1)
    expect(onMessageA.mock.calls[0][0].text).toBe('大家好')
    expect(onMessageB).toHaveBeenCalledTimes(1)
    expect(onStatusB).toHaveBeenCalledWith('connected', undefined)
  })

  it('destroy 只摘自己：同房间其他订阅者不受影响、连接不停', () => {
    const api = setup()
    const onMessageA = vi.fn()
    const onMessageB = vi.fn()

    const sessionA = connectPocketChatroom({ chatroomId: '120', liveId: '1', onMessage: onMessageA })
    connectPocketChatroom({ chatroomId: '120', liveId: '1', onMessage: onMessageB })
    api.resolveStart(true)

    sessionA.destroy()
    expect(api.stopped).toEqual([])

    api.emit({ chatroomId: '120', kind: 'messages', items: [barrage('还在')] })
    expect(onMessageA).not.toHaveBeenCalled()
    expect(onMessageB).toHaveBeenCalledTimes(1)
  })

  it('最后一个订阅者 destroy：退订并通知主进程停会话', () => {
    const api = setup()

    const session = connectPocketChatroom({ chatroomId: '200', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)
    session.destroy()

    expect(api.stopped).toEqual(['200'])
    expect(api.handlerCount()).toBe(0)
  })

  it('destroy 后同房间重建：墓碑被顶替，退旧订、起新会话', () => {
    const api = setup()

    const s1 = connectPocketChatroom({ chatroomId: '210', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)
    s1.destroy()

    const s2 = connectPocketChatroom({ chatroomId: '210', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)

    expect(api.started).toEqual(['210', '210'])
    expect(api.handlerCount()).toBe(1)

    // 新会话正常收消息
    const onMessage = vi.fn()
    const s3 = connectPocketChatroom({ chatroomId: '210', liveId: '1', onMessage })
    api.emit({ chatroomId: '210', kind: 'messages', items: [barrage('新生')] })
    expect(onMessage).toHaveBeenCalledTimes(1)
    s2.destroy()
    s3.destroy()
  })

  it('起会话在途时被销毁：回包后补退订，主进程不留永驻连接', async () => {
    const api = setup()

    // start 尚未回包（主进程还没登记会话）就销毁：这一次 stop 是空转
    connectPocketChatroom({ chatroomId: '300', liveId: '1', onMessage: () => {} })
    disconnectPocketChatroom('300')
    expect(api.stopped).toEqual(['300'])

    // 主进程此刻才登记会话，必须再补一次 stop 才收得回连接
    api.resolveStart(true)
    await flushMicrotasks()
    expect(api.stopped).toEqual(['300', '300'])
    expect(api.handlerCount()).toBe(0)
  })

  it('被新一代顶替后，旧会话回包不再补退订（不杀死新会话）', async () => {
    const api = setup()

    connectPocketChatroom({ chatroomId: '400', liveId: '1', onMessage: () => {} })
    disconnectPocketChatroom('400')
    // 同房间新一代会话顶替在册记录
    connectPocketChatroom({ chatroomId: '400', liveId: '1', onMessage: () => {} })

    // 旧会话的 start 先回包：没有在册身份了，再补 stop 会杀死新会话，必须跳过
    api.resolveStart(true)
    await flushMicrotasks()
    expect(api.stopped).toEqual(['400'])

    api.resolveStart(true)
    await flushMicrotasks()
    expect(api.stopped).toEqual(['400'])
    expect(api.handlerCount()).toBe(1)
  })

  it('start 返回 false：广播 disconnected 终态并清理，之后可重试', async () => {
    const api = setup()
    const onStatus = vi.fn()

    connectPocketChatroom({ chatroomId: '500', liveId: '1', onMessage: () => {}, onStatus })
    api.resolveStart(false)
    await flushMicrotasks()

    expect(onStatus).toHaveBeenCalledWith('disconnected', expect.any(String))
    expect(api.handlerCount()).toBe(0)

    // 终态失败后再次 connect 能重试（在册记录已清理，不会被复用）
    connectPocketChatroom({ chatroomId: '500', liveId: '1', onMessage: () => {} })
    expect(api.started).toEqual(['500', '500'])
  })

  it('disconnectPocketChatroom 退掉该房全部订阅者', () => {
    const api = setup()

    connectPocketChatroom({ chatroomId: '600', liveId: '1', onMessage: () => {} })
    connectPocketChatroom({ chatroomId: '600', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)

    disconnectPocketChatroom('600')
    expect(api.stopped).toEqual(['600'])
    expect(api.handlerCount()).toBe(0)
  })
})
