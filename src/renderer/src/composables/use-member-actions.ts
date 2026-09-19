/**
 * 关注 / 屏蔽的互斥规则：关注即解除屏蔽，屏蔽即取消关注。
 * 两个名单 store 互不引用（避免循环依赖），规则只能收在调用侧 ——
 * 成员页卡片与成员页 / 直播页 / 回放页三处详情抽屉共用这一份。
 * 状态取点击前的快照，避免被自己的写入影响；官网独有的补充成员没有 userId，直接忽略。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import { useBlockedMembersStore } from '@renderer/stores/blocked-members'
import { useFollowedMembersStore } from '@renderer/stores/followed-members'

export function useMemberActions() {
  const { isFollowed, toggleFollow, unfollowMember } = useFollowedMembersStore()
  const { isBlocked, toggleBlock, unblockMember } = useBlockedMembersStore()

  async function toggleFollowMember(member: MemberDetail) {
    const { userId } = member
    if (typeof userId !== 'number')
      return
    const willFollow = !isFollowed(userId)
    const blocked = isBlocked(userId)
    await toggleFollow({ ...member, userId })
    if (willFollow && blocked)
      await unblockMember(userId)
  }

  async function toggleBlockMember(member: MemberDetail) {
    const { userId } = member
    if (typeof userId !== 'number')
      return
    const willBlock = !isBlocked(userId)
    const followed = isFollowed(userId)
    await toggleBlock({ ...member, userId })
    if (willBlock && followed)
      await unfollowMember(userId)
  }

  return { isFollowed, isBlocked, toggleFollowMember, toggleBlockMember }
}
