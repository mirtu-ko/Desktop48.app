/**
 * ⚠️ 屏蔽 / 关注名单的共享实现。
 *
 * 两类名单的状态结构、增删流程和持久化语义一致，只差 kind 与用户提示；
 * 因此共用一个模块级工厂，下面仅保留面向调用方的语义化别名。
 */
import type { MemberFlag, MemberFlagKind, MemberFlagTarget } from '../../../common/member-flags'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'

interface MemberFlagMessages {
  invalidId: string
  added: (_realName: string) => string
  removed: (_realName: string) => string
  failure: string
  updateError: string
  cleared?: string
}

const messages: Record<MemberFlagKind, MemberFlagMessages> = {
  blocked: {
    invalidId: '该成员缺少有效的 userId，无法屏蔽',
    added: realName => `已屏蔽 ${realName}，其直播与回放将不再展示`,
    removed: realName => `已解除屏蔽 ${realName}`,
    failure: '屏蔽操作失败，请稍后重试',
    updateError: '更新屏蔽状态失败:',
    cleared: '已清空屏蔽名单',
  },
  followed: {
    invalidId: '该成员缺少有效的 userId，无法关注',
    added: realName => `已关注 ${realName}，其直播将优先展示`,
    removed: realName => `已取消关注 ${realName}`,
    failure: '关注操作失败，请稍后重试',
    updateError: '更新关注状态失败:',
  },
}

function createMemberFlagStore(kind: MemberFlagKind) {
  const message = messages[kind]
  const members = ref<MemberFlag[]>([])
  const idSet = computed(() => new Set(members.value.map(member => Number(member.userId))))

  /** 是否已成功加载过名单：空名单也是有效状态，不该被当成"未加载"反复重拉 */
  let loaded = false
  /** 进行中的首灌请求：并发调用方共用同一个 promise，只发一次 IPC */
  let inflight: Promise<void> | null = null

  function createEntry(target: MemberFlagTarget, userId: number): MemberFlag {
    return { ...target, userId, teamColor: target.teamColor || '' }
  }

  async function refresh() {
    try {
      members.value = (await window.mainAPI.getMemberFlags(kind)) || []
      loaded = true
    }
    catch (error) {
      console.error(message.updateError, error)
      ElMessage.error(message.failure)
    }
  }

  /**
   * 幂等首灌：保证名单至少加载过一次。
   *
   * store 是模块级单例，一旦有消费方直接读 `has`（如列表过滤）而不先 refresh，
   * 拿到的就是初始空名单 —— 过滤会静默失效。把保证放在这里，消费方无需记得先拉一次。
   * 失败的 refresh 不置位，下次调用仍会重试。
   */
  function ensureLoaded(): Promise<void> {
    if (loaded)
      return Promise.resolve()
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  function has(userId: number | string | undefined | null) {
    const id = Tools.normalizeUserId(userId)
    return Number.isFinite(id) && idSet.value.has(id)
  }

  async function toggle(target: MemberFlagTarget) {
    const userId = Tools.normalizeUserId(target.userId)
    if (!Number.isFinite(userId)) {
      ElMessage.error(message.invalidId)
      return
    }

    try {
      if (has(userId)) {
        await window.mainAPI.removeMemberFlag(kind, userId)
        members.value = members.value.filter(member => Number(member.userId) !== userId)
        ElMessage({ message: message.removed(target.realName), type: 'success' })
      }
      else {
        await window.mainAPI.addMemberFlag(kind, userId)
        members.value = [...members.value, createEntry(target, userId)]
        ElMessage({ message: message.added(target.realName), type: 'success' })
      }
    }
    catch (error) {
      console.error(message.updateError, error)
      ElMessage.error(message.failure)
    }
  }

  async function remove(userId: number | string) {
    const id = Tools.normalizeUserId(userId)
    if (!Number.isFinite(id))
      return
    try {
      await window.mainAPI.removeMemberFlag(kind, id)
      members.value = members.value.filter(member => Number(member.userId) !== id)
    }
    catch (error) {
      console.error(message.updateError, error)
    }
  }

  async function clear() {
    try {
      await window.mainAPI.setMemberFlags(kind, [])
      members.value = []
      if (message.cleared)
        ElMessage({ message: message.cleared, type: 'success' })
    }
    catch (error) {
      console.error(message.updateError, error)
      ElMessage.error(message.failure)
    }
  }

  return { members, refresh, ensureLoaded, has, toggle, remove, clear }
}

const blocked = createMemberFlagStore('blocked')
const followed = createMemberFlagStore('followed')

export function useBlockedMembersStore() {
  return {
    blockedMembers: blocked.members,
    refreshBlockedMembers: blocked.refresh,
    /** 过滤前调用：保证名单已加载（幂等，之后翻页零额外 IPC） */
    ensureBlockedLoaded: blocked.ensureLoaded,
    isBlocked: blocked.has,
    toggleBlock: blocked.toggle,
    unblockMember: blocked.remove,
    clearBlockedMembers: blocked.clear,
  }
}

export function useFollowedMembersStore() {
  return {
    followedMembers: followed.members,
    refreshFollowedMembers: followed.refresh,
    /** 过滤前调用：同 blocked，保证名单已加载（幂等） */
    ensureFollowedLoaded: followed.ensureLoaded,
    isFollowed: followed.has,
    toggleFollow: followed.toggle,
    unfollowMember: followed.remove,
  }
}
