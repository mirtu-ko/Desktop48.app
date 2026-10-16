/**
 * 关注 / 屏蔽的语义分层，以及两者的唯一接线点。
 *
 * - **关注**是账号维度的事实：登录态下与口袋双向——本地 toggle 双写口袋，
 *   启动 / 手动同步把账号关注并集合入本地（见 composables/use-pocket-follow.ts）；
 * - **屏蔽**是本地可见性偏好：在桌面端隐藏该成员的直播、回放与房间条目，不计未读。
 *   它不写账号，也不改动关注名单。
 *
 * 两者正交、互不改写。早先「屏蔽即取消关注」的规则诞生于两个名单同处本地一个平面的年代；
 * 关注搬到账号维度之后它不再自洽——本地单方面取关挡不住下一次并集合入把成员加回来
 * （mergeFromPocket 只增不删），而真正的账号取关又是用户没点过的操作。
 * 屏蔽的效力改由展示层保证（**屏蔽优先**）：已屏蔽成员不展示关注态、不进列表、不计未读。
 * 唯一保留的互斥方向是用户主动点「关注」时解除屏蔽——那是在表达「我要看 TA」。
 *
 * 两个名单 store 互不引用（避免循环依赖），规则只能收在调用侧 ——
 * 成员页卡片与成员页 / 直播页 / 回放页三处详情抽屉共用这一份。
 * 状态取点击前的快照，避免被自己的写入影响；官网独有的补充成员没有 userId，直接忽略。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'

export function useMemberActions() {
  const { isFollowed, toggleFollow } = useFollowedMembersStore()
  const { isBlocked, toggleBlock, unblockMember } = useBlockedMembersStore()

  async function toggleFollowMember(member: MemberDetail) {
    const { userId } = member
    if (typeof userId !== 'number')
      return
    // 屏蔽优先：已屏蔽时按钮展示为「未关注」（见 MemberCard / MemberDetailCard），
    // 因此这一次点击表达的是「关注 TA」——先解除屏蔽。关注名单与屏蔽正交，原样保留。
    const blocked = isBlocked(userId)
    const followed = isFollowed(userId)
    const willFollow = blocked || !followed
    if (blocked)
      await unblockMember(userId)
    // 本次只是解除屏蔽、关注态不变（账号侧本来就关注着）：无需动名单，也不必双写
    if (willFollow === followed)
      return
    await toggleFollow({ ...member, userId })
    // 双写口袋关注：登录态现读现刷新（本地读文件无网络）：ensurePocketAuthState 首调会同步返回
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
    // 屏蔽只动屏蔽名单：关注是账号维度的事实，取关不由屏蔽代劳（见文件头）
    await toggleBlock({ ...member, userId })
  }

  return { isFollowed, isBlocked, toggleFollowMember, toggleBlockMember }
}
