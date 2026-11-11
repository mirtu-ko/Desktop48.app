import dayjs from 'dayjs'

/** 相对写法的上限：超过一周改用绝对日期，避免「187 天前」这类无意义表述 */
const RELATIVE_DAYS = 7

type DateInput = string | number | null | undefined

/** 毫秒时间戳串按数值解析，其余交给 dayjs 解析已格式化的日期串 */
function parse(input: DateInput) {
  if (input === null || input === undefined || input === '')
    return null
  const value = typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : input
  const date = dayjs(value)
  return date.isValid() ? date : null
}

/**
 * 卡片日期的相对写法：今天显示时刻、昨天显示「昨天」、一周内显示「N 天前」，
 * 更早（或脏数据落在未来）回退绝对日期。无效输入返回 null，由调用方回退原日期串。
 * 用于直播页空态「打发时间」区；正式列表仍用完整的 YYYY-MM-DD HH:mm:ss。
 */
export function formatRelativeDate(input: DateInput, now: number = Date.now()): string | null {
  const date = parse(input)
  if (!date)
    return null

  const today = dayjs(now).startOf('day')
  // 按自然日取整：跨夏令时或毫秒级偏差都不该把「昨天」算成「2 天前」
  const diffDays = Math.round(today.diff(date.startOf('day'), 'day'))
  if (diffDays < 0)
    return date.format('YYYY-MM-DD')
  if (diffDays === 0)
    return `今天 ${date.format('HH:mm')}`
  if (diffDays === 1)
    return `昨天 ${date.format('HH:mm')}`
  if (diffDays < RELATIVE_DAYS)
    return `${diffDays} 天前 ${date.format('HH:mm')}`
  return date.year() === today.year() ? date.format('M月D日') : date.format('YYYY年M月D日')
}
