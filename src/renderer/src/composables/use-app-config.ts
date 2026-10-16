import type { ConfigKey } from '@common/app-config'
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

  /** 通用保存：写盘 + 成功提示 */
  async function saveConfig(key: ConfigKey, value: string) {
    await window.mainAPI.setConfig(key, value)
    ElMessage({ message: '设置成功', type: 'success' })
  }

  /** 选择下载目录并保存 */
  async function setDownloadDirectory() {
    const dir = await window.mainAPI.selectDirectory()
    if (dir) {
      downloadDirectory.value = dir
      await saveConfig('downloadDirectory', dir)
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
