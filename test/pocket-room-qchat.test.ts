import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRoomQChatSessions,
  handleRoomQChatEnter,
  handleRoomQChatLeave,
  resetRoomQChatSessions,
  sendRoomMessage,
} from '../src/main/pocket48/pocket-room-qchat'

/**
 * 房间发言会话层（pocket-room-qchat.ts）：订阅登记与失败摘除、发送冷却与
 * 回显合成、退订销毁。协议客户端（NimQChatClient）与口袋接口整体 mock，
 * 只验会话表的状态机——真正的 TCP 行为不在这层。
 */

const { clientMock, authMock, sendMock, expireAuthMock } = vi.hoisted(() => ({
  clientMock: {
    /** 构造出的客户端实例（按序） */
    instances: [] as Array<{
      connected: boolean
      options: Record<string, unknown>
      connectCalls: number
      subscribeCalls: Array<{ serverId: string, channelId: string }>
      unsubscribeCalls: Array<{ serverId: string, channelId: string }>
      sendCalls: unknown[]
      destroyCalls: number
    }>,
    /** connect 行为覆写：抛错即模拟连接失败 */
    connectImpl: null as null | (() => Promise<void>),
    /** subscribeChannel 行为覆写 */
    subscribeImpl: null as null | (() => Promise<void>),
    /** sendMessage 行为覆写：默认回成功 ACK */
    sendImpl: null as null | (() => Promise<{ msgIdClient: string, msgIdServer: string, time: number }>),
  },
  authMock: {
    credentials: { accid: 'acc-me', token: 'im-token' } as { accid: string, token: string },
    profile: {
      userId: '999',
      nickname: '我',
      avatar: '/avatar.jpg',
      level: 12,
      roleId: 0,
      vip: false,
      pfUrl: '',
      teamLogo: '',
      badge: [] as string[],
    },
    /** getImCredentials 抛错（凭据失效） */
    credentialsImpl: null as null | (() => Promise<{ accid: string, token: string }>),
    /** channelId → 服务端发言权限（cdTime 决定真实冷却；未设置 = 未知，按本地下限） */
    permissions: {} as Record<string, { cdTime: number }>,
  },
  sendMock: { calls: [] as unknown[][] },
  expireAuthMock: vi.fn(),
}))

vi.mock('../src/main/pocket48/nim-qchat', () => ({
  isFatalAuthError: (error: unknown) => {
    const code = (error as { code?: number } | null)?.code
    return code === 302 || code === 403 || code === 422
  },
  NimQChatClient: class {
    connected = false
    options: Record<string, unknown>
    connectCalls = 0
    subscribeCalls: Array<{ serverId: string, channelId: string }> = []
    unsubscribeCalls: Array<{ serverId: string, channelId: string }> = []
    sendCalls: unknown[] = []
    destroyCalls = 0

    constructor(options: Record<string, unknown>) {
      this.options = options
      clientMock.instances.push(this)
    }

    async connect(): Promise<void> {
      this.connectCalls++
      if (clientMock.connectImpl)
        await clientMock.connectImpl()
      this.connected = true
      ;(this.options.onConnected as (() => void) | undefined)?.()
    }

    async subscribeChannel(serverId: string, channelId: string): Promise<void> {
      if (clientMock.subscribeImpl)
        await clientMock.subscribeImpl()
      this.subscribeCalls.push({ serverId, channelId })
    }

    async unsubscribeChannel(serverId: string, channelId: string): Promise<void> {
      this.unsubscribeCalls.push({ serverId, channelId })
    }

    async sendMessage(input: unknown): Promise<{ msgIdClient: string, msgIdServer: string, time: number }> {
      this.sendCalls.push(input)
      if (clientMock.sendImpl)
        return clientMock.sendImpl()
      return { msgIdClient: 'ack-client-1', msgIdServer: 'ack-server-1', time: 1728000009 }
    }

    destroy(): void {
      this.destroyCalls++
      this.connected = false
    }
  },
}))

vi.mock('../src/main/pocket48/pocket-auth', () => ({
  IM_APP_KEY: 'fixed-app-key',
  getImCredentials: async () => (authMock.credentialsImpl ? authMock.credentialsImpl() : authMock.credentials),
  getRoomSenderProfile: async () => authMock.profile,
  getRoomPermissions: async (channelId: string) => {
    const permission = authMock.permissions[channelId]
    return permission ? { sendText: true, roomRole: '0', followFlag: true, ...permission } : null
  },
  currentClientProfile: () => 'pocket48',
  expireStoredAuth: expireAuthMock,
}))

vi.mock('../src/main/pocket48/client-profile', () => ({
  nimIdentityFor: () => ({ sdkVersion: 92012, packageName: 'com.pocket.snh48.activity' }),
}))

vi.mock('../src/main/ipc/send', () => ({
  sendIpc: (...args: unknown[]) => {
    sendMock.calls.push(args)
  },
}))

/** 假 WebContents：只实现 destroyed 事件相关的三件套，另暴露监听计数与触发 */
type FakeSender = WebContents & { listenerCount: () => number, emitDestroyed: () => void }

function fakeSender(): FakeSender {
  const listeners = new Set<() => void>()
  const sender = {
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed')
        listeners.add(listener)
    },
    removeListener: (event: string, listener: () => void) => {
      if (event === 'destroyed')
        listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
    emitDestroyed: () => {
      for (const listener of [...listeners])
        listener()
      listeners.clear()
    },
  }
  return sender as unknown as FakeSender
}

function codedError(message: string, code: number): Error & { code: number } {
  const error = new Error(message) as Error & { code: number }
  error.code = code
  return error
}

beforeEach(() => {
  clientMock.instances = []
  clientMock.connectImpl = null
  clientMock.subscribeImpl = null
  clientMock.sendImpl = null
  authMock.credentialsImpl = null
  authMock.credentials = { accid: 'acc-me', token: 'im-token' }
  authMock.permissions = {}
  sendMock.calls = []
  expireAuthMock.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  // 会话表是模块级单例：每个用例后清空，免得上个用例的订阅漏到本次
  cleanupRoomQChatSessions()
})

describe('pocket-room-qchat / 进房订阅', () => {
  it('首进房间：建会话、连接、订阅频道', async () => {
    const sender = fakeSender()

    expect(await handleRoomQChatEnter('111', '222', sender)).toEqual({ ok: true })

    expect(clientMock.instances).toHaveLength(1)
    expect(clientMock.instances[0].connectCalls).toBe(1)
    expect(clientMock.instances[0].subscribeCalls).toEqual([{ serverId: '111', channelId: '222' }])
    // 建连用内置常量 appKey（两个 APK 硬编码同值）
    expect(clientMock.instances[0].options.appKey).toBe('fixed-app-key')
    // 连接过程的状态事件送到订阅窗口
    expect(sendMock.calls.some(([, channel]) => channel === 'pocketRoomBatch')).toBe(true)
  })

  it('同房重进（同房重选 / 多窗口）：不重复连接与订阅，只补订阅者', async () => {
    const first = fakeSender()
    await handleRoomQChatEnter('111', '222', first)
    const second = fakeSender()

    expect(await handleRoomQChatEnter('111', '222', second)).toEqual({ ok: true })

    expect(clientMock.instances).toHaveLength(1)
    expect(clientMock.instances[0].connectCalls).toBe(1)
    expect(clientMock.instances[0].subscribeCalls).toHaveLength(1)
  })

  it('连接失败：摘除本次登记，不留幽灵订阅（再进会重新走订阅）', async () => {
    clientMock.connectImpl = async () => {
      throw new Error('连接超时')
    }
    const sender = fakeSender()

    const result = await handleRoomQChatEnter('111', '222', sender)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('连接超时')
    // 刚建且已无频道的会话连同连接一并销毁
    expect(clientMock.instances[0].destroyCalls).toBe(1)

    // 恢复连接后再进同一频道：订阅必须重新发生（幽灵订阅会让它跳过）
    clientMock.connectImpl = null
    expect((await handleRoomQChatEnter('111', '222', fakeSender())).ok).toBe(true)
    expect(clientMock.instances.at(-1)!.subscribeCalls).toEqual([{ serverId: '111', channelId: '222' }])
  })

  it('凭据失效：不进协议层，如实返回原因', async () => {
    authMock.credentialsImpl = async () => {
      throw new Error('IM 凭据已失效')
    }

    const result = await handleRoomQChatEnter('111', '222', fakeSender())

    expect(result.ok).toBe(false)
    expect(result.message).toBe('IM 凭据已失效')
    expect(clientMock.instances).toHaveLength(0)
  })

  it('建连返回认证错误：清凭证并按登录过期提示', async () => {
    clientMock.connectImpl = async () => {
      throw codedError('NIM 登录失败（302）', 302)
    }

    const result = await handleRoomQChatEnter('111', '222', fakeSender())

    expect(result).toEqual({ ok: false, message: '登录已过期，请重新登录口袋48账号' })
    expect(expireAuthMock).toHaveBeenCalledTimes(1)
    expect(clientMock.instances[0].destroyCalls).toBe(1)
  })

  it('频道订阅 403：只回订阅失败，不把用户踢下线', async () => {
    clientMock.subscribeImpl = async () => {
      throw codedError('订阅房间频道被拒（403）', 403)
    }
    const sender = fakeSender()

    const result = await handleRoomQChatEnter('111', '222', sender)

    expect(result).toEqual({ ok: false, message: '订阅房间频道被拒（403）' })
    expect(expireAuthMock).not.toHaveBeenCalled()
    expect(sender.listenerCount()).toBe(0)
    expect(clientMock.instances[0].destroyCalls).toBe(1)
  })
})

describe('pocket-room-qchat / 退订与销毁', () => {
  it('最后订阅者退订：退频道、断连接、会话表清空（再发送即拒绝）', async () => {
    const sender = fakeSender()
    await handleRoomQChatEnter('111', '222', sender)

    await handleRoomQChatLeave('111', '222', sender)

    expect(clientMock.instances[0].unsubscribeCalls).toEqual([{ serverId: '111', channelId: '222' }])
    expect(clientMock.instances[0].destroyCalls).toBe(1)
    await expect(sendRoomMessage('111', '222', '在吗')).rejects.toThrow('房间连接已失效，请重新进入房间')
  })

  it('多窗口同频道：一个窗口退订不断连，订阅仍在', async () => {
    const first = fakeSender()
    const second = fakeSender()
    await handleRoomQChatEnter('111', '222', first)
    await handleRoomQChatEnter('111', '222', second)

    await handleRoomQChatLeave('111', '222', first)

    expect(clientMock.instances[0].unsubscribeCalls).toHaveLength(0)
    expect(clientMock.instances[0].destroyCalls).toBe(0)
  })

  it('登录态变更：广播 disconnected 后销毁全部会话', async () => {
    const sender = fakeSender()
    await handleRoomQChatEnter('111', '222', sender)

    resetRoomQChatSessions()

    const statusBatches = sendMock.calls
      .filter(([, channel]) => channel === 'pocketRoomBatch')
      .map(([, , batch]) => batch as { kind: string, status?: string })
    expect(statusBatches.some(item => item.kind === 'status' && item.status === 'disconnected')).toBe(true)
    expect(clientMock.instances[0].destroyCalls).toBe(1)
  })
})

describe('pocket-room-qchat / 订阅簿记', () => {
  it('切房来回：destroyed 钩子随退订摘除，不随进出次数累积', async () => {
    const sender = fakeSender()
    await handleRoomQChatEnter('111', '222', sender)
    expect(sender.listenerCount()).toBe(1)

    await handleRoomQChatLeave('111', '222', sender)
    expect(sender.listenerCount()).toBe(0)

    await handleRoomQChatEnter('333', '444', sender)
    expect(sender.listenerCount()).toBe(1)
    await handleRoomQChatLeave('333', '444', sender)

    await handleRoomQChatEnter('111', '222', sender)
    // 三次登记、两次摘除后仍是 1：累积会让窗口关闭前就撞上监听上限告警
    expect(sender.listenerCount()).toBe(1)
  })

  it('进房失败：本次登记的钩子一并摘除', async () => {
    clientMock.connectImpl = async () => {
      throw new Error('连接超时')
    }
    const sender = fakeSender()

    await handleRoomQChatEnter('111', '222', sender)

    expect(sender.listenerCount()).toBe(0)
  })

  it('多窗口：已有频道连不上时，失败窗口不留在订阅表（收不到推送）', async () => {
    const first = fakeSender()
    await handleRoomQChatEnter('111', '222', first)
    // 连接掉了（重连中），同一频道的第二个窗口进来也连不上
    clientMock.instances[0].connected = false
    clientMock.connectImpl = async () => {
      throw new Error('重连失败')
    }
    const second = fakeSender()

    expect((await handleRoomQChatEnter('111', '222', second)).ok).toBe(false)
    expect(second.listenerCount()).toBe(0)

    sendMock.calls = []
    const onMessage = clientMock.instances[0].options.onMessage as (message: unknown) => void
    onMessage({ serverId: '111', channelId: '222' })
    expect(sendMock.calls.filter(([target]) => target === second)).toHaveLength(0)
    expect(sendMock.calls.filter(([target]) => target === first)).toHaveLength(1)
  })

  it('订阅失败：连接已建立也要回收（不留占着账号在线态的空转连接）', async () => {
    // 订阅这一步失败时连接已经是通的：留下它就是一条空转连接，手机端已被顶下线
    let connectedWhenSubscribing = false
    clientMock.subscribeImpl = async () => {
      connectedWhenSubscribing = clientMock.instances[0].connected
      throw new Error('订阅被拒')
    }
    const sender = fakeSender()

    expect((await handleRoomQChatEnter('111', '222', sender)).ok).toBe(false)
    expect(connectedWhenSubscribing).toBe(true)
    expect(clientMock.instances[0].destroyCalls).toBe(1)
    await expect(sendRoomMessage('111', '222', '在吗')).rejects.toThrow('房间连接已失效，请重新进入房间')
  })

  it('建连途中的错误不推 disconnected（状态留在 connecting）', async () => {
    clientMock.connectImpl = async () => {
      const onError = clientMock.instances[0].options.onError as (error: Error) => void
      onError(new Error('握手异常'))
      throw new Error('握手异常')
    }
    const sender = fakeSender()

    await handleRoomQChatEnter('111', '222', sender)

    const statuses = sendMock.calls
      .filter(([, channel]) => channel === 'pocketRoomBatch')
      .map(([, , batch]) => (batch as { status?: string }).status)
    expect(statuses).toContain('connecting')
    expect(statuses).not.toContain('disconnected')
  })
})

describe('pocket-room-qchat / 发送', () => {
  async function enter() {
    const sender = fakeSender()
    await handleRoomQChatEnter('111', '222', sender)
    return sender
  }

  it('文本发送：回显由发送入参与 ACK 合成（ACK 只回 ID 与时刻）', async () => {
    await enter()

    const result = await sendRoomMessage('111', '222', '大家晚安')

    // ACK 只回 ID 与时刻，回显原样沿用
    expect(result.msgIdClient).toBe('ack-client-1')
    expect(result.message).toMatchObject({
      serverId: '111',
      channelId: '222',
      fromAccount: 'acc-me',
      fromNick: '我',
      type: 0,
      body: '大家晚安',
      attachment: '',
      msgIdClient: result.msgIdClient,
      msgIdServer: 'ack-server-1',
      time: 1728000009,
    })
    // ext 是真实构造的发言者快照（不是空壳）
    expect(JSON.parse(result.message.ext).user).toMatchObject({ userId: '999', nickName: '我' })
    // 发出去的入参：type=text、正文在 body、客户端 ID 是 32 位 hex
    expect(clientMock.instances[0].sendCalls[0]).toMatchObject({
      type: 'text',
      body: '大家晚安',
      msgIdClient: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
  })

  it('回复发送：回显 type=100、附件带 replyInfo', async () => {
    await enter()

    const result = await sendRoomMessage('111', '222', '不客气～', {
      msgIdClient: 'orig-1',
      senderName: '成员甲',
      text: '谢谢应援',
    })

    expect(result.message.type).toBe(100)
    expect(JSON.parse(result.message.attachment)).toMatchObject({
      messageType: 'REPLY',
      replyInfo: { replyMessageId: 'orig-1', replyName: '成员甲', text: '不客气～' },
    })
  })

  it('冷却 1.5s 内拒发；到点放行', async () => {
    await enter()
    await sendRoomMessage('111', '222', '第一条')

    await vi.advanceTimersByTimeAsync(1400)
    await expect(sendRoomMessage('111', '222', '太快')).rejects.toThrow('发送太快，请')

    await vi.advanceTimersByTimeAsync(200)
    await expect(sendRoomMessage('111', '222', '第二条')).resolves.toMatchObject({ msgIdServer: 'ack-server-1' })
  })

  it('服务端 cdTime 才是真实窗口：1.5s 后仍拒发，满 10s 才放行', async () => {
    // 实测口径：常规房间 userFunction.cdTime=10，只按本地 1.5s 放行等于把拒绝全留给服务端
    authMock.permissions['222'] = { cdTime: 10 }
    await enter()
    // 进房预热是后台任务：先让权限回包落地，再发第一条
    await vi.advanceTimersByTimeAsync(0)
    await sendRoomMessage('111', '222', '第一条')

    await vi.advanceTimersByTimeAsync(2000)
    await expect(sendRoomMessage('111', '222', '太快')).rejects.toThrow('发送太快，请 8 秒后再试')

    await vi.advanceTimersByTimeAsync(8100)
    await expect(sendRoomMessage('111', '222', '第二条')).resolves.toMatchObject({ msgIdServer: 'ack-server-1' })
  })

  it('发送失败：冷却清零（网络抖动不该让用户干等 1.5s）', async () => {
    await enter()
    clientMock.sendImpl = async () => {
      throw new Error('发送被拒')
    }

    await expect(sendRoomMessage('111', '222', '失败一条')).rejects.toThrow('发送被拒')

    clientMock.sendImpl = null
    // 冷却已清零：立刻可重发
    await expect(sendRoomMessage('111', '222', '重发')).resolves.toBeTruthy()
  })

  it('未订阅的频道：拒绝发送（防切房后发到旧频道）', async () => {
    await expect(sendRoomMessage('999', '888', '在吗')).rejects.toThrow('房间连接已失效，请重新进入房间')
  })
})
