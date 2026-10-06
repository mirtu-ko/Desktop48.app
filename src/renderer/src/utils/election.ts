/**
 * 总选页的纯函数：名次分段、团体徽章色、头像地址、票数与日期的展示格式、名次变动与成员历届履历。
 * 不引 Vue / Element Plus，可脱离 Electron 直接单测。
 */
import type { Election, ElectionMember } from '@renderer/data/elections'
import Constants from '@renderer/utils/constants'
import dayjs from 'dayjs'

/** 入选分组（官网口径） */
export interface ElectionSection {
  /** 分组名 */
  title: string
  /** 名次段文案 */
  range: string
  /** 组内成员，按名次升序 */
  members: ElectionMember[]
}

/** 名次分段规则，按上界升序；某段没有成员时不产出（第 1、2 届只有前两段） */
const SECTION_RULES: Array<{ title: string, range: string, upTo: number }> = [
  { title: '星光组', range: 'TOP16', upTo: 16 },
  { title: '高飞组', range: 'TOP32', upTo: 32 },
  { title: '梦想组', range: 'TOP48', upTo: 48 },
  { title: '未来组', range: 'TOP66', upTo: 66 },
]

/** 已解散 / 非现役团体的徽章色；现役五团一律取 Constants.GroupTabs，不在这里另存一份 */
const HISTORIC_GROUP_COLORS: Record<string, string> = {
  SHY48: '#5b8def',
  IDFT: '#9b8ec4',
}

/** 官网头像地址前缀：与成员库同一条命名规则（zp_<sid>.jpg） */
const AVATAR_PREFIX = 'https://www.snh48.com/images/member/zp_'

/** 按名次段切分入选名单，空段不产出 */
export function buildSections(members: ElectionMember[]): ElectionSection[] {
  const sections: ElectionSection[] = []
  let from = 0
  for (const rule of SECTION_RULES) {
    const chunk = members.filter(member => member.rank > from && member.rank <= rule.upTo)
    from = rule.upTo
    if (chunk.length)
      sections.push({ title: rule.title, range: rule.range, members: chunk })
  }
  return sections
}

/** 团体徽章色；查不到的团体返回空串，由调用方的中性灰兜底 */
export function groupColor(group: string): string {
  return Constants.GroupTabs.find(tab => tab.label === group)?.color
    ?? HISTORIC_GROUP_COLORS[group]
    ?? ''
}

/** 官网头像地址；官网已下架、查不到 sid 的老成员返回空串 */
export function avatarUrl(sid?: string): string {
  return sid ? `${AVATAR_PREFIX}${sid}.jpg` : ''
}

/** 前三名的奖牌色：色值只留变量引用，具体色在 app.scss 的 --medal 变量组 */
const MEDAL_COLORS: Record<number, string> = {
  1: 'var(--medal-gold)',
  2: 'var(--medal-silver)',
  3: 'var(--medal-bronze)',
}

/** 名次的奖牌色；前三名之外返回 undefined，由调用方兜底 */
export function medalColor(rank: number): string | undefined {
  return MEDAL_COLORS[rank]
}

/** 票数千分位展示，保留官方公布的小数位（如 230752.7） */
export function formatVotes(votes: number): string {
  if (!Number.isFinite(votes))
    return ''
  const [int, decimal] = votes.toString().split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return decimal ? `${grouped}.${decimal}` : grouped
}

/** 结果公布日期：YYYY-MM-DD → YYYY.MM.DD；无法解析时原样返回 */
export function formatElectionDate(date: string): string {
  const parsed = dayjs(date)
  return parsed.isValid() ? parsed.format('YYYY.MM.DD') : date
}

/** 名次所属分组名（星光 / 高飞 / 梦想 / 未来组）；超出分段规则返回空串 */
export function sectionTitleOf(rank: number): string {
  return SECTION_RULES.find(rule => rank <= rule.upTo)?.title ?? ''
}

/**
 * 与上一届总选排名相比的名次变动：
 * - up / down：上届也入选，delta 为上升 / 下降的名次数（正数）
 * - same：名次持平
 * - new：此前从未入选（首次入选）
 * - return：曾经入选，但上一届落选
 */
export type RankChange
  = | { kind: 'up' | 'down', delta: number }
    | { kind: 'same' | 'new' | 'return' }

/**
 * 计算某成员在某届的名次变动。
 * elections 须按届数升序；首届没有可比较的上一届，返回 undefined（避免整页都是 NEW 的噪音）。
 */
export function rankChange(
  userId: number,
  rank: number,
  ordinal: number,
  elections: Election[],
): RankChange | undefined {
  const index = elections.findIndex(item => item.ordinal === ordinal)
  if (index <= 0)
    return undefined

  const previous = elections[index - 1].members.find(member => member.userId === userId)
  if (previous) {
    const delta = previous.rank - rank
    if (delta > 0)
      return { kind: 'up', delta }
    if (delta < 0)
      return { kind: 'down', delta: -delta }
    return { kind: 'same' }
  }

  const everRanked = elections
    .slice(0, index - 1)
    .some(item => item.members.some(member => member.userId === userId))
  return { kind: everRanked ? 'return' : 'new' }
}

/** 名次变动的短文案：▲5 / ▼3 / — / NEW / 回归 */
export function formatRankChange(change: RankChange): string {
  switch (change.kind) {
    case 'up':
      return `▲${change.delta}`
    case 'down':
      return `▼${change.delta}`
    case 'same':
      return '—'
    case 'new':
      return 'NEW'
    case 'return':
      return '回归'
  }
}

/** 成员在某一届的总选履历；未入选的届次 rank 为空，供走势图断线 */
export interface ElectionHistoryEntry {
  ordinal: number
  year: number
  theme: string
  /** 总选名次（未入选为 undefined） */
  rank?: number
  /** 当届票数（未公布或未入选为 undefined） */
  votes?: number
  /** 当届所属团体（未入选时取新人榜里的团体，都没有则 undefined） */
  group?: string
  /** 新人榜名次（未上新人榜为 undefined） */
  newcomerRank?: number
  /** 与上一届相比的名次变动（仅入选的届次） */
  change?: RankChange
}

/** 某成员（按 userId）在全部届次的履历，按届数升序，每届一条 */
export function memberHistory(userId: number, elections: Election[]): ElectionHistoryEntry[] {
  return elections.map((election) => {
    const member = election.members.find(item => item.userId === userId)
    const newcomer = election.newcomers.find(item => item.userId === userId)
    return {
      ordinal: election.ordinal,
      year: election.year,
      theme: election.theme,
      rank: member?.rank,
      votes: member?.votes,
      group: member?.group ?? newcomer?.group,
      newcomerRank: newcomer?.rank,
      change: member ? rankChange(userId, member.rank, election.ordinal, elections) : undefined,
    }
  })
}
