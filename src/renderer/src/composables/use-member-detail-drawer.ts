/**
 * 页面级成员详情抽屉：列表点成员名 → 按 userId 从 stores/member-directory 反查合并详情并打开抽屉。
 * 关注 / 屏蔽的互斥规则见 use-member-actions。状态每页各持一份（抽屉不跨页共享），故落在 composables。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'
import { useMemberActions } from './use-member-actions'

export function useMemberDetailDrawer() {
  const { findMemberByUserId } = useMemberDirectoryStore()
  const { isFollowed, isBlocked, toggleFollowMember, toggleBlockMember } = useMemberActions()

  /** 当前查看详情的成员（null = 抽屉关闭） */
  const selectedMember = ref<MemberDetail | null>(null)

  /** 抽屉里的关注 / 屏蔽态：跟着当前成员走，打开抽屉本身不改名单 */
  const drawerFollowed = computed(() => !!selectedMember.value?.userId && isFollowed(selectedMember.value.userId))
  const drawerBlocked = computed(() => !!selectedMember.value?.userId && isBlocked(selectedMember.value.userId))

  /** 打开抽屉：入参是列表条目上的 userId（number / string 都收，归一化在 store） */
  async function openMemberDetail(userId: number | string | undefined | null) {
    let member: MemberDetail | null = null
    try {
      member = await findMemberByUserId(userId)
    }
    catch (error) {
      console.error('[use-member-detail-drawer]成员详情查询失败:', error)
      ElMessage.error('成员详情加载失败，请稍后重试')
      return
    }
    // 名录里没这个人（成员库未同步 / 官网独有的成员）：不静默失败，否则像点了没反应
    if (!member) {
      ElMessage.warning('未找到该成员的详情，可在成员页更新成员数据库')
      return
    }
    selectedMember.value = member
  }

  function closeMemberDetail() {
    selectedMember.value = null
  }

  return {
    selectedMember,
    drawerFollowed,
    drawerBlocked,
    openMemberDetail,
    closeMemberDetail,
    toggleFollowMember,
    toggleBlockMember,
  }
}
