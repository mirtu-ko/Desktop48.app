// 房间消息「按日期查看」的时刻换算、分页合并与错误分类。纯函数，不引 Vue / Element Plus。
import type { PocketRoomChannel } from '@preload/ipc-contract'
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import dayjs from 'dayjs'

type DateInput = Date | number | string | null | undefined

/** 房间历史最早可查日（本地）；更早的记录已归档，接口不再返回 */
export const ROOM_ARCHIVE_START = '2022-04-01'

/** 选中日期的本地 [00:00, 次日 00:00)；无效日期返回 null */
function dayRange(date: DateInput): { start: number, end: number } | null {
  if (date === null || date === undefined || date === '')
    return null
  const start = dayjs(date).startOf('day')
  if (!start.isValid())
    return null
  const range = { start: start.valueOf(), end: start.add(1, 'day').valueOf() }
  return Number.isFinite(range.start) && Number.isFinite(range.end) ? range : null
}

/**
 * 选中日期 → nextTime 游标：次日 00:00（本地）。
 * 接口按 msgTime < nextTime 取页，传当天 00:00 会漏掉当天全部消息；
 * 今天与未来钳到 now，因为服务端对超出当前时刻的游标回空页。
 */
export function dateToNextTime(date: DateInput, now = Date.now()): number {
  const range = dayRange(date)
  if (!range)
    return 0
  const upper = Number.isFinite(now) && now > 0 ? Math.min(range.end, now) : range.end
  return upper > 0 ? upper : 0
}

/**
 * 房间历史可查起点：入团日与归档起点取较晚者（入团前没有该成员的房间消息）。
 * 缺失 / 无效 / 晚于今天的入团日回落到归档起点，否则日期控件会整片禁用。
 */
export function resolveRoomArchiveStart(joinTime: string | null | undefined, now = Date.now()): string {
  const joined = dayRange(joinTime)
  const floor = dayRange(ROOM_ARCHIVE_START)
  if (!joined || !floor)
    return ROOM_ARCHIVE_START
  const today = Number.isFinite(now) && now > 0
    ? dayRange(now)?.start ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
  if (joined.start < floor.start || joined.start > today)
    return ROOM_ARCHIVE_START
  return dayjs(joined.start).format('YYYY-MM-DD')
}

/** 日期是否可查：不早于本房间起点、不晚于今天；供 disabled-date 与请求守卫共用 */
export function isRoomDateQueryable(date: DateInput, now = Date.now(), from = ROOM_ARCHIVE_START): boolean {
  const range = dayRange(date)
  if (!range)
    return false
  const floor = dayRange(from)?.start ?? dayRange(ROOM_ARCHIVE_START)?.start ?? 0
  const today = Number.isFinite(now) && now > 0
    ? dayRange(now)?.start ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
  return range.start >= floor && range.start <= today
}

/** 该页是否含选中日期当天的消息（用于「当天无消息」提示） */
export function hasMessageOnDay(messages: PocketRoomMessageView[], date: DateInput): boolean {
  const range = dayRange(date)
  if (!range)
    return false
  return messages.some(item => item.msgTime >= range.start && item.msgTime < range.end)
}

/** 合并两页：按 id 去重，再按 msgTime 正序（旧在上、新在下，与聊天流同向） */
export function mergeRoomMessagePages(
  existing: PocketRoomMessageView[],
  incoming: PocketRoomMessageView[],
): PocketRoomMessageView[] {
  const merged = new Map<string, PocketRoomMessageView>()
  for (const item of [...existing, ...incoming]) {
    if (!merged.has(item.id))
      merged.set(item.id, item)
  }
  return [...merged.values()].sort((a, b) => a.msgTime - b.msgTime)
}

/** 上翻游标：仅当回包游标严格早于请求值才算推进；空页会把入参原样回显 */
export function nextRoomPageCursor(requested: number, responded: number): number {
  return responded > 0 && responded < requested ? responded : 0
}

/**
 * 历史查询的错误分类：服务端对「查不到消息」回业务失败而非空数组，按空页处理；
 * 其余错误只保留最里层业务文案，去掉 Electron 的 IPC 包装前缀。
 */
export function classifyRoomDateError(error: unknown): { empty: boolean, message: string } {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw.split('Error: ').pop()?.trim() || '读取消息失败'
  return { empty: message.includes('系统处理异常'), message }
}

/** 频道可用性：两个 id 都在才算解析完成 */
function usableChannel(channel: PocketRoomChannel | null): PocketRoomChannel | null {
  return channel?.channelId && channel.serverId ? channel : null
}

/**
 * 按日期查看读取的频道。
 * - 关闭态只认关闭前的留言频道（大房间留言板）：大房间关闭时小房间必然也已关闭，
 *   视图停在 small 也不能盖过存档频道；没解析到就返回 null，不回落 jump 的直播频道
 *   （它对 message/list 恒空，回落等于必然空页）。
 * - 未关闭时按视图取：小房间视图只认小房间频道，大房间视图只认当前频道。
 */
export function resolveDateChannel(input: {
  closed: boolean
  archive: PocketRoomChannel | null
  viewMode: 'room' | 'small'
  small: PocketRoomChannel | null
  room: PocketRoomChannel | null
}): PocketRoomChannel | null {
  if (input.closed)
    return usableChannel(input.archive)
  if (input.viewMode === 'small')
    return usableChannel(input.small)
  return usableChannel(input.room)
}
