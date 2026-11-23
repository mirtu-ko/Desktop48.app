import type { RoomSnapshotRow } from '../src/renderer/src/utils/room-list-snapshot'
import { describe, expect, it } from 'vitest'
import { parseRoomListSnapshot, serializeRoomListSnapshot } from '../src/renderer/src/utils/room-list-snapshot'

/** 快照行最小形态；只覆盖左列静态字段（直播 / 未读不在其中） */
function row(overrides: Partial<RoomSnapshotRow> = {}): RoomSnapshotRow {
  return {
    userId: 10001,
    nickname: '甲',
    avatar: '/a.jpg',
    teamName: 'TEAM SII',
    teamColor: '88ccff',
    followSource: 'pocket',
    serverId: 'srv-1',
    channelId: 'ch-1',
    preview: '上一条消息',
    ...overrides,
  }
}

function ownerOf(raw: string): unknown {
  return (JSON.parse(raw) as { owner: unknown }).owner
}

describe('room-list-snapshot / 序列化与解析', () => {
  it('往返：字段原样保留，owner 记入口袋 userId', () => {
    const raw = serializeRoomListSnapshot('999', [row(), row({ userId: 10002, nickname: '乙', followSource: 'both' })])

    expect(ownerOf(raw)).toBe('999')
    const parsed = parseRoomListSnapshot(raw, '999')
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(row())
    expect(parsed[1].followSource).toBe('both')
  })

  it('换号：owner 不符整份丢弃', () => {
    const raw = serializeRoomListSnapshot('999', [row()])

    expect(parseRoomListSnapshot(raw, '1000')).toEqual([])
    expect(parseRoomListSnapshot(raw, '')).toEqual([])
  })

  it('脏档：坏 JSON / 非对象 / rooms 非数组一律按空表', () => {
    expect(parseRoomListSnapshot('{oops', '999')).toEqual([])
    expect(parseRoomListSnapshot('[]', '999')).toEqual([])
    expect(parseRoomListSnapshot(JSON.stringify({ owner: '999', rooms: {} }), '999')).toEqual([])
    expect(parseRoomListSnapshot(JSON.stringify({ owner: '999' }), '999')).toEqual([])
    expect(parseRoomListSnapshot(null, '999')).toEqual([])
  })

  it('缺频道 / userId 非法的行被丢掉，其余照常水合', () => {
    const raw = JSON.stringify({
      owner: '999',
      rooms: [
        row(),
        { ...row({ userId: 10002 }), channelId: '' },
        { ...row({ userId: 10003 }), serverId: '' },
        row({ userId: 0 }),
        row({ userId: 10004, nickname: '' }),
      ],
    })

    const parsed = parseRoomListSnapshot(raw, '999')
    expect(parsed.map(item => item.userId)).toEqual([10001, 10004])
    // 昵称缺失回退通用名：左列不能出现一条无名条目
    expect(parsed[1].nickname).toBe('口袋用户 10004')
  })

  it('重复 userId 只留第一条，非法 followSource 归为未标注', () => {
    const raw = JSON.stringify({
      owner: '999',
      rooms: [row({ preview: '先出现的' }), row({ preview: '重复的' }), { ...row({ userId: 10002 }), followSource: 'weird' }],
    })

    const parsed = parseRoomListSnapshot(raw, '999')
    expect(parsed.map(item => item.preview)).toEqual(['先出现的', '上一条消息'])
    expect(parsed[1].followSource).toBeUndefined()
  })

  it('序列化剔掉无频道的行：脏数据不该被写进去', () => {
    const raw = serializeRoomListSnapshot('999', [
      row(),
      row({ userId: 10002, channelId: '' }),
      row({ userId: 10003, serverId: '' }),
    ])

    expect(parseRoomListSnapshot(raw, '999').map(item => item.userId)).toEqual([10001])
  })

  it('空表也写一条记录（不带 rooms 的旧快照不会被当成有效数据）', () => {
    const raw = serializeRoomListSnapshot('999', [])

    expect(parseRoomListSnapshot(raw, '999')).toEqual([])
    expect(ownerOf(raw)).toBe('999')
  })
})
