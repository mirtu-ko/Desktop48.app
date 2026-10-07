import { describe, expect, it } from 'vitest'
import {
  birthdayOffset,
  daysUntilBirthday,
  formatBirthdayCountdown,
  memberDaysUntilBirthday,
  monthBirthdays,
  nextUpcomingBirthday,
  parseBirthday,
  todayBirthdays,
} from '../src/renderer/src/utils/member-birthday'
import { makeMember, memberNames } from './fixtures/member'

/** 固定「今天」：2026-10-07（本地时间）。用例一律对着它算，不跟着真实日期漂 */
const TODAY = new Date(2026, 9, 7)

describe('parseBirthday（宽松解析接口下发的多种生日格式）', () => {
  it('带年份的四种写法都认', () => {
    for (const raw of ['1998-03-15', '1998/3/15', '1998.3.15', '1998年3月15日']) {
      expect(parseBirthday(raw), raw).toEqual({ month: 3, day: 15, year: 1998 })
    }
  })

  it('只有月日也认（03-15 / 3月15日 / 0315）', () => {
    expect(parseBirthday('03-15')).toEqual({ month: 3, day: 15, year: 0 })
    expect(parseBirthday('3月15日')).toEqual({ month: 3, day: 15, year: 0 })
    expect(parseBirthday('0315')).toEqual({ month: 3, day: 15, year: 0 })
  })

  it('空值、只给年份、越界月日一律判为无效', () => {
    for (const raw of ['', '   ', undefined, '1998', '13-01', '02-30', '0']) {
      expect(parseBirthday(raw), String(raw)).toBeNull()
    }
  })

  it('2 月 29 日是合法日期（闰年与否交给 Date 回卷，不在这里拒绝）', () => {
    expect(parseBirthday('2000-02-29')).toEqual({ month: 2, day: 29, year: 2000 })
  })
})

describe('birthdayOffset / daysUntilBirthday（两个方向的天数）', () => {
  it('今天为 0，本月已过为负，未到为正', () => {
    expect(birthdayOffset({ month: 10, day: 7, year: 0 }, TODAY)).toBe(0)
    expect(birthdayOffset({ month: 10, day: 1, year: 0 }, TODAY)).toBe(-6)
    expect(birthdayOffset({ month: 12, day: 25, year: 0 }, TODAY)).toBe(79)
  })

  it('daysUntilBirthday 把已过的滚到明年，恒 >= 0', () => {
    expect(daysUntilBirthday({ month: 10, day: 7, year: 0 }, TODAY)).toBe(0)
    expect(daysUntilBirthday({ month: 10, day: 1, year: 0 }, TODAY)).toBe(359)
  })

  it('跨年：12 月底看 1 月初的生日，滚到明年后只差几天', () => {
    const newYearEve = new Date(2026, 11, 30)
    expect(daysUntilBirthday({ month: 1, day: 5, year: 0 }, newYearEve)).toBe(6)
    expect(birthdayOffset({ month: 1, day: 5, year: 0 }, newYearEve)).toBeLessThan(0)
  })

  it('memberDaysUntilBirthday 在生日缺失时返回 null（详情卡据此不渲染该项）', () => {
    expect(memberDaysUntilBirthday(makeMember({ realName: '甲', birthday: '1998-10-07' }), TODAY)).toBe(0)
    expect(memberDaysUntilBirthday(makeMember({ realName: '乙', birthday: '' }), TODAY)).toBeNull()
    expect(memberDaysUntilBirthday(makeMember({ realName: '丙', birthday: '1998' }), TODAY)).toBeNull()
  })
})

describe('formatBirthdayCountdown（倒计时文案）', () => {
  it('今天 / 明天 / 还有 N 天 / 已过', () => {
    expect(formatBirthdayCountdown(0)).toBe('今天')
    expect(formatBirthdayCountdown(1)).toBe('明天')
    expect(formatBirthdayCountdown(9)).toBe('还有 9 天')
    expect(formatBirthdayCountdown(-1)).toBe('已过')
  })
})

describe('monthBirthdays（本月寿星，按日期升序）', () => {
  const members = [
    makeMember({ realName: '十月末', birthday: '1998-10-28' }),
    makeMember({ realName: '今天', birthday: '10-07' }),
    makeMember({ realName: '十月头', birthday: '1999年10月1日' }),
    makeMember({ realName: '十一月', birthday: '1998-11-03' }),
    makeMember({ realName: '没生日', birthday: '' }),
  ]

  it('只留本月，按日期升序，并带上相对今天的天数', () => {
    const entries = monthBirthdays(members, TODAY)
    expect(memberNames(entries.map(entry => entry.member))).toEqual(['十月头', '今天', '十月末'])
    expect(entries.map(entry => entry.offset)).toEqual([-6, 0, 21])
  })

  it('同一天多人时按姓名定序，顺序稳定', () => {
    const sameDay = [
      makeMember({ realName: '乙', birthday: '10-20' }),
      makeMember({ realName: '甲', birthday: '10-20' }),
    ]
    expect(memberNames(monthBirthdays(sameDay, TODAY).map(entry => entry.member))).toEqual(['甲', '乙'])
  })

  it('本月无人过生日时返回空数组', () => {
    expect(monthBirthdays([makeMember({ realName: '甲', birthday: '1998-01-01' })], TODAY)).toEqual([])
  })
})

describe('todayBirthdays / nextUpcomingBirthday', () => {
  const entries = monthBirthdays([
    makeMember({ realName: '已过', birthday: '10-01' }),
    makeMember({ realName: '今天', birthday: '10-07' }),
    makeMember({ realName: '还有两天', birthday: '10-09' }),
    makeMember({ realName: '月底', birthday: '10-31' }),
  ], TODAY)

  it('挑出今天生日的人', () => {
    expect(memberNames(todayBirthdays(entries).map(entry => entry.member))).toEqual(['今天'])
  })

  it('下一位是最近的未到者，而不是列表里的下一个', () => {
    expect(nextUpcomingBirthday(entries)?.member.realName).toBe('还有两天')
  })

  it('本月剩下的都过完时没有「下一位」', () => {
    const past = monthBirthdays([makeMember({ realName: '甲', birthday: '10-01' })], TODAY)
    expect(nextUpcomingBirthday(past)).toBeNull()
  })
})
