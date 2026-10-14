/**
 * B 站官方直播间信息拉取。公演条目缺团体信息时，渲染层以在播房间标题做公演名兜底匹配。
 * get_info 匿名可访问；结果缓存 5 分钟，单房间失败以空标题占位。
 */
import type { BilibiliRoomInfo } from '../../common/bilibili-rooms'
import { GROUP_ROOMS } from '../../common/bilibili-rooms'
import { debugLog } from '../../common/log'

const ROOM_INFO_URL = 'https://api.live.bilibili.com/room/v1/Room/get_info'
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000

let cache: { at: number, infos: BilibiliRoomInfo[] } | null = null

/** 拉取单房间信息；接口风控/超时时抛错 */
async function fetchRoomInfo(roomId: number): Promise<BilibiliRoomInfo> {
  const response = await fetch(`${ROOM_INFO_URL}?room_id=${roomId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await response.json() as { code?: number, data?: { title?: string, live_status?: number } }
  if (body.code !== 0 || !body.data)
    throw new Error(`code=${body.code}`)
  return {
    roomId,
    title: body.data.title || '',
    liveStatus: body.data.live_status ?? 0,
  }
}

/** 拉取全部团体的房间信息（带缓存）；失败的房间以空标题占位 */
export async function getBilibiliRoomInfos(): Promise<BilibiliRoomInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS)
    return cache.infos
  const infos = await Promise.all(
    Object.entries(GROUP_ROOMS).map(async ([label, roomId]) => {
      try {
        return await fetchRoomInfo(roomId)
      }
      catch (error) {
        debugLog('show', `B站房间信息获取失败 room=${roomId}(${label}):`, error)
        return { roomId, title: '', liveStatus: 0 }
      }
    }),
  )
  cache = { at: Date.now(), infos }
  return infos
}
