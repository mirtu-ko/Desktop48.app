/**
 * 口袋关注同步（策略 A：并集合入 + 桌面端双写）。
 *
 * 同步方向：
 * - 拉取：登录后 / 启动时 / 手动触发，把账号维度的关注 ID 合并进本地名单（只增不删，
 *   合并原语在 stores/member-flags 的 mergeFromPocket）；
 * - 双写：桌面端 toggle 关注时同步 add/remove 到口袋（见 use-member-actions.ts）。
 *
 * 失败一律静默降级：关注同步失败不该以任何形式打扰用户，状态由设置页的同步入口呈现。
 */
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { ensurePocketAuthState, pocketAuthErrorMessage } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'
import { ref } from 'vue'

export function usePocketFollowSync() {
  const { mergeFromPocket } = useFollowedMembersStore()

  const syncing = ref(false)
  /** 上次成功同步的合并后关注总数；null = 尚未成功过 */
  const syncTotal = ref<number | null>(null)
  /** 上次成功同步时间（ms）；null = 尚未成功过 */
  const syncAt = ref<number | null>(null)
  /** 上次失败原因；空串 = 无失败记录 */
  const syncError = ref('')

  /** 进行中的同步：并发触发共用同一个 promise，只发一次请求 */
  let inflight: Promise<boolean> | null = null

  /**
   * 执行一次同步。返回是否成功；未登录直接返回 false（不报错——
   * 未登录时本地关注照常工作，同步根本不该发生）。
   */
  function sync(): Promise<boolean> {
    if (!ensurePocketAuthState().loggedIn)
      return Promise.resolve(false)
    inflight ??= run().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function run(): Promise<boolean> {
    syncing.value = true
    try {
      const ids = await window.mainAPI.pocketGetFollowedIds()
      const total = await mergeFromPocket(ids)
      syncTotal.value = total
      syncAt.value = Date.now()
      syncError.value = ''
      debugLog('pocket-follow', `同步完成：合并后关注 ${total} 人`)
      return true
    }
    catch (error) {
      syncError.value = pocketAuthErrorMessage(error)
      debugLog('pocket-follow', '同步失败', error)
      return false
    }
    finally {
      syncing.value = false
    }
  }

  return {
    syncing,
    syncTotal,
    syncAt,
    syncError,
    sync,
    /** 启动时静默同步：距上次成功不足 intervalMs 则跳过（friends/id 无分页成本低，阈值仅防频繁写盘） */
    syncIfStale: (intervalMs: number) => {
      if (syncAt.value && Date.now() - syncAt.value < intervalMs)
        return
      void sync()
    },
  }
}
