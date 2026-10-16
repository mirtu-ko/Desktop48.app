import type { Router } from 'vue-router'

import { ElMessage } from 'element-plus'
import { getCurrentInstance } from 'vue'

/**
 * 获取可选 Router：主窗口安装了 vue-router，独立播放窗刻意不装。
 * 不能直接用 useRouter()——无 Router 时它会告警并返回 undefined，且调用方容易误以为一定可跳转。
 */
function resolveOptionalRouter(): Router | undefined {
  const instance = getCurrentInstance()
  const globalProperties = instance?.appContext.config.globalProperties as { $router?: Router } | undefined
  return globalProperties?.$router
}

/**
 * 下载/录制前的公共校验：下载目录与 FFmpeg 环境都就绪才放行。
 * 任一项缺失时提示；主窗口跳转设置页，播放浮窗提示用户去主窗口设置。
 * LivePlayer（录制）与 PlaybackPlayer（回放下载）共用，须在组件 setup 内调用。
 */
export function useDownloadGuard(router?: Router) {
  const appRouter = router ?? resolveOptionalRouter()
  const settingsName = appRouter ? '「设置」' : '主窗口「设置」'

  function openSettings() {
    void appRouter?.push('/setting')
  }

  async function checkDownloadDirectory(): Promise<boolean> {
    try {
      // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts 的 'getConfig'
      const result = await window.mainAPI.getConfig('downloadDirectory')
      if (!result) {
        ElMessage({
          message: `请先在${settingsName}中配置下载目录`,
          type: 'error',
        })
        openSettings()
        return false
      }

      // FFmpeg 目录可能已被用户删除/移动，除了检查配置存在，还要确认二进制仍可用
      const ffmpegDirectory = await window.mainAPI.getConfig('ffmpegDirectory')
      if (!ffmpegDirectory) {
        ElMessage({
          message: `请先在${settingsName}中下载或选择 FFmpeg 目录`,
          type: 'error',
        })
        openSettings()
        return false
      }

      try {
        // ★ 跨进程：preload/index.ts → main/ipc/register-system-ipc.ts
        await window.mainAPI.checkFfmpegBinaries(ffmpegDirectory)
      }
      catch (error) {
        console.error('检查 FFmpeg 环境失败:', error)
        ElMessage({
          message: `FFmpeg 目录不可用，请到${settingsName}重新下载或选择 FFmpeg 目录`,
          type: 'error',
        })
        openSettings()
        return false
      }

      return true
    }
    catch (error) {
      console.error('检查下载环境失败:', error)
      ElMessage({ message: '检查下载环境失败，请稍后重试', type: 'error' })
      return false
    }
  }

  return { checkDownloadDirectory }
}

export default useDownloadGuard
