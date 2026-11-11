/**
 * 关注名单 → 展示条目（昵称 / 头像 / 队色 / 在团状态）。
 *
 * 关注名单本身只持久化 userId（见 common/member-flags），头像与队色要经成员名录反查；
 * 名单里混着的官方号（袋王 / 各团官方号）不在成员名录里，回退 officialInfo ——
 * 与房间页左列同一口径（见 composables/use-pocket-rooms.ts）。
 *
 * 反查失败时按名单里的 realName 兜底：宁可少一张头像，也不要整条消失。
 */
import type { MemberFlag } from '@common/member-flags'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import Constants from '@renderer/utils/constants'
import { isHonoraryMember } from '@renderer/utils/member-stats'
import Tools from '@renderer/utils/tools'
import { ref, watch } from 'vue'

export interface FollowedMemberEntry {
  /** 归一化为字符串：筛选参数与级联路径都按字符串比对 */
  userId: string
  name: string
  avatar: string
  /** 队色（带 # 的 CSS 颜色），空串表示无队色 */
  color: string
  /**
   * 现役在团：有房间、能出回放的那批。快速筛选条默认只展示它们，
   * 暂休 / 退团 / 荣誉毕业生收在折叠区（判据同成员页「在团」口径）。
   */
  active: boolean
  /** 非现役时的状态文案（暂休 / 退团 / 荣誉毕业生），用于折叠区的悬浮说明 */
  statusLabel: string
}

/**
 * 跟随关注名单派生的展示条目。
 *
 * 名单加载由消费方负责（回放页挂载时调 refreshFollowedMembers）；
 * 这里只跟随名单变化重算，关注 / 取关后头像条自动增删。
 */
export function useFollowedMemberEntries() {
  const { followedMembers } = useFollowedMembersStore()
  const { findMemberByUserId, findOfficialAccount } = useMemberDirectoryStore()

  const entries = ref<FollowedMemberEntry[]>([])
  /** 反查序号：名单连续变化时只认最后一次结果，避免旧结果后到覆盖新结果 */
  let seq = 0

  async function resolveEntry(item: MemberFlag): Promise<FollowedMemberEntry> {
    const userId = String(item.userId)
    const member = await findMemberByUserId(item.userId).catch(() => null)
    const official = member ? null : await findOfficialAccount(item.userId).catch(() => null)
    const honorary = member ? isHonoraryMember(member) : false
    return {
      userId,
      name: member?.realName || member?.nickname || official?.name || item.realName || `口袋用户 ${userId}`,
      avatar: member?.avatar || official?.avatar || '',
      color: Tools.toHex(member?.ringColor || member?.teamColor || item.teamColor),
      // 名录查不到（官方号 / 反查失败）按在役处理：宁可多显示一条，
      // 也不要因为一次失败的请求把用户关注的人悄悄藏进折叠区
      active: !member || (!honorary && member.status === Constants.MemberStatus.Active),
      statusLabel: !member
        ? ''
        : honorary
          ? '荣誉毕业生'
          : Constants.MemberStatusMeta[member.status]?.label || '',
    }
  }

  watch(followedMembers, async (list) => {
    const current = ++seq
    const resolved = await Promise.all(list.map(item => resolveEntry(item)))
    if (current === seq)
      entries.value = resolved
  }, { immediate: true })

  return { entries }
}

export default useFollowedMemberEntries
