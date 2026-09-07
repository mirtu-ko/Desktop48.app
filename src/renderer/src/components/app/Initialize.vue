<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue'
import { onMounted, ref } from 'vue'

const emit = defineEmits(['initialized'])

const initText = ref('正在初始化')
const checking = ref(false)

onMounted(() => {
  init()
})

/**
 * 首屏环境自检：ffmpeg 目录未配置则引导用户选择。
 *
 * ★ 跨进程：本文件的 getConfig / setConfig 对端是 main/ipc/register-database-ipc.ts，
 * selectDirectory / checkFfmpegBinaries / getPlatform 对端是 main/app.ts。
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
    const ffmpegDir = await window.mainAPI.getConfig('ffmpegDirectory', '')
    if (ffmpegDir) {
      emit('initialized')
      return
    }
    // 只允许手动选择 ffmpeg 目录
    initText.value = '请选择 ffmpeg 目录'
  }
  catch (error) {
    // 配置读取走 IPC，数据库损坏等异常会让初始化中断，必须给用户可见的失败态
    console.error('[Initialize.vue]初始化失败:', error)
    initText.value = '初始化失败，请重启应用重试'
  }
}

async function selectFfmpegDir() {
  const dir = await window.mainAPI.selectDirectory()
  if (!dir)
    return
  initText.value = '正在校验 ffmpeg 环境…'
  checking.value = true
  try {
    // 校验目录下是否存在 ffmpeg / ffplay 可执行文件
    await window.mainAPI.checkFfmpegBinaries(dir)
    await window.mainAPI.setConfig('ffmpegDirectory', dir)
    initText.value = '保存目录成功'
    emit('initialized')
  }
  catch (e) {
    console.error(e)
    initText.value = '该目录下未找到 ffmpeg / ffplay 可执行文件，请重新选择'
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

    <el-button class="select-btn" type="primary" :loading="checking" @click="selectFfmpegDir">
      手动选择ffmpeg目录
    </el-button>
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
