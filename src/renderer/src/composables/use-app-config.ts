import type { AppConfig, ConfigKey } from '@common/app-config'
import { trackEvent } from '@renderer/utils/umami'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

/**
 * 应用配置的集中管理：下载目录的状态与读写在这里，Setting.vue 只负责模板接线。
 * FFmpeg 目录涉及「就绪状态 + 一键下载 + 校验修复」，已独立到 use-ffmpeg-setup.ts，
 * 此处不再掺入，避免同一份环境判定出现两套实现。
 *
 * ★ 跨进程：本文件的 getConfig / setConfig / selectDirectory / openPath 全部经
 * preload/index.ts 转到主进程（配置读写对端 main/ipc/register-database-ipc.ts，
 * 目录与文件操作对端 main/ipc/register-system-ipc.ts）。
 */

/**
 * 打开目录：空值与主进程报错都要给出可见反馈。
 * 主进程 openPath 以 reject 报失败（路径越界 / 目录已不存在），
 * 直接 void 掉 Promise 会让点击毫无反应，故这里统一兜住。下载目录与 FFmpeg 目录共用。
 */
export async function openDirectoryWithFeedback(dir: string, label: string) {
  if (!dir) {
    ElMessage.warning(`请先点击「选择」设置${label}`)
    return
  }
  try {
    await window.mainAPI.openPath(dir)
  }
  catch (e) {
    console.error(`[useAppConfig] 打开${label}失败:`, e)
    ElMessage.error(`打开${label}失败：${String(e instanceof Error ? e.message : e)}`)
  }
}

export function useAppConfig() {
  // 下载目录
  const downloadDirectory = ref('')

  /** 挂载时读取配置（init() 已补齐默认值，恒为生效值） */
  async function loadAppConfig() {
    downloadDirectory.value = await window.mainAPI.getConfig('downloadDirectory')
  }

  /** 通用保存：写盘 + 成功提示。键值类型按契约收窄，写错取值在编译期就会被拦住 */
  async function saveConfig<K extends ConfigKey>(key: K, value: AppConfig[K]) {
    await window.mainAPI.setConfig(key, value)
    ElMessage({ message: '设置成功', type: 'success' })
  }

  /** 选择下载目录并保存 */
  async function setDownloadDirectory() {
    const dir = await window.mainAPI.selectDirectory()
    // 用户取消选择不算一次变更，不上报
    if (!dir)
      return
    downloadDirectory.value = dir
    try {
      await saveConfig('downloadDirectory', dir)
      // 设置项变更：只记「哪一项、成没成」，绝不记路径（可能带用户名等本机信息）
      trackEvent('setting:change', { key: 'downloadDir', result: 'ok' })
    }
    catch (error) {
      trackEvent('setting:change', { key: 'downloadDir', result: 'fail' })
      throw error
    }
  }

  function openDownloadDirectory() {
    return openDirectoryWithFeedback(downloadDirectory.value, '下载目录')
  }

  return {
    downloadDirectory,
    loadAppConfig,
    setDownloadDirectory,
    openDownloadDirectory,
  }
}
