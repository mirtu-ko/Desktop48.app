import type { MemberDetail } from '@renderer/utils/member-merge'

/** 成员列表排序（纯函数，可脱离 Electron 单测）。分区顺序由 utils/member-list.ts 定，这里只管分区内部 */

/** 排序口径：默认（入团时间）/ 排名（总选名次）/ 姓名（拼音） */
export type SortKey = 'default' | 'rank' | 'name'

export interface SortOption {
  key: SortKey
  label: string
  /** 悬停提示：该口径的完整规则，含边界情况 */
  title: string
}

export const SORT_OPTIONS: SortOption[] = [
  { key: 'default', label: '默认', title: '按入团时间先后；兼任成员排在所属分区末尾' },
  { key: 'rank', label: '排名', title: '有总选排名的成员优先，按名次升序' },
  { key: 'name', label: '姓名', title: '按姓名拼音排序' },
]

/**
 * 入团时间排序键：兼容 2016-09-15 / 2016年9月15日 / 2016.9.5 / 20160915。
 * 必须逐段取数、不能剔掉非数字字符再拼（「2016-9-5」剔完是 201695，会排到 20160905 后面）。
 */
export function joinTimeKey(value: string | undefined): number {
  const raw = (value || '').trim()
  if (!raw)
    return Number.MAX_SAFE_INTEGER

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact)
    return Number(compact[1]) * 10000 + Number(compact[2]) * 100 + Number(compact[3])

  const separated = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  if (separated)
    return Number(separated[1]) * 10000 + Number(separated[2]) * 100 + Number(separated[3])

  // 只写了年份：按该年年初算，同年内排在具体日期之前
  const yearOnly = raw.match(/(\d{4})/)
  return yearOnly ? Number(yearOnly[1]) * 10000 : Number.MAX_SAFE_INTEGER
}

/** 入团时间缺失时的兜底键：官网成员 id（按登记先后递增） */
export function sidKey(member: MemberDetail): number {
  const sid = Number(member.sid)
  return Number.isFinite(sid) && sid > 0 ? sid : Number.MAX_SAFE_INTEGER
}

/** 按口径排序并返回副本（members 是响应式源，不可原地排） */
export function sortMembers(list: MemberDetail[], sortKey: SortKey): MemberDetail[] {
  if (sortKey === 'default') {
    // 入团早的在前；兼任记录（同一人在兼任队伍里的那张卡）统一沉到分区末尾
    return [...list].sort((a, b) => {
      const adjunctA = a.adjunctId === undefined ? 0 : 1
      const adjunctB = b.adjunctId === undefined ? 0 : 1
      if (adjunctA !== adjunctB)
        return adjunctA - adjunctB

      const timeA = joinTimeKey(a.joinTime)
      const timeB = joinTimeKey(b.joinTime)
      // 入团时间相同时才落到兜底键（相等则 0，交给稳定排序保住原顺序）
      return timeA === timeB ? sidKey(a) - sidKey(b) : timeA - timeB
    })
  }
  if (sortKey === 'rank') {
    // 名次小者在前；`rankB - rankA` 同时把「只有一方有名次」的情况归位（无排名恒为 0）
    return [...list].sort((a, b) => {
      const rankA = Number(a.ranking) || 0
      const rankB = Number(b.ranking) || 0
      return rankA && rankB ? rankA - rankB : rankB - rankA
    })
  }
  // zh-Hans-CN 即拼音序（Electron 自带完整 ICU）
  return [...list].sort((a, b) => (a.realName || '').localeCompare(b.realName || '', 'zh-Hans-CN'))
}
