/**
 * 数据库相关 IPC 通道的集中注册。
 *
 * 拆出独立模块的原因：database.ts 里注册会把它变成「import 即有副作用」，
 * 既不可测试，也让依赖方（app.ts）看不到有哪些通道存在。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { ConfigKey } from '@common/app-config'
import type { MemberFlagKind } from '@common/member-flags'
import type { MemberTeamPromotion } from '@common/member-team-promotion'
import { parseConfigValue } from '@common/app-config'
import { promotionOwnerId } from '@common/member-team-promotion'
import { Database } from '../database'
import { getAuthState } from '../pocket48/pocket-auth'
import { handleTraced } from './trace'

/** 升格归属只认主进程的登录凭证；身份不全时拒绝写入 */
function requireOwnerId(): string {
  const owner = promotionOwnerId(getAuthState())
  if (!owner)
    throw new Error('登录口袋账号后才能设置升格')
  return owner
}

export function registerDatabaseIPC(): void {
  const db = () => Database.instance()

  handleTraced('saveMemberData', async (_event, content) => db().saveMemberData(content))
  handleTraced('getAllMembers', async () => db().getAllMembers())
  handleTraced('hasMembers', async () => db().hasMembers())
  handleTraced('getMemberInfo', async (_event, userId) => db().getMemberInfo(userId))
  handleTraced('getMemberFlags', async (_event, kind: MemberFlagKind) => db().getMemberFlags(kind))
  handleTraced('setMemberFlags', async (_event, kind: MemberFlagKind, ids: Array<number | string>) => db().setMemberFlags(kind, ids))
  handleTraced('addMemberFlag', async (_event, kind: MemberFlagKind, userId: number) => db().addMemberFlag(kind, userId))
  handleTraced('addMemberFlags', async (_event, kind: MemberFlagKind, userIds: number[]) => db().addMemberFlags(kind, userIds))
  handleTraced('removeMemberFlag', async (_event, kind: MemberFlagKind, userId: number) => db().removeMemberFlag(kind, userId))
  handleTraced('getMemberTeamPromotions', async () => {
    const owner = promotionOwnerId(getAuthState())
    return owner ? db().getMemberTeamPromotions(owner) : []
  })
  handleTraced('setMemberTeamPromotion', async (_event, promotion: MemberTeamPromotion) => db().setMemberTeamPromotion(promotion, requireOwnerId()))
  handleTraced('removeMemberTeamPromotion', async (_event, userId: number) => db().removeMemberTeamPromotion(requireOwnerId(), userId))
  handleTraced('getConfig', async (_event, key: ConfigKey) => db().getConfig(key))
  // IPC 线格式仍是 string：入口处收窄一次，非法键/取值在此抛错，不落库
  handleTraced('setConfig', async (_event, key: ConfigKey, value: string) => db().setConfig(key, parseConfigValue(key, value)))
  // memberTree 是内存派生数据（不落盘），直接返回内存字段
  handleTraced('getMemberTree', async () => db().memberTree)
}
