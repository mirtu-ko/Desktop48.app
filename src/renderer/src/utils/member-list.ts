import type { MemberDetail } from '@renderer/utils/member-merge'
import type { SortKey } from '@renderer/utils/member-sort'
import Constants from '@renderer/utils/constants'
import { sortMembers } from '@renderer/utils/member-sort'
import { normalizeKeyword } from '@renderer/utils/text-highlight'
import Tools from '@renderer/utils/tools'

/**
 * 成员列表的「命中判定 + 分区组织」（纯函数：无状态、无 IO，可脱离 Electron 直接单测）。
 *
 * 与 utils/member-sort.ts 的分工：这里负责「谁进哪个分区、分区怎么排」，
 * 那里负责「分区内部怎么排」。
 */

export interface MemberSection {
  /** 分区标识（团体 + 队伍 / 状态分区名） */
  key: string
  title: string
  /** 队伍徽章（合并时已归一化） */
  teamBadge: string
  /** 分区标题主题色：跟随队伍 teamColor；暂休/退团走弱化灰变体 */
  accent?: string
  /**
   * 分团官方 logo（snh48.com 的 about-logo-*.png）：队伍徽章缺失时充当标题左侧图标；
   * 查不到所属团体 logo 的团体（IDFT / 燃烧吧团魂 等）走 `Constants.GroupLogoFallback`，故必有值
   */
  groupLogo: string
  /** 暂休 / 退团分区：整块退成中性灰，不与在团队伍抢注意力 */
  muted?: boolean
  members: MemberDetail[]
}

/**
 * 命中判定：姓名 / 昵称 / 拼音缩写三个字段任一包含关键词即算命中。
 * 与回放页筛选器 filterMethod 的口径一致（那里多了拼音全拼，成员合并记录里没有这个字段）。
 * 关键词在函数内自行归一化，调用方不必先处理 —— 少一个「忘了转小写」的坑。
 */
export function memberMatches(member: MemberDetail, keyword: string): boolean {
  const kw = normalizeKeyword(keyword)
  if (!kw)
    return true
  return [member.realName, member.nickname, member.abbr]
    .some(field => (field || '').toLowerCase().includes(kw))
}

/**
 * 按队伍分区：入参已按树的顺序（团体 → teamSort）排好，用 Map 保住首现顺序。
 * 队伍徽章缺失时用分团 logo 兜底（表里没有的团体与暂休 / 退团分区一律退 GroupLogoFallback）。
 */
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

/**
 * 分区顺序恒定：分组一律在「未排序」的列表上做，排序只作用于分区内部。
 * 若先排序再分组，分区的首现顺序会跟着排序结果变，切一次排序整页队伍块就重排一次；
 * 现在队伍块的位置只由成员库本身的分组顺序决定，与 默认 / 排名 / 姓名 无关。
 */
export function buildSections(list: MemberDetail[], withGroup: boolean, sortKey: SortKey): MemberSection[] {
  const grouped = groupByTeam(list, withGroup)
  for (const section of grouped)
    section.members = sortMembers(section.members, sortKey)
  return grouped
}

/**
 * 卡片 key：兼任记录用兼职档案主键（加前缀，避免数值上与别的 userId 相撞），
 * 其余成员用 userId / sid 兜底。兼任与本人共用 userId，只有它能区分两张卡。
 */
export function memberCardKey(member: MemberDetail): string | number {
  if (member.adjunctId !== undefined)
    return `adjunct-${member.adjunctId}`
  return member.userId ?? member.sid
}
