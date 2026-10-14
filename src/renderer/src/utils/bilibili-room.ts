/**
 * 公演 → B 站官方直播间号解析。
 *
 * 三级策略，从严到宽：
 * 1. teamList[0].groupId 查团体房间表（数据权威，首选）；
 * 2. 标题/副标题文本匹配：先认团体名（SNH48…），再认队伍名（TEAM X…）——接口给的
 *    teamName 是「TEAM SII」这类队伍名、不含团体名，所以队伍名也要一张表；
 * 3. 运行时兜底：拉 B 站官方直播间标题（**只保留在播中的**），公演名（《》书名号段）
 *    与房间标题互相包含即命中 —— teamList 为空且文本毫无团体信号的公演（新生公演、
 *    生日会等）靠这层自动发现，无需人工维护映射。
 */
import type { BilibiliRoomInfo } from '../../../common/bilibili-rooms'
import { GROUP_ROOMS } from '../../../common/bilibili-rooms'
import Constants from './constants'
import { debugLog } from './debug'

/** 队伍名 → 团体名。匹配统一转大写做包含判断；跨团体无同名词，长名先查即可避免 TEAM NIII 被 TEAM NII 抢中 */
const TEAM_GROUP: Record<string, string> = {
  'TEAM SII': 'SNH48',
  'TEAM NII': 'SNH48',
  'TEAM HII': 'SNH48',
  'TEAM X': 'SNH48',
  'TEAM B': 'BEJ48',
  'TEAM E': 'BEJ48',
  'TEAM J': 'BEJ48',
  'TEAM NIII': 'GNZ48',
  'TEAM G': 'GNZ48',
  'TEAM Z': 'GNZ48',
  'TEAM K': 'CKG48',
}
/** 长名优先（TEAM NIII 必须先于 TEAM NII 参与匹配） */
const TEAM_NAMES = Object.keys(TEAM_GROUP).sort((a, b) => b.length - a.length)

/**
 * groupId → 房间号。团体名的合法取值只有 Constants.GroupTabs 一处，故先归一成团体名再查表，
 * 不再单独维护一张 groupId → 房间的映射。
 */
function roomIdOfGroupId(groupId: number): number | undefined {
  const label = Constants.GroupTabs.find(tab => tab.key === String(groupId))?.label
  return label ? GROUP_ROOMS[label] : undefined
}

/** 文本匹配（团体名 → 队伍名逐级兜底）；匹配不到返回 undefined */
function roomIdOfTexts(texts: Array<string | undefined>): number | undefined {
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(' ')
    .toUpperCase()
  if (!haystack)
    return undefined
  for (const { label } of Constants.GroupTabs) {
    const roomId = GROUP_ROOMS[label]
    if (roomId !== undefined && haystack.includes(label))
      return roomId
  }
  for (const team of TEAM_NAMES) {
    if (haystack.includes(team))
      return GROUP_ROOMS[TEAM_GROUP[team]]
  }
  return undefined
}

/**
 * 从公演条目同步解析 B 站直播间号（离线表，纯本地）。
 * teamList 为空且文本无团体/队伍信号时返回 undefined，交给 resolveBilibiliRoomIdAsync 走在线兜底。
 */
export function resolveBilibiliRoomId(options: {
  /** teamList[0].groupId；缺失或表里查不到房间时只用 texts 兜底 */
  groupId?: number
  /** 标题与副标题，仅在 groupId 不奏效时参与匹配 */
  texts?: Array<string | undefined>
}): number | undefined {
  if (options.groupId !== undefined) {
    const roomId = roomIdOfGroupId(options.groupId)
    if (roomId !== undefined)
      return roomId
  }
  return roomIdOfTexts(options.texts ?? [])
}

/** 提取文本里的《》书名号段（公演名），全大写归一 */
function stageSegments(texts: Array<string | undefined>): string[] {
  const segments: string[] = []
  for (const text of texts) {
    if (!text)
      continue
    for (const match of text.matchAll(/《([^》]+)》/g))
      segments.push(match[1].toUpperCase())
  }
  return segments
}

/**
 * 在线兜底：拿在播中（live_status=1）的官方房间标题与公演名互配。
 * 房间标题形如「SNH48 《心的旅程》新生公演」，口袋侧给「《心的旅程》公演 / 新生公演」——
 * 书名号段互相包含即命中。拉取失败（风控/断网）静默返回 undefined，退化为无弹幕。
 */
export async function resolveBilibiliRoomIdAsync(options: {
  groupId?: number
  texts?: Array<string | undefined>
}): Promise<number | undefined> {
  const offline = resolveBilibiliRoomId(options)
  if (offline !== undefined)
    return offline

  const texts = (options.texts ?? []).filter((text): text is string => !!text)
  if (!texts.length)
    return undefined

  let infos: BilibiliRoomInfo[]
  try {
    infos = await window.mainAPI.bilibiliRoomInfos()
  }
  catch (error) {
    debugLog('show', 'B站房间信息拉取失败，弹幕房间映射跳过:', error)
    return undefined
  }

  // 只认在播中的房间：官方房间轮播/回放时标题与当前公演无关，参与匹配只会误配
  const liveRooms = infos.filter(info => info.liveStatus === 1 && info.title)
  const segments = stageSegments(texts)
  if (!liveRooms.length)
    return undefined

  let best: { roomId: number, score: number } | undefined
  for (const room of liveRooms) {
    const title = room.title.toUpperCase()
    // 命中打分：书名号段（公演名）权重高，整串文本包含兜底
    const segmentHit = segments.some(segment => title.includes(segment))
    const textHit = texts.some(text => title.includes(text.toUpperCase()))
    if (!segmentHit && !textHit)
      continue
    const score = (segmentHit ? 100 : 0) + (textHit ? 50 : 0)
    if (!best || score > best.score)
      best = { roomId: room.roomId, score }
  }

  if (best)
    debugLog('show', `B站弹幕房间在线匹配: roomId=${best.roomId}（标题命中，score=${best.score}）`)
  else
    debugLog('show', 'B站弹幕房间在线匹配: 在播房间标题均不含公演名，跳过', { texts, liveRooms })
  return best?.roomId
}
