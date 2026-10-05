import type { MemberDetail } from '@renderer/utils/member-merge'

/**
 * 成员列表排序（纯函数：无状态、无 IO，可脱离 Electron 直接单测）。
 *
 * 三种口径共用一份定义：页面从 SORT_OPTIONS 渲染切换器、把选中的 SortKey 交给
 * sortMembers，测试也直接调 sortMembers —— 排序规则只有这一处实现，
 * UI 文案与排序行为不会各改各的。
 *
 * 排序只作用于「分区内部」：分区本身的顺序由 utils/member-list.ts 的
 * buildSections 在未排序的列表上定死，与这里选哪个口径无关。
 */

/** 排序口径：默认（入团时间）/ 排名（总选名次）/ 姓名（拼音） */
export type SortKey = 'default' | 'rank' | 'name'

export interface SortOption {
  key: SortKey
  label: string
  /** 悬停提示：说明该口径的完整规则，含边界情况 */
  title: string
}

export const SORT_OPTIONS: SortOption[] = [
  { key: 'default', label: '默认', title: '按入团时间先后；兼任成员排在所属分区末尾' },
  { key: 'rank', label: '排名', title: '有总选排名的成员优先，按名次升序' },
  { key: 'name', label: '姓名', title: '按姓名拼音排序' },
]

/**
 * 入团时间排序键：兼容 2016-09-15 / 2016年9月15日 / 2016.9.5 / 20160915 等写法。
 * 逐段取数而不是把非数字字符剔掉再拼 —— 「2016-9-5」剔完是 201695，
 * 会排到 20160905 后面去，月日不补零的写法必须按数值分段还原。
 * 解析不出年份的（空值 / 脏数据）返回最大整数，统一沉到分区末尾。
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

/** 入团时间缺失时的兜底键：官网成员 id（按登记先后递增），总好过退回「随机感」的树顺序 */
export function sidKey(member: MemberDetail): number {
  const sid = Number(member.sid)
  return Number.isFinite(sid) && sid > 0 ? sid : Number.MAX_SAFE_INTEGER
}

/**
 * 按口径排序并返回副本：原数组不可原地排（members 是响应式源，就地排会污染其它消费者）。
 */
export function sortMembers(list: MemberDetail[], sortKey: SortKey): MemberDetail[] {
  if (sortKey === 'default') {
    // 默认：入团早的在前；兼任记录（同一人在兼任队伍里的那张卡）统一沉到分区末尾
    return [...list].sort((a, b) => {
      const adjunctA = a.adjunctId === undefined ? 0 : 1
      const adjunctB = b.adjunctId === undefined ? 0 : 1
      if (adjunctA !== adjunctB)
        return adjunctA - adjunctB

      const timeA = joinTimeKey(a.joinTime)
      const timeB = joinTimeKey(b.joinTime)
      // 两边都没有入团时间时才落到兜底键（相等则 0，交给稳定排序保住原顺序）
      return timeA === timeB ? sidKey(a) - sidKey(b) : timeA - timeB
    })
  }
  if (sortKey === 'rank') {
    // 名次小者在前；`rankB - rankA` 恰好把「只有一方有名次」的情况也归位（无排名恒为 0）
    return [...list].sort((a, b) => {
      const rankA = Number(a.ranking) || 0
      const rankB = Number(b.ranking) || 0
      return rankA && rankB ? rankA - rankB : rankB - rankA
    })
  }
  // zh-Hans-CN 排序规则在 Chromium 里即拼音序（Electron 自带完整 ICU）
  return [...list].sort((a, b) => (a.realName || '').localeCompare(b.realName || '', 'zh-Hans-CN'))
}
