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

/** 起会话并把 start 回包成 ok，返回已建立的会话 */
async function connect(api: ReturnType<typeof createMainApi>, chatroomId: string, liveId = '1') {
  const pending = connectPocketChatroom({ chatroomId, liveId, onMessage: () => {} })
  api.resolveStart(true)
  return pending
}

describe('pocket-chatroom / 会话在册管理', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同房间重复 connect 复用在途会话：不双订阅、不双连', async () => {
    const api = setup()

    const first = connectPocketChatroom({ chatroomId: '100', liveId: '1', onMessage: () => {} })
    // 第二个 connect 时第一个的 start 还没回包（在途）：应直接复用
    const second = connectPocketChatroom({ chatroomId: '100', liveId: '1', onMessage: () => {} })
    api.resolveStart(true)
    const [s1, s2] = await Promise.all([first, second])

    expect(s2).toBe(s1)
    expect(api.started).toEqual(['100'])
    expect(api.handlerCount()).toBe(1)
  })

  it('destroy 后同房间重建：退旧订、起新会话', async () => {
    const api = setup()

    const s1 = await connect(api, '200')
    s1.destroy()
    expect(api.stopped).toEqual(['200'])
    expect(api.handlerCount()).toBe(0)

    const s2 = await connect(api, '200')
    expect(api.started).toEqual(['200', '200'])
    expect(s2).not.toBe(s1)
    expect(api.handlerCount()).toBe(1)
  })

  it('起会话在途时被销毁：回包后补退订，主进程不留永驻连接', async () => {
    const api = setup()

    // start 尚未回包（主进程还没登记会话）就销毁：这一次 stop 是空转
    const pending = connectPocketChatroom({ chatroomId: '300', liveId: '1', onMessage: () => {} })
    disconnectPocketChatroom('300')
    expect(api.stopped).toEqual(['300'])

    // 主进程此刻才登记会话，必须再补一次 stop 才收得回连接
    api.resolveStart(true)
    await pending
    expect(api.stopped).toEqual(['300', '300'])
    expect(api.handlerCount()).toBe(0)
  })

  it('被新一代顶替后，旧会话回包不再补退订（不杀死新会话）', async () => {
    const api = setup()

    const stale = connectPocketChatroom({ chatroomId: '400', liveId: '1', onMessage: () => {} })
    disconnectPocketChatroom('400')
    // 同房间新一代会话顶替在册记录
    const fresh = connectPocketChatroom({ chatroomId: '400', liveId: '1', onMessage: () => {} })

    api.resolveStart(true)
    await stale
    // 旧会话没有在册身份了：再补 stop 会杀死新会话，必须跳过
    expect(api.stopped).toEqual(['400'])

    api.resolveStart(true)
    await fresh
    expect(api.stopped).toEqual(['400'])
    expect(api.handlerCount()).toBe(1)
  })

  it('start 返回 false：报 disconnected 终态并清理，之后可重试', async () => {
    const api = setup()
    const onStatus = vi.fn()

    const pending = connectPocketChatroom({ chatroomId: '500', liveId: '1', onMessage: () => {}, onStatus })
    api.resolveStart(false)
    await pending

    expect(onStatus).toHaveBeenCalledWith('disconnected', expect.any(String))
    expect(api.stopped).toEqual(['500'])

    // 终态失败后再次 connect 能重试（在册记录已标记销毁，不会被复用）
    await connect(api, '500')
    expect(api.started).toEqual(['500', '500'])
  })
})
