/**
 * ⚠️ 全局单例 store（原 composables/data/use-blocked-members.ts）
 *
 * 屏蔽名单定义在模块作用域，**不随任何组件卸载而销毁**：
 * 成员页与设置页调用 useBlockedMembersStore() 读写的是同一份名单，跨页自动同步。
 */
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

/** 被屏蔽成员：主进程从 starInfo 中按 userId 挑出的成员对象 */
export interface BlockedMember {
  userId: number
  realName: string
  teamColor: string
  [key: string]: any
}

/** 屏蔽操作的最小入参（成员卡片 / 详情抽屉传入完整对象即可） */
interface BlockTarget {
  userId: number
  realName: string
  [key: string]: any
}

/** 模块级共享状态：成员页与设置页读写同一份名单，跨页切换自动同步 */
const blockedMembers = ref<BlockedMember[]>([])

/**
 * 屏蔽名单的单一数据源：读取、判断、屏蔽 / 解除 / 清空都在这里收口。
 *
 * ★ 跨进程：本文件所有 window.mainAPI.*BlockedMember* 调用经 preload/index.ts
 * 转到 main/ipc/register-database-ipc.ts，名单落盘在 database.json。
 */
export function useBlockedMembersStore() {
  /** 从主进程拉取最新名单（页面挂载时调用） */
  async function refreshBlockedMembers() {
    blockedMembers.value = (await window.mainAPI.getBlockedMembers()) || []
  }

  function isBlocked(userId: number) {
    return blockedMembers.value.some(member => Number(member.userId) === Number(userId))
  }

  /** 屏蔽 / 解除屏蔽（成员页卡片与详情抽屉共用，带消息反馈） */
  async function toggleBlock(member: BlockTarget) {
    const userId = Number(member.userId)
    try {
      if (isBlocked(userId)) {
        await window.mainAPI.removeBlockedMember(userId)
        blockedMembers.value = blockedMembers.value.filter(item => Number(item.userId) !== userId)
        ElMessage({ message: `已解除屏蔽 ${member.realName}`, type: 'success' })
      }
      else {
        await window.mainAPI.addBlockedMember(userId)
        const entry: BlockedMember = { ...member, userId, teamColor: member.teamColor || '' }
        blockedMembers.value = [...blockedMembers.value, entry]
        ElMessage({ message: `已屏蔽 ${member.realName}，其直播与回放将不再展示`, type: 'success' })
      }
    }
    catch (error) {
      console.error('更新屏蔽状态失败:', error)
    }
  }

  /** 解除单个屏蔽（设置页名单 tag 的 ×，静默） */
  async function unblockMember(userId: number) {
    await window.mainAPI.removeBlockedMember(userId)
    blockedMembers.value = blockedMembers.value.filter(item => Number(item.userId) !== Number(userId))
  }

  /** 清空名单（确认弹窗由调用方负责） */
  async function clearBlockedMembers() {
    await window.mainAPI.setBlockedMembers([])
    blockedMembers.value = []
    ElMessage({ message: '已清空屏蔽名单', type: 'success' })
  }

  return {
    blockedMembers,
    refreshBlockedMembers,
    isBlocked,
    toggleBlock,
    unblockMember,
    clearBlockedMembers,
  }
}
