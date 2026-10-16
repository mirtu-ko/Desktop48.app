<script setup lang="ts">
import type { FfmpegDownloadProgress } from '@preload/ipc-contract'
import { computed, onMounted, onUnmounted, ref } from 'vue'

const emit = defineEmits(['initialized'])

type InitStatus = 'boot' | 'setup' | 'downloading' | 'validating' | 'ready' | 'error'

/** 当前初始化阶段：模板据此区分等待态、用户引导态与错误态 */
const status = ref<InitStatus>('boot')
const initText = ref('正在初始化')
const initHint = ref('正在检查本地 FFmpeg 环境…')
/** 自动初始化期间隐藏操作区，避免用户在检查尚未完成时误点 */
const showActions = ref(false)
const checking = ref(false)
const downloading = ref(false)
const receivedBytes = ref(0)
const totalBytes = ref(0)

let unsubscribeProgress: (() => void) | null = null

/** 检查/下载/校验期间都属于忙态，两个环境修复入口互斥禁用 */
const busy = computed(() => downloading.value || checking.value)
const isError = computed(() => status.value === 'error')

/** 已知 total 时显示真实进度；未知 total 时进度条走轻量流动动画 */
const downloadPercent = computed(() => {
  if (totalBytes.value <= 0)
    return null
  return Math.min(99, Math.floor((receivedBytes.value / totalBytes.value) * 100))
})

const downloadLabel = computed(() => {
  const received = formatSize(receivedBytes.value)
  if (totalBytes.value <= 0)
    return received
  return `${received} / ${formatSize(totalBytes.value)} · ${downloadPercent.value ?? 0}%`
})

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

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
 * selectDirectory / checkFfmpegBinaries 对端是 main/ipc/register-system-ipc.ts，
 * downloadFfmpeg 对端是 main/ffmpeg/ffmpeg-download.ts。
 */
async function init() {
  status.value = 'boot'
  showActions.value = false
  initText.value = '正在初始化'
  initHint.value = '正在检查本地 FFmpeg 环境…'
  try {
    // preload 注入失败时（打包异常/contextBridge 未生效）整个应用不可用，这里给出可读提示
    if (!window.mainAPI || typeof window.mainAPI.getConfig !== 'function') {
      initText.value = 'Electron API 未注入，无法获取平台信息'
      initHint.value = '请重启应用；如果仍然出现，说明安装包可能已损坏'
      status.value = 'error'
      console.error('window.mainAPI 未定义或 getConfig 方法不存在')
      return
    }
    // 本地已保存过 ffmpeg 目录，说明环境已就绪，直接放行
    const ffmpegDir = await window.mainAPI.getConfig('ffmpegDirectory')
    if (ffmpegDir) {
      status.value = 'ready'
      initText.value = 'FFmpeg 环境就绪'
      initHint.value = '即将进入应用…'
      emit('initialized')
      return
    }

    // 环境未就绪才暴露操作入口，普通自动检查不给用户可点按钮
    status.value = 'setup'
    showActions.value = true
    // 未配置 ffmpeg：提示用户在线下载或手动选择
    initText.value = '请下载或选择 ffmpeg 目录'
    initHint.value = '播放直播/回放和媒体下载都需要 FFmpeg。可一键下载，也可以手动指定已有目录。'
  }
  catch (error) {
    // 配置读取走 IPC，数据库损坏等异常会让初始化中断，必须给用户可见的失败态
    console.error('[Initialize.vue]初始化失败:', error)
    initText.value = '初始化失败，请重启应用重试'
    initHint.value = '配置读取中断。重启应用通常可以恢复，也可以重新配置 FFmpeg。'
    status.value = 'error'
    showActions.value = true
  }
}

function onFfmpegDownloadProgress(progress: FfmpegDownloadProgress) {
  status.value = 'downloading'
  receivedBytes.value = progress.received
  totalBytes.value = progress.total
  initText.value = '正在下载 FFmpeg'
  initHint.value = progress.total > 0 ? '请保持网络连接，下载完成后会自动校验' : '正在获取 FFmpeg 二进制文件…'
}

/** 一键下载：主进程按当前系统拉取 ffmpeg 二进制并解压到应用数据目录（userData/ffmpeg） */
async function downloadFfmpeg() {
  if (busy.value)
    return
  receivedBytes.value = 0
  totalBytes.value = 0
  status.value = 'downloading'
  initText.value = '正在下载 FFmpeg'
  initHint.value = '请保持网络连接，下载完成后会自动校验'
  downloading.value = true
  try {
    const dir = await window.mainAPI.downloadFfmpeg()
    status.value = 'validating'
    initText.value = '正在校验 ffmpeg 环境…'
    initHint.value = '正在确认 FFmpeg 可执行文件是否完整可用'
    await window.mainAPI.checkFfmpegBinaries(dir)
    await window.mainAPI.setConfig('ffmpegDirectory', dir)
    status.value = 'ready'
    initText.value = 'ffmpeg 环境就绪'
    initHint.value = '即将进入应用…'
    emit('initialized')
  }
  catch (e) {
    console.error('[Initialize.vue]下载 ffmpeg 失败:', e)
    status.value = 'error'
    showActions.value = true
    initText.value = '下载失败，请检查网络后重试，或手动选择 ffmpeg 目录'
    initHint.value = '网络恢复后可重新下载；如果你本机已有 FFmpeg，也可以直接选择目录。'
  }
  finally {
    downloading.value = false
  }
}

async function selectFfmpegDir() {
  if (busy.value)
    return

  checking.value = true
  try {
    const dir = await window.mainAPI.selectDirectory()
    if (!dir)
      return

    status.value = 'validating'
    initText.value = '正在校验 ffmpeg 环境…'
    initHint.value = '正在确认所选目录中是否包含 FFmpeg 可执行文件'

    // 校验目录下是否存在 ffmpeg 可执行文件
    await window.mainAPI.checkFfmpegBinaries(dir)
    await window.mainAPI.setConfig('ffmpegDirectory', dir)
    initText.value = '保存目录成功'
    emit('initialized')
  }
  catch (e) {
    console.error(e)
    status.value = 'error'
    initText.value = '该目录下未找到 ffmpeg 可执行文件，请重新选择'
    initHint.value = '请选择包含 ffmpeg 可执行文件的目录，或改用一键下载。'
  }
  finally {
    checking.value = false
  }
}
</script>

<template>
  <main class="init-main">
    <section class="init-card" :class="{ 'is-error': isError }" :aria-busy="busy">
      <div class="init-badge" :class="{ 'is-working': busy }" aria-hidden="true">
        <span class="badge-halo" />
        <span class="badge-mark">FF</span>
        <span class="badge-ring" />
      </div>

      <div class="init-copy" role="status" aria-live="polite">
        <h1>{{ initText }}</h1>
        <p>{{ initHint }}</p>
      </div>

      <div v-if="downloading" class="init-progress">
        <div class="progress-track">
          <div
            class="progress-fill"
            :class="{ 'is-indeterminate': downloadPercent === null }"
            :style="downloadPercent === null ? undefined : { width: `${downloadPercent}%` }"
          />
        </div>
        <span class="progress-label">{{ downloadLabel }}</span>
      </div>

      <div v-if="showActions" class="init-actions">
        <el-button
          :loading="downloading"
          :disabled="checking"
          type="primary"
          @click="downloadFfmpeg"
        >
          {{ downloading ? '下载中' : '下载 FFmpeg' }}
        </el-button>
        <el-button
          :loading="checking"
          :disabled="downloading"
          @click="selectFfmpegDir"
        >
          {{ checking ? '校验中' : '手动选择目录' }}
        </el-button>
      </div>

      <p class="init-note">
        FFmpeg 用于播放直播/回放与媒体下载
      </p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.init-main {
  display: grid;
  place-items: center;
  padding: 24px;
  height: 100%;
}

/* 初始化卡片：复用全局玻璃配方，让启动页与 app-body 的渐变底自然融合 */
.init-card {
  width: min(440px, 100%);
  padding: 34px 30px 24px;
  text-align: center;
  border-radius: var(--radius-card);
  background: var(--glass-sheen), var(--glass-fill);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), var(--glass-lip);
  animation: init-card-in 0.48s cubic-bezier(0.22, 1, 0.36, 1);
}

/* 品牌徽标：用 FF 标记比一个通用 loading 图标更有启动页归属感 */
.init-badge {
  position: relative;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  margin: 0 auto;
  border-radius: 24px;
  background: var(--gradient-brand);
  color: #fff;
  box-shadow:
    var(--shadow-glow),
    inset 0 1px 0 rgba(255, 255, 255, 0.42);
}

.init-card.is-error .init-badge {
  background: linear-gradient(135deg, #ff7a90, var(--color-lives));
  box-shadow: 0 8px 20px -8px color-mix(in srgb, var(--color-lives) 65%, transparent);
}

.badge-halo {
  position: absolute;
  inset: -10px;
  border-radius: 34px;
  background: radial-gradient(circle, rgba(var(--brand-rgb), 0.22), transparent 66%);
  animation: init-breathe 3s ease-in-out infinite;
}

.badge-mark {
  position: relative;
  z-index: 1;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.4px;
}

.badge-ring {
  position: absolute;
  inset: -7px;
  border: 2px solid transparent;
  border-top-color: rgba(var(--brand-rgb), 0.68);
  border-radius: 31px;
  opacity: 0;
}

.init-badge.is-working .badge-ring {
  opacity: 1;
  animation: init-spin 1.1s linear infinite;
}

.init-copy {
  margin-top: 20px;

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.4;
    color: var(--el-text-color-primary);
  }

  p {
    max-width: 330px;
    min-height: 40px;
    margin: 8px auto 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }
}

.init-progress {
  margin-top: 22px;
}

.progress-track {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--brand-primary) 12%, var(--el-bg-color));
}

.progress-fill {
  width: 36%;
  height: 100%;
  border-radius: inherit;
  background: var(--gradient-brand);
  box-shadow: 0 0 10px rgba(var(--brand-rgb), 0.32);
}

.progress-fill.is-indeterminate {
  animation: init-progress-flow 1.4s ease-in-out infinite;
}

.progress-label {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

/* 操作区只在引导态出现；忙态仍保留但禁用，避免布局跳动 */
.init-actions {
  display: flex;
  gap: 10px;
  margin-top: 24px;

  :deep(.el-button) {
    flex: 1;
    margin: 0;
    border-radius: var(--radius-pill);
    letter-spacing: 0.4px;
  }
}

.init-note {
  margin: 22px 0 0;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--el-border-color) 48%, transparent);
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

@keyframes init-card-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes init-breathe {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.98);
  }

  50% {
    opacity: 1;
    transform: scale(1.04);
  }
}

@keyframes init-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes init-progress-flow {
  from {
    transform: translateX(-115%);
  }

  to {
    transform: translateX(315%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .init-card,
  .badge-halo,
  .init-badge.is-working .badge-ring,
  .progress-fill.is-indeterminate {
    animation: none;
  }

  .progress-fill.is-indeterminate {
    width: 100%;
    opacity: 0.55;
  }
}
</style>
