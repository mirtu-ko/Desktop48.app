import type { MemberDetail } from '@renderer/utils/member-merge'
import type { SortKey } from '@renderer/utils/member-sort'
import Constants from '@renderer/utils/constants'
import { sortMembers } from '@renderer/utils/member-sort'
import { normalizeKeyword } from '@renderer/utils/text-highlight'
import Tools from '@renderer/utils/tools'

/** 成员列表的命中判定 + 分区组织（纯函数，可脱离 Electron 单测）。分区内部排序见 utils/member-sort.ts */

export interface MemberSection {
  /** 分区标识（团体 + 队伍 / 状态分区名） */
  key: string
  title: string
  /** 队伍徽章（合并时已归一化） */
  teamBadge: string
  /** 分区标题主题色：跟随队伍 teamColor；暂休/退团走弱化灰变体 */
  accent?: string
  /** 分团官方 logo；查不到所属团体的走 Constants.GroupLogoFallback，故必有值 */
  groupLogo: string
  /** 暂休 / 退团分区：整块退成中性灰，不与在团队伍抢注意力 */
  muted?: boolean
  members: MemberDetail[]
}

/** 命中判定：姓名 / 昵称 / 拼音缩写任一包含关键词即命中。关键词在函数内自行归一化 */
export function memberMatches(member: MemberDetail, keyword: string): boolean {
  const kw = normalizeKeyword(keyword)
  if (!kw)
    return true
  return [member.realName, member.nickname, member.abbr]
    .some(field => (field || '').toLowerCase().includes(kw))
}

/** 按队伍分区：入参已按树的顺序（团体 → teamSort）排好，用 Map 保住首现顺序；徽章缺失时用分团 logo 兜底 */
export function groupByTeam(list: MemberDetail[], withGroup: boolean): MemberSection[] {
  const sections = new Map<string, MemberSection>()
  const groupLogoOf = (member: MemberDetail) =>
    Constants.GroupTabs.find(item => item.key === String(member.groupId))?.logoPng
    || Constants.GroupLogoFallback
  for (const member of list) {
    const key = `${member.groupName}/${member.teamName}`
    const existing = sections.get(key)
    if (existing) {
      existing.members.push(member)
      continue
    }
    sections.set(key, {
      key,
      title: withGroup ? `${member.groupName} · ${member.teamName}` : member.teamName,
      teamBadge: member.teamBadge,
      accent: Tools.toHex(member.teamColor),
      groupLogo: groupLogoOf(member),
      members: [member],
    })
  }
  return [...sections.values()]
}

/** 先分组后排序：分组在未排序的列表上做，分区顺序不随排序口径变化（先排后分会整页重排） */
export function buildSections(list: MemberDetail[], withGroup: boolean, sortKey: SortKey): MemberSection[] {
  const grouped = groupByTeam(list, withGroup)
  for (const section of grouped)
    section.members = sortMembers(section.members, sortKey)
  return grouped
}

/** 卡片 key：兼任记录用兼职档案主键（加前缀，避免数值上与别的 userId 相撞），其余用 userId / sid */
export function memberCardKey(member: MemberDetail): string | number {
  if (member.adjunctId !== undefined)
    return `adjunct-${member.adjunctId}`
  return member.userId ?? member.sid
}
