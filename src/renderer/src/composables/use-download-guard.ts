import type { Router } from 'vue-router'
import { ElMessage } from 'element-plus'
import { describeFfmpegProblem } from './use-ffmpeg-setup'
import { useSettingsNav } from './use-settings-nav'

/**
 * 下载/录制前的公共校验：下载目录与 FFmpeg 环境都就绪才放行。
 * 任一项缺失时提示并引导到设置页（播放浮窗没有路由，改为提示去主窗口设置）。
 *
 * FFmpeg 判定与启动门禁同一口径（window.mainAPI.getFfmpegStatus），
 * 因此「启动时判定不可用」与「使用时才缺失」不会给出两套说法。
 * LivePlayer（录制）与 PlaybackPlayer（回放下载）共用，须在组件 setup 内调用。
 */
export function useDownloadGuard(router?: Router) {
  const { settingsName, openSettings } = useSettingsNav(router)

  async function checkDownloadDirectory(): Promise<boolean> {
    try {
      // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts 的 'getConfig'
      const result = await window.mainAPI.getConfig('downloadDirectory')
      if (!result) {
        ElMessage({
          message: `请先在${settingsName}中配置下载目录`,
          type: 'warning',
        })
        openSettings()
        return false
      }

      // FFmpeg 目录可能已被用户删除/移动，也可能是下载产物损坏；判定由主进程统一给出
      // ★ 跨进程：preload/index.ts → main/ipc/register-system-ipc.ts
      const status = await window.mainAPI.getFfmpegStatus()
      if (!status.ok) {
        const { title, action } = describeFfmpegProblem(status.problem, status.directory)
        // 环境缺失属于「待用户配置」，用 warning；只有检查流程本身出错才算 error
        ElMessage({
          message: status.problem === 'unset'
            ? `请先在${settingsName}中${action}`
            : `${title}：请在${settingsName}中${action}`,
          type: 'warning',
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
