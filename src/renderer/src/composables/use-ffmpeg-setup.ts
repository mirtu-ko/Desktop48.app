import type { FfmpegProblem, FfmpegStatus } from '@preload/ipc-contract'
import { computed, ref } from 'vue'
import { openDirectoryWithFeedback } from './use-app-config'

/**
 * FFmpeg 环境状态与修复动作的唯一入口（启动门禁 Initialize 与设置页共用）。
 *
 * 三条约定：
 * - 就绪判定只由主进程给出（window.mainAPI.getFfmpegStatus），本模块仅消费结构化结果。
 *   启动页、设置页、下载前校验共用同一次判定口径，杜绝「启动认为就绪、使用时才发现缺失」。
 * - 下载与选择目录都以「校验通过 → 写入配置」为完成条件，调用方只需看返回结果，
 *   不会出现「配置指向一个不可用目录」的中间态。
 * - 用户可见文案全部由 describeFfmpegProblem 产出，同一状态在启动页与设置页说法一致。
 *
 * ★ 跨进程：getFfmpegStatus / setConfig 对端是 main/ipc/register-system-ipc.ts、
 * main/ipc/register-database-ipc.ts；判定口径在 main/ffmpeg/ffmpeg-process.ts 的 inspectFfmpegDir；
 * downloadFfmpeg 与下载进度事件对端是 main/ffmpeg/ffmpeg-download.ts。
 */

/** 不可用状态的用户文案：同一原因只有一处说法，避免启动页与设置页各写一套 */
export interface FfmpegProblemCopy {
  /** 状态短标签（设置页徽章、错误提示前缀） */
  label: string
  /** 引导标题 */
  title: string
  /** 补充说明（含失效路径等细节） */
  hint: string
  /** 下一步动作短语，用于拼「请在「设置」中 X」 */
  action: string
}

/**
 * 状态 → 文案（纯函数，可单测）。三类不可用的修复动作不同，必须分开描述：
 * 未配置要引导配置；目录不存在多因目录被移动/删除；缺二进制多因手选错了目录。
 */
export function describeFfmpegProblem(problem: FfmpegProblem | null, directory = ''): FfmpegProblemCopy {
  switch (problem) {
    case 'missing-dir':
      return {
        label: '目录不存在',
        title: 'FFmpeg 目录已失效',
        hint: `已配置的目录不存在或已被移动：${directory}。请重新下载，或选择 FFmpeg 所在目录。`,
        action: '重新下载或选择 FFmpeg 目录',
      }
    case 'missing-binary':
      return {
        label: '缺少 ffmpeg',
        title: '该目录下没有 FFmpeg',
        hint: `目录 ${directory} 存在，但其中没有 ffmpeg 可执行文件。请重新下载，或选择包含 ffmpeg 的目录。`,
        action: '重新下载或选择 FFmpeg 目录',
      }
    case 'unset':
      return {
        label: '未配置',
        title: '请下载或选择 FFmpeg 目录',
        hint: '播放直播/回放与媒体下载都需要 FFmpeg。可一键下载，也可以手动指定本机已有的目录。',
        action: '下载或选择 FFmpeg 目录',
      }
    default:
      return { label: 'FFmpeg 检测ok 👌', title: 'FFmpeg 环境就绪', hint: '', action: '' }
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 选择目录的结果：invalid 带回该目录的判定，failed 表示流程本身出错（调用方各自提示） */
export type FfmpegChooseResult
  = | { outcome: 'ok' }
    | { outcome: 'canceled' }
    | { outcome: 'failed' }
    | { outcome: 'invalid', status: FfmpegStatus }

export function useFfmpegSetup() {
  /** 最近一次判定结果；null 表示尚未取到（首屏）或判定本身失败（配置读取中断等） */
  const status = ref<FfmpegStatus | null>(null)
  const checking = ref(false)
  const downloading = ref(false)
  const receivedBytes = ref(0)
  const totalBytes = ref(0)
  /** 下载期间挂上的进度订阅注销函数；只在 download() 生命周期内持有 */
  let unsubscribeProgress: (() => void) | null = null

  const busy = computed(() => checking.value || downloading.value)
  const isReady = computed(() => status.value?.ok === true)
  const problem = computed<FfmpegProblem | null>(() => (status.value && !status.value.ok ? status.value.problem : null))
  const directory = computed(() => status.value?.directory ?? '')
  const copy = computed(() => describeFfmpegProblem(problem.value, directory.value))

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

  /**
   * 取回就绪状态。省略 dir 时校验当前生效配置，传入时校验指定目录。
   * 判定失败返回 null：调用方据此显示失败态，不要把它当成「环境不可用」。
   */
  async function refresh(dir?: string): Promise<FfmpegStatus | null> {
    checking.value = true
    try {
      status.value = await window.mainAPI.getFfmpegStatus(dir)
    }
    catch (e) {
      console.error('[useFfmpegSetup] 获取 FFmpeg 状态失败:', e)
      status.value = null
    }
    finally {
      checking.value = false
    }
    return status.value
  }

  /** 一键下载 → 校验 → 写入配置；返回是否已就绪（失败时 status 保持原值，便于继续展示修复引导） */
  async function download(): Promise<boolean> {
    if (busy.value)
      return false
    receivedBytes.value = 0
    totalBytes.value = 0
    downloading.value = true
    unsubscribeProgress = window.mainAPI.onFfmpegDownloadProgress((p) => {
      receivedBytes.value = p.received
      totalBytes.value = p.total
    })
    try {
      const dir = await window.mainAPI.downloadFfmpeg()
      const next = await window.mainAPI.getFfmpegStatus(dir)
      // 校验通过才写配置：否则下次启动又会拿一个不可用目录静默放行
      if (!next.ok)
        throw new Error(`下载产物未通过校验（${next.problem ?? 'unknown'}）`)
      await window.mainAPI.setConfig('ffmpegDirectory', next.directory)
      status.value = next
      return true
    }
    catch (e) {
      console.error('[useFfmpegSetup] 下载 FFmpeg 失败:', e)
      return false
    }
    finally {
      downloading.value = false
      unsubscribeProgress?.()
      unsubscribeProgress = null
    }
  }

  /**
   * 选择目录 → 校验 → 写入配置。
   * 校验不通过时不覆盖 status（避免一次误选就把原本可用的环境显示成不可用），
   * 而是把该目录的判定随结果交回调用方说明原因。
   */
  async function choose(): Promise<FfmpegChooseResult> {
    if (busy.value)
      return { outcome: 'canceled' }
    checking.value = true
    try {
      const dir = await window.mainAPI.selectDirectory()
      if (!dir)
        return { outcome: 'canceled' }
      const next = await window.mainAPI.getFfmpegStatus(dir)
      if (!next.ok)
        return { outcome: 'invalid', status: next }
      await window.mainAPI.setConfig('ffmpegDirectory', next.directory)
      status.value = next
      return { outcome: 'ok' }
    }
    catch (e) {
      console.error('[useFfmpegSetup] 设置 FFmpeg 目录失败:', e)
      return { outcome: 'failed' }
    }
    finally {
      checking.value = false
    }
  }

  /** 打开已配置的 FFmpeg 目录（空目录与主进程拒绝都给可见反馈） */
  function openDirectory() {
    return openDirectoryWithFeedback(directory.value, 'FFmpeg 目录')
  }

  return {
    status,
    checking,
    downloading,
    busy,
    isReady,
    problem,
    directory,
    copy,
    downloadPercent,
    downloadLabel,
    refresh,
    download,
    choose,
    openDirectory,
  }
}
