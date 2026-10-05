/**
 * 总选页的纯函数：名次分段、团体徽章色、头像地址、票数与日期的展示格式。
 * 不引 Vue / Element Plus，可脱离 Electron 直接单测。
 */
import type { ElectionMember } from '@renderer/data/elections'
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

const CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']

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

/** 届数的中文写法：1 → 第一届，10 → 第十届，11 → 第十一届；超出 1-99 返回空串 */
export function ordinalLabel(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99)
    return ''
  const tens = Math.floor(ordinal / 10)
  const ones = ordinal % 10
  const text = ordinal < 10
    ? CN_DIGITS[ordinal]
    : `${tens > 1 ? CN_DIGITS[tens] : ''}十${ones ? CN_DIGITS[ones] : ''}`
  return `第${text}届`
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
