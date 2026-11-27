/**
 * 网易云信 IM 凭据与房间发言者资料。
 *
 * - 直播聊天室（pocket-danmaku）与房间 QChat（pocket-room-qchat）都从这里取 accid + imToken，
 *   凭据不出主进程；回到渲染层的只有「登录已过期」这类结论。
 * - 房间发言者资料是 QChat 发送报文 ext.user 的快照，按登录会话缓存，登出/失效时作废。
 *
 * 对外入口统一是 `./pocket-auth`（barrel），消费方不要直接引用本文件。
 */
import { IM_USER_INFO_URL, ROOM_MSG_DELETE_URL, TOKEN_CHECK_URL } from '@common/pocket-api-urls'
import { debug } from '../logger'
import {
  credentials,
  getToken,
  onSessionReset,
  postPocket,
  throwAuthExpired,
  TOKEN_INVALID_STATUSES,
} from './pocket-auth-core'

// ===== 网易云信 IM 凭据（直播聊天室） =====

export interface PocketImCredentials {
  accid: string
  token: string
}

/**
 * 云信 appKey：两个官方 APK 都硬编码同一个值（pocket 在 `NIMStrategy.getOptions()`，
 * seine 在 `e4/p.configIM()`），`im/userinfo` 不下发，故此值即真实值。
 * `PhoneConfig.imKey` 不是 appKey——它是消息防伪盐 `md5(uuid + fromAccount + imKey)`。
 */
export const IM_APP_KEY = '632feff1f4c838541ab75195d1ceb3fa'

/** 脱敏：只留头尾，够区分两个值即可 */
function maskCredential(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 4)}***${value.slice(-4)}`
}

/** 同一账号只报一次：换账号后会再次触发，便于对比不同账号的凭据 */
const credentialReports = new Set<string>()

/**
 * 打印 IM 凭据来源特征，便于排查「凭据是谁签发的」：
 * `accid` 由后端按账号签发，`userId` 是口袋账号 ID，二者一起看即可确定当前连的是哪个账号。
 * userId 不打码（它是房间消息里公开的数字 ID），否则无法逐位比对。
 */
function reportImCredentials(accid: string, content: Record<string, unknown>): void {
  const userId = String(content.userId ?? content.userid ?? '')
  const key = `${userId}:${accid}`
  if (credentialReports.has(key))
    return
  credentialReports.add(key)
  debug('[pocket-auth] IM 凭据诊断：', JSON.stringify({
    回包字段: Object.keys(content).sort().join(','),
    accid: maskCredential(accid),
    userId: userId || '(无)',
  }))
}

/**
 * 取网易云信登录凭据（accid + imToken）。
 * token 失效（401005 等）抛「登录已过期」——渲染层据此引导重新登录。
 */
export async function getImCredentials(): Promise<PocketImCredentials> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    IM_USER_INFO_URL,
    {},
    token,
    { 'P-Sign-Type': 'V0' },
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  const content = envelope.content || {}
  const accid = String(content.accid || content.accId || content.imUserId || '')
  const imToken = String(content.pwd || content.token || content.imPwd || '')
  if (!envelope.success || !accid || !imToken)
    throw new Error(envelope.message || '获取直播聊天室凭据失败')
  reportImCredentials(accid, content)
  return { accid, token: imToken }
}

// ===== 房间发言（QChat 圈组） =====

/**
 * 房间发言者资料快照：QChat 发送报文 ext.user 用（口袋客户端自己拼的那份）。
 * level / roleId / vip / pfUrl / teamLogo / badge 只有 user/info/reload 给，
 * 登录态基础字段（昵称 / 头像 / userId）登录时已落盘。
 */
export interface PocketRoomSenderProfile {
  userId: string
  nickname: string
  avatar: string
  level: number
  roleId: number
  vip: boolean
  pfUrl: string
  teamLogo: string
  badge: string[]
}

/** 资料快照缓存：reload 一次保整个会话（等级 / 身份组短期内不会变） */
let roomSenderProfile: PocketRoomSenderProfile | null = null

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 取房间发言者资料：优先内存缓存；缺失时打一次 user/info/reload 补全字段
 * （verifyLogin 只在设置页手动触发，不能依赖它预热），失败时用登录态基础字段兜底——
 * 等级 / 徽章显示为默认值，不影响发言本身。
 */
export async function getRoomSenderProfile(): Promise<PocketRoomSenderProfile> {
  if (roomSenderProfile)
    return roomSenderProfile
  const stored = credentials.getStored()
  const base: PocketRoomSenderProfile = {
    userId: stored?.userId ?? '',
    nickname: stored?.nickname ?? '',
    avatar: stored?.avatar ?? '',
    level: 0,
    roleId: 0,
    vip: false,
    pfUrl: '',
    teamLogo: '',
    badge: [],
  }
  const token = getToken()
  if (token) {
    try {
      const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token)
      if (envelope.success) {
        const content = (envelope.content || {}) as Record<string, unknown>
        const user = (content.userInfo || content.user || content) as Record<string, unknown>
        roomSenderProfile = {
          ...base,
          userId: base.userId || String(user.userId || user.id || ''),
          nickname: base.nickname || String(user.nickname || user.nickName || ''),
          avatar: base.avatar || String(user.avatar || user.userAvatar || ''),
          level: num(user.level),
          roleId: num(user.roleId),
          vip: user.vip === true,
          pfUrl: String(user.pfUrl || ''),
          teamLogo: String(user.teamLogo || ''),
          badge: Array.isArray(user.badge) ? user.badge.map(item => String(item)) : [],
        }
        return roomSenderProfile
      }
    }
    catch (error) {
      // 资料补全失败不阻断发言：用基础字段继续（ext.user 里等级等为默认值）
      debug('[pocket-auth] 房间发言资料补全失败，使用基础字段', error)
    }
  }
  // 补全失败不写缓存：瞬时失败若缓存了 base，等级 / 徽章 / vip 会整个登录会话都是降级值；
  // 不缓存则下一次发言重新补全（base 的四个字段本就来自本地凭证，重试无副作用）
  return base
}

/** 登录态变更（登出 / 失效）时作废资料缓存：换号后不能沿用上一个账号的资料 */
export function resetRoomSenderProfile(): void {
  roomSenderProfile = null
}

// 登出 / 失效由 core 统一回调，避免 core 反向依赖本模块
onSessionReset(resetRoomSenderProfile)

/**
 * 删除自己发的房间消息（房间发言走 QChat，删除是唯一的 HTTP 写操作）。
 * 服务端按 accId 校验只能删自己的，故 accId 现取 IM 凭据（与发送同源）。
 */
export async function deleteRoomMessage(channelId: string, msgIdClient: string, msgTime: number): Promise<void> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const im = await getImCredentials()
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_MSG_DELETE_URL,
    { accId: im.accid, msgIdClient, channelId, msgTime },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '删除房间消息失败')
}
