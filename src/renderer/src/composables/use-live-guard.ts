import type { Router } from 'vue-router'
import { ElMessage } from 'element-plus'
import { describeFfmpegProblem } from './use-ffmpeg-setup'
import { useSettingsNav } from './use-settings-nav'

/**
 * 开播前的 FFmpeg 前置校验。
 *
 * 直播播放依赖「主进程 FFmpeg 拉 RTMP → 本地 HTTP-FLV」链路，FFmpeg 缺失时窗口即使打开
 * 也只会停在加载态，用户拿不到任何可操作的线索；因此在**开播入口**就拦下来。
 * 判定口径与下载前的 useDownloadGuard 完全一致（window.mainAPI.getFfmpegStatus），
 * 文案共用 describeFfmpegProblem，不会出现「启动说可用、点开直播说不可用」两套说法。
 *
 * 入口收敛在 stores/float-players.ts 的 openLive（直播列表 / 公演页 / 成员页 / 房间分享卡
 * 都经它），校验只需在那里接一次。只校验 FFmpeg——看直播不落盘，不涉及下载目录。
 *
 * ★ 跨进程：getFfmpegStatus 对端 main/ipc/register-system-ipc.ts，
 * 判定口径在 main/ffmpeg/ffmpeg-process.ts 的 inspectFfmpegDir。
 */

/** 单飞：连点多张卡片时复用同一次判定，避免堆叠多条相同提示 */
let inflight: Promise<boolean> | null = null

export function useLiveGuard(router?: Router) {
  const { settingsName, openSettings } = useSettingsNav(router)

  /**
   * 直播是否可播。不可用时已就地提示并跳转设置页，调用方只需看返回值。
   * 三级 Router 回落中的「全局 Router」由 main.ts 安装，因此本函数可在 store 等
   * 非 setup 上下文直接调用。
   */
  function checkLiveReady(): Promise<boolean> {
    if (!inflight) {
      inflight = runCheck().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  async function runCheck(): Promise<boolean> {
    try {
      // 不传 dir：由主进程按当前生效配置判定，渲染层不自己拼目录
      const status = await window.mainAPI.getFfmpegStatus()
      if (status.ok)
        return true

      const { title, action } = describeFfmpegProblem(status.problem, status.directory)
      ElMessage({
        // 未配置时用户不知道「看直播为什么需要 ffmpeg」，补一句缘由；
        // 其余两类 title 已说明问题本身（目录失效 / 缺二进制），不必再重复
        message: status.problem === 'unset'
          ? `直播播放需要 FFmpeg，请先在${settingsName}中${action}`
          : `${title}，请在${settingsName}中${action}`,
        // 环境缺失属于「待用户配置」，用 warning；只有检查流程本身出错才算 error
        type: 'warning',
      })
      openSettings()
      return false
    }
    catch (error) {
      console.error('[useLiveGuard] 检查 FFmpeg 环境失败:', error)
      ElMessage({ message: '检查播放环境失败，请稍后重试', type: 'error' })
      return false
    }
  }

  return { checkLiveReady }
}

export default useLiveGuard
