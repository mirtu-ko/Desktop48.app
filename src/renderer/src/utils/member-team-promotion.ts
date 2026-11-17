/**
 * 预备生升格的纯逻辑：可选队伍目录 + 展示队伍计算。
 *
 * 队伍目录只认成员树里「有官方队徽」的队伍：预备生、荣誉队伍与已解散队伍都没有队徽，
 * 一条判据即可挡掉，队名 / 队色 / 队徽全部来自同一份团队表（teamInfo），不再另抄名单。
 */
import type { MemberTeamPromotion } from '@common/member-team-promotion'
import type { MemberTreeGroupPayload } from '@preload/ipc-contract'
import { isTraineeTeam } from '@common/member-team-promotion'
import Tools from '@renderer/utils/tools'

export interface TeamOption {
  teamName: string
  teamColor: string
  teamBadge: string
  groupName: string
}

/**
 * 按 userId 在成员树里定位所属团体，返回该团有队徽的队伍。
 * 团体归属不再依赖名录异步反查，也就不会在打开弹窗时因资料未就绪而给出空选项。
 */
export function teamOptionsOfMember(
  tree: MemberTreeGroupPayload[],
  userId: number | string | undefined | null,
): TeamOption[] {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id))
    return []
  const group = tree.find(item => (item.children || []).some(team =>
    (team.children || []).some(member => Tools.normalizeUserId(member.userId) === id),
  ))
  if (!group)
    return []
  return (group.children || []).flatMap((team) => {
    const teamBadge = Tools.sourceUrl(team.teamBadge || '')
    if (!teamBadge || isTraineeTeam(team.teamName))
      return []
    return [{
      teamName: team.teamName,
      teamColor: team.teamColor || '',
      teamBadge,
      groupName: group.groupName,
    }]
  })
}

/** 计算展示用队伍：仅当成员当前仍是预备生且存在本地升格时覆盖 */
export function resolveMemberTeam(
  original: { teamName?: string, teamColor?: string },
  promotion: MemberTeamPromotion | null | undefined,
): { teamName: string, teamColor: string } {
  if (!promotion || !isTraineeTeam(original.teamName))
    return { teamName: original.teamName || '', teamColor: original.teamColor || '' }
  return { teamName: promotion.teamName, teamColor: promotion.teamColor }
}
