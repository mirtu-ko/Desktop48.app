import { describe, expect, it } from 'vitest'
import { isRoomClosed } from '../src/renderer/src/utils/room-status'

describe('room-status（房间关闭判据）', () => {
  it('无留言板即关闭（房间关闭后 jump 退到直播频道）', () => {
    expect(isRoomClosed(false)).toBe(true)
  })

  it('有留言板不判关闭，字段缺失也不猜', () => {
    expect(isRoomClosed(true)).toBe(false)
    expect(isRoomClosed(null)).toBe(false)
  })

  it('服务端直接回「已关闭」时命中', () => {
    expect(isRoomClosed(null, '房间已关闭')).toBe(true)
    // 跨 IPC 的错误会带上前缀，仍然要认
    expect(isRoomClosed(null, 'Error invoking remote method: 房间已关闭')).toBe(true)
  })

  it('其它失败不当作关闭（宁可显示暂无消息，也不误报）', () => {
    expect(isRoomClosed(null, '获取房间发言权限失败')).toBe(false)
    expect(isRoomClosed(null, '接口异常（HTTP 500）')).toBe(false)
    expect(isRoomClosed(null, '')).toBe(false)
  })
})
