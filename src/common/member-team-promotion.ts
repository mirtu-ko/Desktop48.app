/**
 * 预备生「升格」：粉丝把还没分队的成员先放进升格的队伍，仅本机生效，不写回口袋账号。
 *
 * 归属由主进程按登录凭证推导（ownerId），渲染层只交升格内容；
 * 只在房间与直播 / 录播的展示层生效，成员页始终显示服务端真实队伍；
 * 成员官方升格（不再是预备生）后本地升格自动失效。
 */

/** 服务端给未分队练习生的队伍名，也是「可升格」的唯一判据 */
export const TRAINEE_TEAM_NAME = '预备生'

/** 一条升格（渲染层读写的内容）；不含账号身份，身份由主进程补上 */
export interface MemberTeamPromotion {
  userId: number
  teamName: string
  teamColor: string
}

/** 落盘记录：ownerId + userId 是唯一键 */
export interface MemberTeamPromotionRecord extends MemberTeamPromotion {
  ownerId: string
}

/** 推导账号身份所需的登录态字段（PocketAuthState 的最小子集） */
export interface MemberTeamIdentity {
  loggedIn: boolean
  userId?: string
  mobileMasked?: string
}

/** 当前账号标识：userId 优先，缺失时退脱敏手机号；未登录 / 身份不全返回空串 */
export function promotionOwnerId(state: MemberTeamIdentity): string {
  if (!state.loggedIn)
    return ''
  return String(state.userId ?? '').trim() || String(state.mobileMasked ?? '').trim()
}

/** 队伍名是否仍为预备生（空值 / 数字等脏值一律不算） */
export function isTraineeTeam(teamName: unknown): boolean {
  return String(teamName ?? '').trim() === TRAINEE_TEAM_NAME
}

/** 校验来自渲染层的升格；IPC 参数不可信任，必须在主进程再过一遍 */
export function assertMemberTeamPromotion(value: unknown): asserts value is MemberTeamPromotion {
  if (!value || typeof value !== 'object')
    throw new TypeError('Invalid member team promotion')
  const promotion = value as Partial<MemberTeamPromotion>
  if (!Number.isFinite(Number(promotion.userId)))
    throw new TypeError('Invalid member team promotion: userId')
  if (typeof promotion.teamName !== 'string' || !promotion.teamName.trim())
    throw new TypeError('Invalid member team promotion: teamName')
  if (typeof promotion.teamColor !== 'string')
    throw new TypeError('Invalid member team promotion: teamColor')
}

/** 单条白名单归一：多余字段（含旧库的 groupId / groupName 与伪造的 ownerId）一律丢弃 */
export function normalizeMemberTeamPromotionItem(value: unknown): MemberTeamPromotion | null {
  if (!value || typeof value !== 'object')
    return null
  const promotion = value as Partial<MemberTeamPromotion>
  const userId = Number(promotion.userId)
  const teamName = typeof promotion.teamName === 'string' ? promotion.teamName.trim() : ''
  if (!Number.isFinite(userId) || !teamName)
    return null
  return {
    userId,
    teamName,
    teamColor: typeof promotion.teamColor === 'string' ? promotion.teamColor.trim() : '',
  }
}

/** 旧库 / 手改数据归一：丢弃脏记录，同一账号的同一成员保留最后一条 */
export function normalizeMemberTeamPromotions(value: unknown): MemberTeamPromotionRecord[] {
  if (!Array.isArray(value))
    return []
  const byKey = new Map<string, MemberTeamPromotionRecord>()
  for (const item of value) {
    if (!item || typeof item !== 'object')
      continue
    const ownerId = typeof (item as MemberTeamPromotionRecord).ownerId === 'string'
      ? (item as MemberTeamPromotionRecord).ownerId.trim()
      : ''
    const promotion = normalizeMemberTeamPromotionItem(item)
    if (!ownerId || !promotion)
      continue
    byKey.set(`${ownerId}:${promotion.userId}`, { ...promotion, ownerId })
  }
  return [...byKey.values()]
}
