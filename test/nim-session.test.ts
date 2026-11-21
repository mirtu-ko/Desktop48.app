import type { SessionOptions } from '../src/main/pocket48/nim-session'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodePacket, encodeVarint, makePacket, Rc4Stream } from '../src/main/pocket48/nim-common'
import { CommonlinkSession } from '../src/main/pocket48/nim-session'

/**
 * CommonlinkSession 的线上字节行为（mock node:net + 固定 RC4 密钥）：
 * 握手明文 → 登录包 RC4 → send 回执帧的 serial / 服务号 / 指令号；
 * onError 回调与登录被拒的报错文案。协议编解码本身在 nim-common 测试覆盖。
 */

/** randomBytes 固定为 16 个 0x07：测试侧能用同一把密钥复现 RC4 流 */
const KEY = Buffer.alloc(16, 7)

const { socketHolder } = vi.hoisted(() => ({
  socketHolder: { current: null as FakeSocket | null },
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: Buffer[] = []
  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data))
    return true
  }

  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
  }

  setKeepAlive(): void {}
  setTimeout(): void {}
}

vi.mock('node:net', () => ({
  default: { createConnection: () => socketHolder.current },
}))

vi.mock('node:crypto', async (importOriginal) => {
  const { Buffer: NodeBuffer } = await import('node:buffer')
  return {
    ...(await importOriginal<object>()),
    randomBytes: (size: number) => NodeBuffer.alloc(size, 7),
  }
})

vi.mock('../src/main/logger', () => ({ debug: vi.fn(), log: vi.fn() }))

/** 服务端应答帧：tag=2（头后跟 i16LE 结果码），对应 decodePacket 的响应分支 */
function responseFrame(serviceId: number, commandId: number, serial: number, code: number): Buffer {
  const header = Buffer.allocUnsafe(5)
  header[0] = serviceId
  header[1] = commandId
  header.writeInt16LE(serial, 2)
  header[4] = 2
  const body = Buffer.allocUnsafe(2)
  body.writeInt16LE(code, 0)
  return Buffer.concat([encodeVarint(5 + body.length), header, body])
}

function makeSession(overrides: Partial<SessionOptions> = {}): CommonlinkSession {
  return new CommonlinkSession({
    address: { host: '127.0.0.1', port: 9939 },
    // 登录包由调用方构造（与两个客户端一致）：serial 硬编码 1
    loginPacket: makePacket(13, 2, 1, Buffer.from([2])),
    loginServiceId: 13,
    loginCommandId: 2,
    loginLabel: '聊天室',
    onClose: vi.fn(),
    ...overrides,
  })
}

/** 走完握手 + 登录；返回服务端侧加密器（与会话解密器同密钥、同状态起点） */
async function login(session: CommonlinkSession): Promise<Rc4Stream> {
  const socket = socketHolder.current!
  const connecting = session.connect()
  socket.emit('connect') // → 明文握手帧
  const serverEncryptor = new Rc4Stream(KEY)
  socket.emit('data', serverEncryptor.apply(responseFrame(1, 1, 0, 200))) // 握手 ACK → 登录包 RC4 发出
  socket.emit('data', serverEncryptor.apply(responseFrame(13, 2, 1, 200))) // 登录成功
  await connecting
  return serverEncryptor
}

let session: CommonlinkSession | null = null

beforeEach(() => {
  socketHolder.current = new FakeSocket()
})

afterEach(() => {
  session?.destroy()
  session = null
})

describe('nim-session / CommonlinkSession 线上字节', () => {
  it('登录后 send：RC4 帧的服务号/指令号照传，serial 从 2 起（登录包占 1）', async () => {
    session = makeSession()
    await login(session)
    session.send(13, 35, Buffer.from([1]))

    const socket = socketHolder.current!
    expect(socket.writes).toHaveLength(3) // 握手明文 + 登录 + 回执
    // 测试侧解密器镜像会话加密器：同密钥、从头消费同一串写出字节
    const clientDecryptor = new Rc4Stream(KEY)
    const loginPacket = decodePacket(clientDecryptor.apply(socket.writes[1]))
    expect([loginPacket.serviceId, loginPacket.commandId, loginPacket.serial]).toEqual([13, 2, 1])
    const ack = decodePacket(clientDecryptor.apply(socket.writes[2]))
    expect([ack.serviceId, ack.commandId, ack.serial]).toEqual([13, 35, 2])
  })

  it('未连接时 send 静默丢弃（不写 socket、不占 serial）', () => {
    session = makeSession()
    session.send(13, 35, Buffer.alloc(0))
    expect(socketHolder.current!.writes).toHaveLength(0)
  })

  it('登录后每 15s 发一次心跳（1/2 空包，serial 从 2 起）', async () => {
    vi.useFakeTimers()
    try {
      session = makeSession()
      await login(session)
      const socket = socketHolder.current!
      expect(socket.writes).toHaveLength(2) // 握手明文 + 登录

      await vi.advanceTimersByTimeAsync(15_000)
      expect(socket.writes).toHaveLength(3)

      // 心跳与登录包共用同一条 RC4 加密流：先消费登录包再解心跳
      const clientDecryptor = new Rc4Stream(KEY)
      decodePacket(clientDecryptor.apply(socket.writes[1]))
      const heartbeat = decodePacket(clientDecryptor.apply(socket.writes[2]))
      expect([heartbeat.serviceId, heartbeat.commandId, heartbeat.serial]).toEqual([1, 2, 2])
      expect(heartbeat.body).toHaveLength(0)

      // 下一拍继续发（间隔未停），serial 递增
      await vi.advanceTimersByTimeAsync(15_000)
      expect(socket.writes).toHaveLength(4)
      const next = decodePacket(clientDecryptor.apply(socket.writes[3]))
      expect([next.serviceId, next.commandId, next.serial]).toEqual([1, 2, 3])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('登录被拒：reject 带 label 与结果码（聊天室沿用后文案为「聊天室 登录失败（417）」）', async () => {
    session = makeSession()
    const socket = socketHolder.current!
    const connecting = session.connect()
    socket.emit('connect')
    const serverEncryptor = new Rc4Stream(KEY)
    socket.emit('data', serverEncryptor.apply(responseFrame(1, 1, 0, 200)))
    socket.emit('data', serverEncryptor.apply(responseFrame(13, 2, 1, 417)))
    await expect(connecting).rejects.toThrow('聊天室 登录失败（417')
    expect(session.connected).toBe(false)
  })

  it('socket 错误：connect 拒绝且 onError 收到同一错误', async () => {
    const onError = vi.fn()
    session = makeSession({ onError })
    const connecting = session.connect()
    socketHolder.current!.emit('error', new Error('boom'))
    await expect(connecting).rejects.toThrow('boom')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })
})
