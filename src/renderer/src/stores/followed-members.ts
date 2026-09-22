/**
 * 关注名单（与 blocked-members.ts 同构）：状态定义在模块作用域，成员页与直播 / 回放列表页
 * 读写同一份，页面被 keep-alive 缓存时靠它跨页同步。
 */
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'

/** 被关注成员：主进程从 starInfo 中按 userId 挑出的成员对象 */
export interface FollowedMember {
  userId: number
  realName: string
  teamColor: string
  [key: string]: any
}

/** 关注操作的最小入参（成员卡片 / 详情抽屉传入完整对象即可）；userId 兼容字符串形式 */
interface FollowTarget {
  userId: number | string
  realName: string
  [key: string]: any
}

const followedMembers = ref<FollowedMember[]>([])

/** 判存走 Set：isFollowed 在 v-for 与排序比较器里被逐条调用，避免线性扫名单 */
const followedIdSet = computed(() => new Set(followedMembers.value.map(member => Number(member.userId))))

/** 关注名单的单一数据源：读取、判断、关注 / 取关都在此统一处理（落库走 window.mainAPI → database.json） */
export function useFollowedMembersStore() {
  /** 从主进程拉取最新名单（页面挂载时调用） */
  async function refreshFollowedMembers() {
    followedMembers.value = (await window.mainAPI.getFollowedMembers()) || []
  }

  /** 是否已关注：入参兼容 number / string / undefined，调用方不必自己归一化 */
  function isFollowed(userId: number | string | undefined | null) {
    const id = Tools.normalizeUserId(userId)
    return Number.isFinite(id) && followedIdSet.value.has(id)
  }

  /** 关注 / 取消关注（成员卡片与详情抽屉共用，带消息反馈） */
  async function toggleFollow(member: FollowTarget) {
    const userId = Tools.normalizeUserId(member.userId)
    if (!Number.isFinite(userId)) {
      ElMessage.error('该成员缺少有效的 userId，无法关注')
      return
    }
    try {
      if (isFollowed(userId)) {
        await window.mainAPI.removeFollowedMember(userId)
        followedMembers.value = followedMembers.value.filter(item => Number(item.userId) !== userId)
        ElMessage({ message: `已取消关注 ${member.realName}`, type: 'success' })
      }
      else {
        await window.mainAPI.addFollowedMember(userId)
        followedMembers.value = [...followedMembers.value, { ...member, userId, teamColor: member.teamColor || '' }]
        ElMessage({ message: `已关注 ${member.realName}，其直播将优先展示`, type: 'success' })
      }
    }
    catch (error) {
      // 落库失败时界面名单不会变，必须给反馈，否则用户以为点漏了
      console.error('更新关注状态失败:', error)
      ElMessage.error('关注操作失败，请稍后重试')
    }
  }

  /** 取消单个关注（静默，供关注 / 屏蔽互斥联动使用） */
  async function unfollowMember(userId: number | string) {
    const id = Tools.normalizeUserId(userId)
    if (!Number.isFinite(id))
      return
    try {
      await window.mainAPI.removeFollowedMember(id)
      followedMembers.value = followedMembers.value.filter(item => Number(item.userId) !== id)
    }
    catch (error) {
      console.error('取消关注失败:', error)
    }
  }

  return { followedMembers, refreshFollowedMembers, isFollowed, toggleFollow, unfollowMember }
}
