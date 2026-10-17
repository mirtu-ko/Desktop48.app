import type { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { nimIdentityFor } from '../src/main/pocket48/client-profile'
import { buildChatroomLoginBody } from '../src/main/pocket48/nim-chatroom'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

vi.mock('../src/main/logger', () => ({
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}))

/**
 * 聊天室进房身份：属性 6（SDK 版本）与 25（包名）必须来自传入档位，
 * 且成对取自同一个 APK。这层直接断言二进制的属性表，防止身份来源被隐式写死。
 */

function readVarint(buffer: Buffer, offset: number): { value: number, size: number } {
  let value = 0
  let scale = 1
  let cursor = offset
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    value += (byte & 0x7F) * scale
    cursor++
    if ((byte & 0x80) === 0)
      return { value, size: cursor - offset }
    scale *= 128
  }
  throw new Error('varint 越界（测试数据损坏）')
}

/** 解属性表：varint(数量) + N × (varint(key) + varint(len) + bytes) */
function parseProperties(buffer: Buffer, offset: number): { props: Map<number, string>, size: number } {
  const count = readVarint(buffer, offset)
  let cursor = offset + count.size
  const props = new Map<number, string>()
  for (let index = 0; index < count.value; index++) {
    const key = readVarint(buffer, cursor)
    const length = readVarint(buffer, cursor + key.size)
    cursor += key.size + length.size
    props.set(key.value, buffer.subarray(cursor, cursor + length.value).toString('utf8'))
    cursor += length.value
  }
  return { props, size: cursor - offset }
}

function parseLoginBody(body: Buffer) {
  expect(body[0]).toBe(2)
  const room = parseProperties(body, 1)
  const auth = parseProperties(body, 1 + room.size)
  return { room: room.props, auth: auth.props }
}

function build(nim: { sdkVersion: number, packageName: string }) {
  return parseLoginBody(buildChatroomLoginBody({
    appKey: 'app-key',
    account: 'accid-1',
    token: 'im-token-1',
    roomId: '4321',
    deviceId: '0123456789abcdef',
    nim,
  }))
}

describe('nim-chatroom / 进房身份', () => {
  it('口袋48 档：属性 6/25 为口袋 APK 的 SDK 版本与包名', () => {
    const { room, auth } = build(nimIdentityFor('pocket48'))
    expect(auth.get(6)).toBe('92012')
    expect(auth.get(25)).toBe('com.pocket.snh48.activity')
    // 房间属性与凭据照旧，不受身份切换影响
    expect(room.get(1)).toBe('app-key')
    expect(room.get(2)).toBe('accid-1')
    expect(room.get(5)).toBe('4321')
    expect(auth.get(18)).toBe('app-key')
    expect(auth.get(19)).toBe('accid-1')
    expect(auth.get(1000)).toBe('im-token-1')
  })

  it('塞纳河48 档：属性 6/25 为 seine APK 的 SDK 版本与包名', () => {
    const { auth } = build(nimIdentityFor('seine48'))
    expect(auth.get(6)).toBe('92110')
    expect(auth.get(25)).toBe('com.seine48.app')
  })

  it('两档产出的二进制不同（否则切换档位对聊天室无效）', () => {
    const pocket = buildChatroomLoginBody({
      appKey: 'app-key',
      account: 'accid-1',
      token: 'im-token-1',
      roomId: '4321',
      deviceId: '0123456789abcdef',
      nim: nimIdentityFor('pocket48'),
    })
    const seine = buildChatroomLoginBody({
      appKey: 'app-key',
      account: 'accid-1',
      token: 'im-token-1',
      roomId: '4321',
      deviceId: '0123456789abcdef',
      nim: nimIdentityFor('seine48'),
    })
    expect(pocket.equals(seine)).toBe(false)
  })

  it('设备 ID 同时进房间属性 3 与认证属性 13（与 HTTP 侧同一台设备）', () => {
    const { room, auth } = build(nimIdentityFor('seine48'))
    expect(room.get(3)).toBe('0123456789abcdef')
    expect(auth.get(13)).toBe('0123456789abcdef')
  })
})
