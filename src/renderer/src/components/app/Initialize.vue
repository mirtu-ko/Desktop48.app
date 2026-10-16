<script setup lang="ts">
import { describeFfmpegProblem, useFfmpegSetup } from '@renderer/composables/use-ffmpeg-setup'
import { computed, onMounted, ref } from 'vue'

const emit = defineEmits(['initialized'])

/**
 * 启动门禁的阶段机：
 * - checking：正在判定环境
 * - ready：环境可用，即将放行
 * - blocked：环境不可用（未配置 / 目录失效 / 缺二进制），停在修复页
 * - error：判定流程本身失败（IPC 未注入、配置读取中断），非环境问题
 */
type InitPhase = 'checking' | 'ready' | 'blocked' | 'error'

const {
  checking,
  downloading,
  busy,
  directory,
  problem,
  downloadPercent,
  downloadLabel,
  refresh: refreshFfmpeg,
  download: downloadFfmpeg,
  choose: chooseFfmpegDir,
} = useFfmpegSetup()

const phase = ref<InitPhase>('checking')
/** 单次操作的即时反馈（下载失败、误选目录），显示在修复引导下方 */
const actionError = ref('')
/** error 阶段的文案：判定流程中断，与环境判定结果无关 */
const fatalText = ref('')
const fatalHint = ref('')

const isError = computed(() => phase.value === 'error')
const showActions = computed(() => phase.value === 'blocked' || phase.value === 'error')

/**
 * 仅「已配置但失效」允许跳过：目录被移动/删除属于环境需修复，拦死会让用户连成员都浏览不了；
 * 未配置时不给跳过，否则又会退回到「使用时才发现缺 FFmpeg」的老问题。
 */
const canSkip = computed(() => phase.value === 'blocked' && problem.value !== 'unset')

/** 文案统一由 describeFfmpegProblem 产出，与设置页保持同一说法 */
const copy = computed(() => describeFfmpegProblem(problem.value, directory.value))

const initText = computed(() => {
  if (downloading.value)
    return '正在下载 FFmpeg'
  if (phase.value === 'checking')
    return '正在初始化'
  if (phase.value === 'ready')
    return 'FFmpeg 环境就绪'
  if (phase.value === 'error')
    return fatalText.value
  return copy.value.title
})

const initHint = computed(() => {
  if (downloading.value)
    return '请保持网络连接，下载完成后会自动校验'
  if (phase.value === 'checking')
    return '正在检查本地 FFmpeg 环境…'
  if (phase.value === 'ready')
    return '即将进入应用…'
  if (phase.value === 'error')
    return fatalHint.value
  return copy.value.hint
})

onMounted(() => {
  void init()
})

/**
 * 首屏环境自检：判定的是「目录里的 ffmpeg 是否真的可用」，而不是「配置是否非空」。
 * 后者会让目录被删除/移动后的用户一路进入应用，直到发起下载或播放才撞上报错。
 *
 * ★ 跨进程：getFfmpegStatus / setConfig 经 preload/index.ts 转到主进程，
 * 判定口径见 main/ffmpeg/ffmpeg-process.ts 的 inspectFfmpegDir。
 */
async function init() {
  phase.value = 'checking'
  actionError.value = ''
  // preload 注入失败时（打包异常/contextBridge 未生效）整个应用不可用，这里给出可读提示
  if (!window.mainAPI || typeof window.mainAPI.getFfmpegStatus !== 'function') {
    fatalText.value = 'Electron API 未注入，无法获取平台信息'
    fatalHint.value = '请重启应用；如果仍然出现，说明安装包可能已损坏'
    phase.value = 'error'
    console.error('window.mainAPI 未定义或 getFfmpegStatus 方法不存在')
    return
  }

  const status = await refreshFfmpeg()
  if (!status) {
    fatalText.value = '初始化失败，请重启应用重试'
    fatalHint.value = 'FFmpeg 环境检查中断。重启应用通常可以恢复，也可以直接重新下载或选择 FFmpeg 目录。'
    phase.value = 'error'
    return
  }
  if (status.ok) {
    phase.value = 'ready'
    emit('initialized')
    return
  }
  // 未配置 / 已失效：停在修复页，下载与选择两个入口都给出
  phase.value = 'blocked'
}

/** 一键下载：主进程按当前系统拉取 ffmpeg 二进制并解压到应用数据目录（userData/ffmpeg） */
async function onDownload() {
  actionError.value = ''
  if (await downloadFfmpeg()) {
    phase.value = 'ready'
    emit('initialized')
    return
  }
  actionError.value = '下载失败：请检查网络后重试，或手动选择本机已有的 FFmpeg 目录。'
}

async function onChooseDir() {
  actionError.value = ''
  const result = await chooseFfmpegDir()
  if (result.outcome === 'ok') {
    phase.value = 'ready'
    emit('initialized')
    return
  }
  if (result.outcome === 'invalid') {
    actionError.value = describeFfmpegProblem(result.status.problem, result.status.directory).hint
    return
  }
  if (result.outcome === 'failed')
    actionError.value = '设置 FFmpeg 目录失败，请重试或改用手动选择。'
}

/** 环境待修复时的临时放行：功能入口仍有各自的校验与提示兜底（见 use-download-guard.ts） */
function skipSetup() {
  emit('initialized')
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
          @click="onDownload"
        >
          {{ downloading ? '下载中' : '下载 FFmpeg' }}
        </el-button>
        <el-button
          :loading="checking"
          :disabled="downloading"
          @click="onChooseDir"
        >
          {{ checking ? '校验中' : '手动选择目录' }}
        </el-button>
      </div>

      <el-button
        v-if="canSkip"
        class="init-skip"
        link
        :disabled="busy"
        @click="skipSetup"
      >
        暂时跳过，稍后在「设置」中修复
      </el-button>

      <p class="init-note" :class="{ 'is-warning': !!actionError }">
        {{ actionError || 'FFmpeg 用于播放直播/回放与媒体下载' }}
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

/* 操作失败提示复用同一行位置，仅换配色，避免卡片布局跳动 */
.init-note.is-warning {
  color: var(--color-lives);
}

/* 待修复态的临时放行入口：弱化为主链接，不与两个修复动作争夺注意力 */
.init-skip {
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
