/**
 * 成员树的纯函数构建：starInfo + teamInfo + groupInfo → 树状层级。
 *
 * 「原始数据只读」原则下的内存派生（见项目约定）：本模块不持有任何状态、
 * 不做任何 IO，输入什么就返回什么派生结果——因此可以脱离 Electron 直接单测。
 *
 * ⚠️ 与 renderer/src/stores/member-tree.ts **同名但不同层**：那份是渲染端的共享状态单例
 * （请求缓存 + members-updated 失效订阅）；本文件只是建树规则，不持有任何状态。
 * 两者不可合并：渲染端 bundle 无法引主进程模块，跨进程的类型只能声明在
 * preload/ipc-contract.d.ts。
 */

/** starInfo 的一条成员记录（API 原始数据，字段宽容处理） */
export interface MemberRecord {
  userId: number | string
  groupId?: number | string
  groupName?: string
  teamId?: number | string
  teamName?: string
  realName?: string
  teamColor?: string
  [key: string]: unknown
}

/** teamInfo 的一条队伍记录 */
export interface TeamRecord {
  teamId: number | string
  groupId?: number | string
  teamSort?: number
  teamColor?: string
  /** 队伍徽章（可能是相对路径，渲染端负责归一化） */
  seineTeamBadge?: string
  [key: string]: unknown
}

/** groupInfo 的一条团体记录 */
export interface GroupRecord {
  groupId: number | string
  groupName?: string
  groupSort?: number
  [key: string]: unknown
}

/**
 * 团体别名表：原始 groupId → 归属团体 groupId。
 *
 * 「明星殿堂」(19) 实际是 SNH48 的升堂荣誉队伍 —— 4 位成员的 teamId 都是 1008，
 * 其中孙芮/李艺彤/鞠婧祎仍标 SNH48(10)，只有袁一琦被数据源单独标成 19。
 * 不归一她就会从 SNH48 tab 与回放筛选里掉出去（tab 按 groupId 筛），
 * 成员库还会多出一个「明星殿堂」的单人分区。
 */
const GROUP_ALIASES: Record<string, number | string> = { 19: 10 }

/** 树节点里队伍的摘要信息（供成员页分组标题/筛选使用） */
export interface MemberTreeTeamSummary {
  teamName: string
  label: string
  value: string
}

/** 成员树叶子节点：成员原始字段的浅拷贝 + 派生 teamColor */
export interface MemberTreeMemberNode {
  label: string
  value: string
  [key: string]: unknown
}

/** 队伍节点 */
export interface MemberTreeTeamNode extends MemberTreeTeamSummary {
  teamBadge: string
  children: MemberTreeMemberNode[]
}

/** 团体节点（树的根层） */
export interface MemberTreeGroupNode {
  groupName: string
  groupId: number | string | undefined
  label: string
  value: string
  children: MemberTreeTeamNode[]
}

const sameId = (a: unknown, b: unknown) => Number(a) === Number(b)

/** 按队伍 id 从 teamInfo 查队伍色（原始 starInfo 不带颜色）；成员树与 getMember 派生 teamColor 的同款规则 */
export function teamColorOf(teamInfo: TeamRecord[] | undefined, teamId: number | string | undefined): string {
  const t = teamInfo?.find(i => sameId(i.teamId, teamId))
  return t?.teamColor || ''
}

/** 按团体 id 从 groupInfo 查显示名（别名团体归一后名字要跟着归属团体走，否则会按 groupName 另起一个分组） */
function groupNameOf(groupInfo: GroupRecord[] | undefined, groupId: number | string | undefined): string {
  const name = groupInfo?.find(i => sameId(i.groupId, groupId))?.groupName
  return typeof name === 'string' ? name : ''
}

/**
 * 构建成员树。用 groupName/teamName 字符串分组，保持树状层级；
 * 同时记录 groupId / teamId 供回放按维度筛选；value 一律用 id 字符串。
 *
 * @param starInfo  成员原始数据
 * @param teamInfo  队伍原始数据（提供排序权重、徽章、队伍色）
 * @param groupInfo 团体原始数据（提供排序权重；团体别名归一后也由它取归属团体的显示名）
 */
export function buildMemberTree(
  starInfo: MemberRecord[] | undefined,
  teamInfo: TeamRecord[] | undefined,
  groupInfo: GroupRecord[] | undefined,
): MemberTreeGroupNode[] {
  const groupMap = new Map<string, {
    groupId: number | string | undefined
    groupName: string
    teams: Map<string, { teamId: number | string | undefined, teamName: string, members: MemberRecord[] }>
  }>()

  for (const member of starInfo || []) {
    // 别名团体（见 GROUP_ALIASES）的 id 与显示名一起归到归属团体，与同 teamId 的队友并成一队
    const alias = GROUP_ALIASES[String(member.groupId)]
    const groupId = alias ?? member.groupId
    const groupName = (alias === undefined ? '' : groupNameOf(groupInfo, groupId)) || member.groupName || '未分组'
    const teamName = member.teamName || '未分队'
    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, { groupId, groupName, teams: new Map() })
    }
    const group = groupMap.get(groupName)!
    group.groupId ??= groupId
    if (!group.teams.has(teamName)) {
      group.teams.set(teamName, { teamId: member.teamId, teamName, members: [] })
    }
    const team = group.teams.get(teamName)!
    team.teamId ??= member.teamId
    team.members.push(member)
  }

  // 排序权重：按 groupSort / teamSort；查不到的排到末尾
  const groupSortOf = (groupId: number | string | undefined) => {
    const g = groupInfo?.find(i => sameId(i.groupId, groupId))
    return g?.groupSort ?? Number.MAX_SAFE_INTEGER
  }
  const teamSortOf = (groupId: number | string | undefined, teamId: number | string | undefined) => {
    const t = teamInfo?.find(i => sameId(i.groupId, groupId) && sameId(i.teamId, teamId))
    return t?.teamSort ?? Number.MAX_SAFE_INTEGER
  }
  const teamBadgeOf = (teamId: number | string | undefined) => {
    const t = teamInfo?.find(i => sameId(i.teamId, teamId))
    return t?.seineTeamBadge || ''
  }

  // 转换为派生结构；group/team/member 的 value 用 id 字符串，便于回放按维度筛选
  return [...groupMap.values()]
    .sort((a, b) => groupSortOf(a.groupId) - groupSortOf(b.groupId))
    .map((group) => {
      const teamNodes = [...group.teams.values()]
        .sort((a, b) => teamSortOf(group.groupId, a.teamId) - teamSortOf(group.groupId, b.teamId))
        .map((team): MemberTreeTeamNode => ({
          teamName: team.teamName,
          label: team.teamName,
          value: String(team.teamId),
          // 队伍徽章（seineTeamBadge，可能是相对路径，渲染端负责归一化），供成员页分组标题展示
          teamBadge: teamBadgeOf(team.teamId),
          children: team.members.map((member): MemberTreeMemberNode => ({
            label: member.realName || '',
            value: String(member.userId),
            ...member,
            // 别名团体归一后叶子也要跟着分组走（否则成员自带的 groupId/groupName 与所在分组矛盾，
            // 任何按叶子 groupId 判断的地方都会漏掉这个成员）
            groupId: group.groupId,
            groupName: group.groupName,
            // teamColor 纯派生：优先取 teamInfo 里的队伍色（原始数据不做任何改写），
            // 查不到队伍时退回成员自带颜色，再退空串
            teamColor: teamColorOf(teamInfo, team.teamId) || member.teamColor || '',
          })),
        }))
      return {
        groupName: group.groupName,
        groupId: group.groupId,
        label: group.groupName,
        value: String(group.groupId),
        children: teamNodes,
      }
    })
}
