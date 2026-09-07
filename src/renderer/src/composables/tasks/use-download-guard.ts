import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'

/**
 * 下载/录制前的公共校验：下载目录已配置才放行。
 * 目录缺失时提示并跳转设置页。LivePlayer（录制）与 PlaybackPlayer（回放下载）共用，
 * 须在组件 setup 内调用（内部依赖 useRouter）。
 */
export function useDownloadGuard() {
  const router = useRouter()

  async function checkDownloadDirectory(): Promise<boolean> {
    try {
      // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts 的 'getConfig'
      const result = await window.mainAPI.getConfig('downloadDirectory')
      if (!result) {
        ElMessage({
          message: '下载目录不存在，请先配置下载目录',
          type: 'warning',
        })
        router.push('/setting')
        return false
      }
      return true
    }
    catch (error: any) {
      console.error('检查下载目录失败:', error)
      ElMessage({ message: '检查下载目录失败', type: 'error' })
      return false
    }
  }

  return { checkDownloadDirectory }
}

export default useDownloadGuard
