/**
 * 关注 / 屏蔽的互斥规则：关注即解除屏蔽，屏蔽即取消关注。
 * 两个名单 store 互不引用（避免循环依赖），规则只能收在调用侧 ——
 * 成员页卡片与成员页 / 直播页 / 回放页三处详情抽屉共用这一份。
 * 状态取点击前的快照，避免被自己的写入影响；官网独有的补充成员没有 userId，直接忽略。
 *
 * 关注同时双写口袋（登录态可用时）：桌面端与账号维度的关注保持单向趋同，
 * 服务端失败静默降级——本地操作已生效，同步状态由设置页同步入口呈现。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'

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
    // 双写口袋关注：屏蔽互斥只在本地生效，服务端无对应概念，不随动。
    // 登录态现读现刷新（本地读文件无网络）：ensurePocketAuthState 首调会同步返回
    // 刷新前的旧值，没打开过设置页就点关注的场景会静默丢双写
    const auth = await refreshPocketAuthState()
    if (auth.loggedIn) {
      void (willFollow
        ? window.mainAPI.pocketFollowMember(userId)
        : window.mainAPI.pocketUnfollowMember(userId)
      ).catch((error) => {
        debugLog('pocket-follow', `双写${willFollow ? '关注' : '取关'}失败`, userId, error)
      })
    }
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
