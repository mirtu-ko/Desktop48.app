import type { MemberSection } from '@renderer/utils/member-list'
import type { MemberDetail } from '@renderer/utils/member-merge'
import type { SortKey } from '@renderer/utils/member-sort'
import type { Ref } from 'vue'
import Constants from '@renderer/utils/constants'
import { buildSections, memberMatches } from '@renderer/utils/member-list'
import { sortMembers } from '@renderer/utils/member-sort'
import { normalizeKeyword } from '@renderer/utils/text-highlight'
import { computed } from 'vue'

/**
 * 成员页的分区派生：按 tab 过滤 → 按关键词过滤 → 分组 → 分区内排序 → 计数。
 * 规则全部来自 utils/member-list.ts 与 utils/member-sort.ts，这里只把它们串成响应式链路。
 */

export interface UseMemberSectionsOptions {
  /** 合并后的全量成员（未过滤），见 utils/member-merge.ts */
  members: Ref<MemberDetail[]>
  /** 当前分团 tab 的 key：groupId 字符串，或成员库的 'library' */
  activeKey: Ref<string>
  /** 是否处于「成员库」tab（全部分团汇总 + 暂休 / 退团分区） */
  isLibrary: Ref<boolean>
  /** 搜索框原始输入（组件内自行归一化，调用方不必预处理） */
  keyword: Ref<string>
  /** 当前排序口径 */
  sortKey: Ref<SortKey>
}

export function useMemberSections(options: UseMemberSectionsOptions) {
  const { members, activeKey, isLibrary, keyword, sortKey } = options

  /** 归一化关键词：模板用它判断「是否处于搜索中」，切片段落另见 utils/text-highlight.ts */
  const normalizedKeyword = computed(() => normalizeKeyword(keyword.value))

  const sections = computed<MemberSection[]>(() => {
    const scope = members.value.filter(member =>
      (isLibrary.value || String(member.groupId) === activeKey.value)
      && memberMatches(member, keyword.value),
    )
    const active = buildSections(
      scope.filter(member => member.status === Constants.MemberStatus.Active),
      isLibrary.value,
      sortKey.value,
    )
    if (!isLibrary.value)
      return active

    // 暂休 / 退团：没有队伍色，各自成一块中性灰分区，排在在团队伍之后
    const inactiveSections = (status: number, title: string): MemberSection[] => {
      const list = sortMembers(scope.filter(member => member.status === status), sortKey.value)
      return list.length
        ? [{ key: title, title, teamBadge: '', groupLogo: Constants.GroupLogoFallback, muted: true, members: list }]
        : []
    }
    return [
      ...active,
      ...inactiveSections(Constants.MemberStatus.Hiatus, '暂休'),
      ...inactiveSections(Constants.MemberStatus.Left, '退团'),
    ]
  })

  /** 在团人数（分团 tab 只有这个值有意义） */
  const activeCount = computed(() =>
    sections.value.filter(section => !section.muted).reduce((sum, section) => sum + section.members.length, 0),
  )

  /** 暂休 + 退团人数（分团 tab 恒为 0） */
  const inactiveCount = computed(() =>
    sections.value.filter(section => section.muted).reduce((sum, section) => sum + section.members.length, 0),
  )

  const memberCount = computed(() => activeCount.value + inactiveCount.value)

  return { normalizedKeyword, sections, activeCount, inactiveCount, memberCount }
}
