/**
 * 口袋48账号维度的社交接口：关注列表读写、直播间查询（聊天室 id、直播复盘）。
 * 这些接口都要登录 token，失效统一抛「登录已过期」。
 *
 * 对外入口统一是 `./pocket-auth`（barrel），消费方不要直接引用本文件。
 */
import {
  FRIEND_ADD_URL,
  FRIEND_REMOVE_URL,
  FRIENDS_IDS_URL,
  LIVE_ONE_URL,
  LIVE_RESULT_URL,
} from '@common/pocket-api-urls'
import { debug } from '../logger'
import { getToken, postPocket, throwAuthExpired, TOKEN_INVALID_STATUSES } from './pocket-auth-core'

// ===== 关注列表（账号维度） =====

/** 关注对象类型：1=成员；0=队伍（本应用只同步成员，队伍维度无对应概念） */
const FOLLOW_TO_TYPE_MEMBER = 1

/**
 * 拉取当前账号关注的成员 ID 列表。
 * 接口只返回 ID 数组（无分页、无昵称头像），详情由本地成员树解析——
 * 与 yaya_msg 同款策略，未登录返回空数组，token 失效抛「登录已过期」。
 */
export async function getFollowedIds(): Promise<number[]> {
  const token = getToken()
  if (!token)
    return []
  const envelope = await postPocket<Record<string, unknown>>(FRIENDS_IDS_URL, {}, token)
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取关注列表失败')
  const data = (envelope.content as Record<string, unknown> | undefined)?.data
  const ids = (Array.isArray(data) ? data : [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0)
  debug('[pocket-auth] 获取关注成员列表回包：', JSON.stringify({ count: ids.length, userIds: ids }))
  return ids
}

/** 关注成员（桌面端 toggle 双写）：失败抛错，调用方静默降级 */
export async function followMember(userId: number): Promise<void> {
  await postFollow(FRIEND_ADD_URL, userId, '关注')
}

/** 取消关注成员（桌面端 toggle 双写）：失败抛错，调用方静默降级 */
export async function unfollowMember(userId: number): Promise<void> {
  await postFollow(FRIEND_REMOVE_URL, userId, '取消关注')
}

async function postFollow(url: string, userId: number, action: string): Promise<void> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    url,
    { toSourceId: userId, toType: FOLLOW_TO_TYPE_MEMBER },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || `${action}失败`)
}

/**
 * 取直播的网易云信聊天室 id。
 * 无 token 的 getLiveOne 不返回 chatroomId（roomId 恒 0），必须带登录 token 请求；
 * 未登录返回空串，token 失效抛「登录已过期」。
 */
export async function getChatroomId(liveId: string): Promise<string> {
  const token = getToken()
  if (!token)
    return ''
  const envelope = await postPocket<Record<string, unknown>>(
    LIVE_ONE_URL,
    { type: 1, userId: '0', liveId: String(liveId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取直播聊天室 ID 失败')
  const content = envelope.content || {}
  const chatroomId = String(content.chatroomId || '').trim()
  if (chatroomId)
    return chatroomId
  // 兜底 roomId（yaya 同款）：0 表示无聊天室，绝不能当真值——'0' 去连聊天室必然失败
  const roomId = Number(content.roomId)
  return Number.isFinite(roomId) && roomId > 0 ? String(roomId) : ''
}

/**
 * 拉直播结束复盘（live/result）：下播后浮窗展示的总观看 / 本场时长 / 礼物流水 / 榜单前三。
 * 必须带登录 token（实测无 token 服务端报 400「缺少请求参数」）；进行中也可查，下播即时可用。
 * 未登录抛错（调用方降级简版结束卡），token 失效抛「登录已过期」。
 * 字段类型以报文为准：liveTime / totalMoney / liveId 实测都是字符串，bean 声明的 long/int 不可信，
 * 故这里原样回传 content，宽松解析归渲染层 live-result.ts。
 */
export async function getLiveResult(liveId: string): Promise<Record<string, unknown>> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    LIVE_RESULT_URL,
    { liveId: String(liveId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取直播复盘失败')
  return envelope.content || {}
}
