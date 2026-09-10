<script setup lang="ts">
import type { FfmpegDownloadProgress } from '../../../../preload/ipc-contract'
import { Loading } from '@element-plus/icons-vue'
import { onMounted, onUnmounted, ref } from 'vue'

const emit = defineEmits(['initialized'])

const initText = ref('正在初始化')
const checking = ref(false)
const downloading = ref(false)

let unsubscribeProgress: (() => void) | null = null

onMounted(() => {
  init()
  // 订阅 ffmpeg 下载进度（★ 跨进程：对端 main/ffmpeg/ffmpeg-download.ts）
  unsubscribeProgress = window.mainAPI.onFfmpegDownloadProgress(onFfmpegDownloadProgress)
})

onUnmounted(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = null
})

/**
 * 首屏环境自检：ffmpeg 目录未配置则引导用户选择或在线下载。
 *
 * ★ 跨进程：本文件的 getConfig / setConfig 对端是 main/ipc/register-database-ipc.ts，
 * selectDirectory / checkFfmpegBinaries / getPlatform 对端是 main/ipc/register-system-ipc.ts，
 * downloadFfmpeg 对端是 main/ffmpeg/ffmpeg-download.ts。
 */
async function init() {
  try {
    // preload 注入失败时（打包异常/contextBridge 未生效）整个应用不可用，这里给出可读提示
    if (!window.mainAPI || typeof window.mainAPI.getConfig !== 'function') {
      initText.value = 'Electron API 未注入，无法获取平台信息'
      console.error('window.mainAPI 未定义或 getConfig 方法不存在')
      return
    }
    // 本地已保存过 ffmpeg 目录，说明环境已就绪，直接放行
    const ffmpegDir = await window.mainAPI.getConfig('ffmpegDirectory')
    if (ffmpegDir) {
      emit('initialized')
      return
    }
    // 未配置 ffmpeg：提示用户在线下载或手动选择
    initText.value = '请下载或选择 ffmpeg 目录'
  }
  catch (error) {
    // 配置读取走 IPC，数据库损坏等异常会让初始化中断，必须给用户可见的失败态
    console.error('[Initialize.vue]初始化失败:', error)
    initText.value = '初始化失败，请重启应用重试'
  }
}

function onFfmpegDownloadProgress(progress: FfmpegDownloadProgress) {
  if (progress.total > 0) {
    const percent = Math.min(99, Math.floor((progress.received / progress.total) * 100))
    initText.value = `正在下载 ffmpeg… ${percent}%`
  }
  else {
    initText.value = `正在下载 ffmpeg… ${(progress.received / 1024 / 1024).toFixed(1)} MB`
  }
}

/** 一键下载：主进程按当前系统拉取 ffmpeg 二进制并解压到应用数据目录（userData/ffmpeg） */
async function downloadFfmpeg() {
  if (downloading.value)
    return
  downloading.value = true
  try {
    const dir = await window.mainAPI.downloadFfmpeg()
    initText.value = '正在校验 ffmpeg 环境…'
    await window.mainAPI.checkFfmpegBinaries(dir)
    await window.mainAPI.setConfig('ffmpegDirectory', dir)
    initText.value = 'ffmpeg 环境就绪'
    emit('initialized')
  }
  catch (e) {
    console.error('[Initialize.vue]下载 ffmpeg 失败:', e)
    initText.value = '下载失败，请检查网络后重试，或手动选择 ffmpeg 目录'
  }
  finally {
    downloading.value = false
  }
}

async function selectFfmpegDir() {
  const dir = await window.mainAPI.selectDirectory()
  if (!dir)
    return
  initText.value = '正在校验 ffmpeg 环境…'
  checking.value = true
  try {
    // 校验目录下是否存在 ffmpeg 可执行文件
    await window.mainAPI.checkFfmpegBinaries(dir)
    await window.mainAPI.setConfig('ffmpegDirectory', dir)
    initText.value = '保存目录成功'
    emit('initialized')
  }
  catch (e) {
    console.error(e)
    initText.value = '该目录下未找到 ffmpeg 可执行文件，请重新选择'
  }
  finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="init-main">
    <div>
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <span class="init-text">{{ initText }}</span>
    </div>

    <div class="select-btn">
      <el-button :loading="downloading" type="primary" @click="downloadFfmpeg">
        下载 FFmpeg
      </el-button>
      <el-button :loading="checking" @click="selectFfmpegDir">
        手动选择ffmpeg目录
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.init-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.init-text {
  margin-left: 8px;
}

.select-btn {
  margin-top: 32px;
}
</style>
