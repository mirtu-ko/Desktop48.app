import type { MemberDetail } from '@renderer/utils/member-merge'

/**
 * 成员页不纳入的团体（连同其下属队伍与成员）。纯函数：无状态、无 IO，可脱离 Electron 单测。
 *
 * 这几个都不是 48 系正式队伍，而是公司分部 / 综艺企划 / 招募项目：
 * - 丝芭影视（groupId 20）：影视经纪分部，1 人
 * - Error404Girls（groupId 22）：企划组合，5 人（全为退团态）
 * - 燃烧吧团魂（groupId 80）：综艺企划队，25 人。注意它的 `periodName` 是简称「团魂」，
 *   而 `teamName` 才是全称「燃烧吧团魂」—— 两者都列进名称表，改哪边都拦得住
 * - 新星闪耀计划（groupId 81）：招募企划，4 人
 *
 * 混在成员页里会让「在团人数」「在团队伍数」「分团分布」这些口径失去意义；
 * 更明显的是这四条的 `periodName` 恰好都不带团体前缀（其余成员的期数一律是「SNH48 一期生」
 * 这种「团体 + 期数」写法），于是它们会顶在期数分布图的最前面，看着像正经期数。
 *
 * **判据同时给 id 与名称，任一命中即排除**：
 * - id 是 `groupInfo` 的主键，上游改显示名时仍能拦住；
 * - 名称是页面上真正显示的东西，上游改 id 时仍能拦住，也便于人工核对。
 * 名称比较前做归一化（去空白 + 转小写），容忍「Error404 Girls」这类书写差异。
 *
 * 注意：`allmembers.gid` 与 `groupInfo.groupId` 是两套编号（gid 20 是 BEJ48，不是丝芭影视），
 * 但官网补充成员在建 MemberDetail 时已经过 `GID_TO_GROUP_ID` 换算，所以这里按 groupId 比对是安全的。
 */
const EXCLUDED_GROUPS: Array<{ id: number, names: string[] }> = [
  { id: 20, names: ['丝芭影视'] },
  { id: 22, names: ['Error404Girls'] },
  { id: 80, names: ['燃烧吧团魂', '团魂'] },
  { id: 81, names: ['新星闪耀计划'] },
]

/** 被排除的团体数量：看板页头用它说明统计口径，不写死数字，列表改了文案自动跟上 */
export const EXCLUDED_GROUP_COUNT = EXCLUDED_GROUPS.length

/** 被排除团体的显示名（每个取首个名称）：给页头 tooltip 用，让人知道「不含」的到底是哪几个 */
export const EXCLUDED_GROUP_LABELS = EXCLUDED_GROUPS.map(item => item.names[0])

const EXCLUDED_GROUP_IDS = new Set(EXCLUDED_GROUPS.map(item => item.id))

/** 团体名归一化：去掉所有空白并转小写 */
function normalizeGroupName(name: string | undefined): string {
  return (name || '').replace(/\s+/g, '').toLowerCase()
}

const EXCLUDED_GROUP_NAMES = new Set(
  EXCLUDED_GROUPS.flatMap(item => item.names.map(normalizeGroupName)),
)

/** 该成员是否属于不纳入的团体（含其下属队伍与成员） */
export function isExcludedMember(member: MemberDetail): boolean {
  if (member.groupId !== undefined && EXCLUDED_GROUP_IDS.has(Number(member.groupId)))
    return true
  return EXCLUDED_GROUP_NAMES.has(normalizeGroupName(member.groupName))
}

/**
 * 滤掉不纳入的团体及其下属队伍 / 成员。
 * 在成员页的取数出口（`fetchMembers`）调用一次，列表、分区、计数、生日墙、
 * 数据看板就都自动不含它们了 —— 不要在每处消费点各过滤一遍。
 */
export function excludeMembers(members: MemberDetail[]): MemberDetail[] {
  return members.filter(member => !isExcludedMember(member))
}
