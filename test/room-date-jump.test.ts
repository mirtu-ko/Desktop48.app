// 按日期查看的时刻换算与分页合并：重点验证「严格早于」的边界与空页游标不空转。
import type { PocketRoomMessageView } from '../src/renderer/src/utils/pocket-room-message'
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { normalizePocketRoomMessage } from '../src/renderer/src/utils/pocket-room-message'
import { classifyRoomDateError, dateToNextTime, hasMessageOnDay, isRoomDateQueryable, mergeRoomMessagePages, nextRoomPageCursor, resolveRoomArchiveStart, ROOM_ARCHIVE_START } from '../src/renderer/src/utils/room-date-jump'

const DAY = '2026-05-13'
const dayStart = dayjs(DAY).startOf('day')
const dayEnd = dayStart.add(1, 'day')

/** 构造一条视图：id 与 msgTime 可控，其余字段走真实归一 */
function view(id: string, msgTime: number): PocketRoomMessageView {
  return normalizePocketRoomMessage({
    msgIdServer: id,
    msgIdClient: id,
    msgType: 'TEXT',
    msgTime,
    bodys: '正文',
    extInfo: JSON.stringify({ user: { userId: 42, nickName: '粉丝甲' } }),
  })!
}

describe('room-date-jump.dateToNextTime', () => {
  it('过去某天换算出次日 00:00（本地），而不是当天 00:00', () => {
    expect(dateToNextTime(DAY)).toBe(dayEnd.valueOf())
    expect(dateToNextTime(DAY)).not.toBe(dayStart.valueOf())
  })

  it('同一天传 Date / 字符串 / 毫秒三种形态结果一致', () => {
    expect(dateToNextTime(new Date(dayStart.valueOf()))).toBe(dayEnd.valueOf())
    expect(dateToNextTime(dayStart.valueOf())).toBe(dayEnd.valueOf())
  })

  it('目标日跨到未来时钳到 now，避免服务端回空页', () => {
    const now = dayStart.valueOf() + 3600_000
    expect(dateToNextTime(DAY, now)).toBe(now)
    expect(dateToNextTime(DAY, dayEnd.valueOf() + 86400_000)).toBe(dayEnd.valueOf())
  })

  it('无效日期返回 0；now 非法时退回次日 00:00', () => {
    expect(dateToNextTime('')).toBe(0)
    expect(dateToNextTime('不是日期')).toBe(0)
    expect(dateToNextTime(null)).toBe(0)
    expect(dateToNextTime(DAY, Number.NaN)).toBe(dayEnd.valueOf())
  })
})

describe('room-date-jump.resolveRoomArchiveStart', () => {
  const now = dayjs('2026-11-09T16:00:00').valueOf()

  it('入团早于归档日时以归档日为准', () => {
    expect(resolveRoomArchiveStart('2012-10-14', now)).toBe(ROOM_ARCHIVE_START)
    expect(resolveRoomArchiveStart('2022-03-31', now)).toBe(ROOM_ARCHIVE_START)
  })

  it('入团晚于归档日时以入团日为准', () => {
    expect(resolveRoomArchiveStart('2025-08-16', now)).toBe('2025-08-16')
    expect(resolveRoomArchiveStart('2022-04-01', now)).toBe('2022-04-01')
  })

  it('缺失 / 无效 / 晚于今天的入团日回落到归档日', () => {
    expect(resolveRoomArchiveStart(null, now)).toBe(ROOM_ARCHIVE_START)
    expect(resolveRoomArchiveStart('', now)).toBe(ROOM_ARCHIVE_START)
    expect(resolveRoomArchiveStart('不是日期', now)).toBe(ROOM_ARCHIVE_START)
    expect(resolveRoomArchiveStart('2099-01-01', now)).toBe(ROOM_ARCHIVE_START)
  })

  it('now 非法时仍按归档下界判定', () => {
    expect(resolveRoomArchiveStart('2025-08-16', Number.NaN)).toBe('2025-08-16')
  })
})

describe('room-date-jump.isRoomDateQueryable', () => {
  const now = dayjs('2026-11-09T16:00:00').valueOf()

  it('归档起点当天与今天可选，更早或未来一律禁用', () => {
    expect(isRoomDateQueryable(ROOM_ARCHIVE_START, now)).toBe(true)
    expect(isRoomDateQueryable('2026-11-09', now)).toBe(true)
    expect(isRoomDateQueryable('2022-03-31', now)).toBe(false)
    expect(isRoomDateQueryable('2026-11-10', now)).toBe(false)
  })

  it('选最早可查日仍能换算出覆盖当天的游标', () => {
    expect(dateToNextTime(ROOM_ARCHIVE_START)).toBe(dayjs(ROOM_ARCHIVE_START).add(1, 'day').startOf('day').valueOf())
  })

  it('传入 date / 毫秒与字符串口径一致；无效日期不可选', () => {
    const start = dayjs(ROOM_ARCHIVE_START).startOf('day').valueOf()
    expect(isRoomDateQueryable(new Date(start), now)).toBe(true)
    expect(isRoomDateQueryable(start, now)).toBe(true)
    expect(isRoomDateQueryable(null, now)).toBe(false)
    expect(isRoomDateQueryable('不是日期', now)).toBe(false)
  })

  it('按房间起点判定时，起点当天可选、前一天禁用', () => {
    expect(isRoomDateQueryable('2025-08-16', now, '2025-08-16')).toBe(true)
    expect(isRoomDateQueryable('2025-08-15', now, '2025-08-16')).toBe(false)
    expect(isRoomDateQueryable('2023-01-01', now, '2025-08-16')).toBe(false)
  })

  it('now 非法时退回只判归档下界', () => {
    expect(isRoomDateQueryable(ROOM_ARCHIVE_START, Number.NaN)).toBe(true)
    expect(isRoomDateQueryable('2022-03-31', Number.NaN)).toBe(false)
  })
})

describe('room-date-jump.hasMessageOnDay', () => {
  it('当天 00:00 到次日 00:00 之间算命中', () => {
    expect(hasMessageOnDay([view('a', dayStart.valueOf())], DAY)).toBe(true)
    expect(hasMessageOnDay([view('b', dayEnd.valueOf() - 1)], DAY)).toBe(true)
  })

  it('前一天末与次日 00:00 都不算命中', () => {
    expect(hasMessageOnDay([view('a', dayStart.valueOf() - 1)], DAY)).toBe(false)
    expect(hasMessageOnDay([view('b', dayEnd.valueOf())], DAY)).toBe(false)
  })

  it('空页与无效日期一律 false', () => {
    expect(hasMessageOnDay([], DAY)).toBe(false)
    expect(hasMessageOnDay([view('a', dayStart.valueOf())], '')).toBe(false)
  })
})

describe('room-date-jump.nextRoomPageCursor', () => {
  it('回包游标严格早于请求值时才推进', () => {
    expect(nextRoomPageCursor(1000, 800)).toBe(800)
  })

  it('空页原样回显、归档到 0 或反向增大都不推进', () => {
    expect(nextRoomPageCursor(1000, 1000)).toBe(0)
    expect(nextRoomPageCursor(1000, 0)).toBe(0)
    expect(nextRoomPageCursor(1000, 1200)).toBe(0)
  })
})

describe('room-date-jump.classifyRoomDateError', () => {
  it('无结果的业务失败归为空页，同时剥掉 IPC 包装前缀', () => {
    const error = new Error('Error invoking remote method \'pocketGetRoomMessages\': Error: 系统处理异常')
    expect(classifyRoomDateError(error)).toEqual({ empty: true, message: '系统处理异常' })
  })

  it('登录过期 / 未登录仍是错误，只保留最里层业务文案', () => {
    const wrapped = new Error('Error invoking remote method \'pocketGetRoomMessages\': Error: 登录已过期，请重新登录口袋48账号')
    expect(classifyRoomDateError(wrapped)).toEqual({ empty: false, message: '登录已过期，请重新登录口袋48账号' })
    expect(classifyRoomDateError(new Error('未登录口袋48账号')))
      .toEqual({ empty: false, message: '未登录口袋48账号' })
  })

  it('非 Error 抛值与空错误都能兜住', () => {
    expect(classifyRoomDateError('Error: 系统处理异常')).toEqual({ empty: true, message: '系统处理异常' })
    expect(classifyRoomDateError(null)).toEqual({ empty: false, message: '读取消息失败' })
    expect(classifyRoomDateError('')).toEqual({ empty: false, message: '读取消息失败' })
  })

  it('反向验证：其它业务失败不会被当成空页', () => {
    expect(classifyRoomDateError(new Error('获取房间消息失败')).empty).toBe(false)
  })
})

describe('room-date-jump.mergeRoomMessagePages', () => {
  it('按 id 去重且按 msgTime 正序（旧在上、新在下）', () => {
    const merged = mergeRoomMessagePages(
      [view('a', 300), view('b', 200)],
      [view('c', 400), view('a', 300)],
    )
    expect(merged.map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('首页传入服务端倒序回包，也归一成正序', () => {
    const page = mergeRoomMessagePages([], [view('c', 400), view('a', 300), view('b', 200)])
    expect(page.map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('重复 id 保留先到的一页，不追加第二份', () => {
    const first = view('a', 300)
    const merged = mergeRoomMessagePages([first], [view('a', 300)])
    expect(merged).toEqual([first])
  })

  it('空 incoming 不新增条目，已有页也重排为正序', () => {
    const existing = [view('a', 300), view('b', 200)]
    expect(mergeRoomMessagePages(existing, []).map(item => item.id)).toEqual(['b', 'a'])
  })
})
