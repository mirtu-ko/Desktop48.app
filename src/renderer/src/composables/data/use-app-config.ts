import { ElMessage, ElMessageBox } from 'element-plus'
import { ref } from 'vue'
import Constants from '../../utils/constants'

/** 应用配置项的键（限制 getConfig / setConfig 的 key 取值范围） */
export type AppConfigKey = 'downloadDirectory' | 'ffmpegDirectory' | 'userAgent'

/**
 * 应用配置的读写收口：三项配置（下载目录 / ffmpeg 目录 / User-Agent）的状态、
 * 持久化与目录选择流程都在这里，Setting.vue 只负责模板接线。
 *
 * ★ 跨进程：本文件的 getConfig / setConfig / selectDirectory / openPath /
 * checkFfmpegBinaries 全部经 preload/index.ts 转到主进程
 * （配置读写对端 main/ipc/register-database-ipc.ts，目录与文件操作对端 main/app.ts）。
 */
export function useAppConfig() {
  // 下载目录 / ffmpeg目录 / User-Agent
  const downloadDirectory = ref('')
  const ffmpegDirectory = ref('')
  const userAgent = ref('')

  /** 挂载时读取三项配置（未设置时回退各自默认值） */
  async function loadAppConfig() {
    downloadDirectory.value = await window.mainAPI.getConfig('downloadDirectory', '')
    ffmpegDirectory.value = await window.mainAPI.getConfig('ffmpegDirectory', '')
    userAgent.value = await window.mainAPI.getConfig('userAgent', Constants.DEFAULT_USER_AGENT)
  }

  /** 通用保存：写盘 + 成功提示 */
  async function saveConfig(key: AppConfigKey, value: string) {
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
    void window.mainAPI.openPath(downloadDirectory.value)
  }

  /** 选择 ffmpeg 目录：校验 ffmpeg/ffplay 可执行文件存在后保存，校验失败询问是否重选 */
  async function setFfmpegDirectory() {
    const dir = await window.mainAPI.selectDirectory()
    if (!dir) {
      return
    }
    try {
      await window.mainAPI.checkFfmpegBinaries(dir)
      ffmpegDirectory.value = dir
      await saveConfig('ffmpegDirectory', dir)
    }
    catch (e) {
      console.error('[useAppConfig] 设置ffmpeg目录失败:', e)
      confirmFfmpegDir()
    }
  }

  function confirmFfmpegDir() {
    ElMessageBox.confirm('选择的目录下没有ffmpeg或ffplay', {
      confirmButtonText: '重新选择',
      cancelButtonText: '取消',
    }).then(() => {
      setFfmpegDirectory()
    }).catch(() => {
      // 用户取消操作
    })
  }

  function openFfmpegDirectory() {
    void window.mainAPI.openPath(ffmpegDirectory.value)
  }

  /** 保存 User-Agent（输入框内容由模板双向绑定） */
  async function setUserAgent() {
    await saveConfig('userAgent', userAgent.value)
  }

  return {
    downloadDirectory,
    ffmpegDirectory,
    userAgent,
    loadAppConfig,
    setDownloadDirectory,
    openDownloadDirectory,
    setFfmpegDirectory,
    openFfmpegDirectory,
    setUserAgent,
  }
}
