import Apis from '@renderer/services/apis'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

/**
 * 成员数据库同步的单一入口（App 根组件与 Members 页共用，避免各写一遍 syncInfo）：
 * - App.vue 初始化通过后调 ensureMembers()：库里没有成员时静默补一次初始同步
 * - Members.vue 的「更新成员数据库」走 syncMembers()：带 loading 态与成功提示
 */
export function useMemberSync() {
  /** 是否正在同步（成员页浮动刷新按钮的 loading 态） */
  const isSyncing = ref(false)

  /** 拉取并落库最新成员名单（Apis.syncInfo 的薄封装，成功返回 true） */
  async function syncInfo(): Promise<boolean> {
    try {
      await Apis.instance().syncInfo()
      return true
    }
    catch (error) {
      console.error('更新成员数据库失败:', error)
      return false
    }
  }

  /**
   * 启动兜底：数据库没有任何成员时自动同步一次（首次安装 / 空库场景），静默无提示
   */
  async function ensureMembers() {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    if (await window.mainAPI.hasMembers?.()) {
      return
    }
    await syncInfo()
  }

  /**
   * 手动更新成员数据库（成员页浮动刷新按钮）：带 loading 态防重入 + 成功提示。
   * 返回是否同步成功，调用方据此决定是否刷新自己的成员视图
   */
  async function syncMembers(): Promise<boolean> {
    if (isSyncing.value) {
      return false
    }
    isSyncing.value = true
    try {
      const ok = await syncInfo()
      if (ok) {
        ElMessage({ message: '更新完毕！注意不要频繁更新～', type: 'success' })
      }
      return ok
    }
    finally {
      isSyncing.value = false
    }
  }

  return { isSyncing, ensureMembers, syncMembers }
}
