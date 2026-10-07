/**
 * 生日解析与倒计时（纯函数：无状态、无 IO，可脱离 Electron 直接单测）。
 * 成员页的「生日墙」横幅与成员详情卡共用这一份口径，页面里不再各写一套日期算法。
 *
 * 接口下发的 birthday 格式并不统一（starInfo 与 allmembers 两个数据源混用），
 * 实测出现过 1998-03-15 / 1998/3/15 / 1998.3.15 / 1998年3月15日 / 03-15 / 3月15日 / 0315，
 * 故解析一律走宽松匹配；只给了年份的（如「1998」）无法定位到日，判为无效。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'

export interface BirthdayDate {
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  /** 接口未给年份时为 0 */
  year: number
}

export interface BirthdayEntry {
  member: MemberDetail
  month: number
  day: number
  /** 相对今天的天数：0 = 今天，负数 = 本月内已过，正数 = 还有几天 */
  offset: number
}

/** 各月天数上限（2 月按 29 放宽，闰年与否交给 Date 自行回卷，不必在这里判） */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const MS_PER_DAY = 86400000

/** 月日合法性校验，不合法返回 null（脏数据不该产出 13 月 32 日这种条目） */
function makeBirthday(month: number, day: number, year: number): BirthdayDate | null {
  if (!Number.isInteger(month) || !Number.isInteger(day))
    return null
  if (month < 1 || month > 12)
    return null
  if (day < 1 || day > DAYS_IN_MONTH[month - 1])
    return null
  return { month, day, year }
}

/**
 * 生日文本解析：兼容 1998-03-15 / 1998/3/15 / 1998.3.15 / 1998年3月15日 /
 * 03-15 / 3月15日 / 0315。识别不出（含只给年份）时返回 null。
 */
export function parseBirthday(value: string | undefined): BirthdayDate | null {
  const raw = (value || '').trim()
  if (!raw)
    return null

  // 带年份：四位数年份 + 任意分隔符 + 月 + 任意分隔符 + 日
  const full = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  if (full)
    return makeBirthday(Number(full[2]), Number(full[3]), Number(full[1]))

  // 只有月日且带分隔符：03-15 / 3月15日
  const monthDay = raw.match(/^(\d{1,2})\D+(\d{1,2})\D*$/)
  if (monthDay)
    return makeBirthday(Number(monthDay[1]), Number(monthDay[2]), 0)

  // 紧凑月日：0315
  const compact = raw.match(/^(\d{2})(\d{2})$/)
  if (compact)
    return makeBirthday(Number(compact[1]), Number(compact[2]), 0)

  return null
}

/** 当天零点：日期差一律按「天」算，先抹掉时分秒再相减 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * 生日相对今天的天数（同一年内，不跨年回卷）：
 * 0 = 今天，负数 = 今年已过，正数 = 今年还有几天。
 * 生日墙需要区分「已过」与「未到」，故与 daysUntilBirthday 分开。
 */
export function birthdayOffset(birthday: BirthdayDate, today: Date): number {
  const start = startOfDay(today)
  const target = new Date(start.getFullYear(), birthday.month - 1, birthday.day)
  return Math.round((target.getTime() - start.getTime()) / MS_PER_DAY)
}

/** 距下次生日的天数：已过则滚到明年，恒 >= 0（今天为 0）。详情卡用这个口径 */
export function daysUntilBirthday(birthday: BirthdayDate, today: Date): number {
  const offset = birthdayOffset(birthday, today)
  if (offset >= 0)
    return offset
  const start = startOfDay(today)
  const target = new Date(start.getFullYear() + 1, birthday.month - 1, birthday.day)
  return Math.round((target.getTime() - start.getTime()) / MS_PER_DAY)
}

/** 成员距下次生日的天数；生日缺失或解析不出时返回 null（详情卡据此决定要不要展示这一项） */
export function memberDaysUntilBirthday(member: MemberDetail, today: Date): number | null {
  const birthday = parseBirthday(member.birthday)
  return birthday ? daysUntilBirthday(birthday, today) : null
}

/** 倒计时文案：今天 / 明天 / 还有 N 天 / 已过 */
export function formatBirthdayCountdown(offset: number): string {
  if (offset === 0)
    return '今天'
  if (offset === 1)
    return '明天'
  return offset > 1 ? `还有 ${offset} 天` : '已过'
}

/** 本月寿星（含本月内已过完的），按日期升序 —— 生日墙展开后的列表顺序 */
export function monthBirthdays(members: MemberDetail[], today: Date): BirthdayEntry[] {
  const month = today.getMonth() + 1
  const entries: BirthdayEntry[] = []
  for (const member of members) {
    const birthday = parseBirthday(member.birthday)
    if (!birthday || birthday.month !== month)
      continue
    entries.push({
      member,
      month: birthday.month,
      day: birthday.day,
      offset: birthdayOffset(birthday, today),
    })
  }
  // 同一天多人时按姓名定序，保证每次渲染顺序稳定
  return entries.sort((a, b) =>
    a.day === b.day ? a.member.realName.localeCompare(b.member.realName, 'zh-Hans-CN') : a.day - b.day,
  )
}

/** 今天生日的人（入参须是 monthBirthdays 的结果） */
export function todayBirthdays(entries: BirthdayEntry[]): BirthdayEntry[] {
  return entries.filter(entry => entry.offset === 0)
}

/** 本月最近的未到生日；本月剩下的都已过完时返回 null */
export function nextUpcomingBirthday(entries: BirthdayEntry[]): BirthdayEntry | null {
  return entries.find(entry => entry.offset > 0) ?? null
}
