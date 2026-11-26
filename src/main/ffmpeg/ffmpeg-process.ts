import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { error } from '../logger'

/**
 * 全局并发上限（下载 + 录制两组任务共用）：
 * ffmpeg 转封装/录制很吃 CPU、磁盘与带宽，无上限时用户连点 N 个回放就会
 * 同时跑 N 个进程拖垮机器。同 liveId 的串行保护在 TaskRegistry（closePromise），
 * 这里做跨任务全局熔断
 */
export const MAX_CONCURRENT_FFMPEG_TASKS = 5

/** 所有运行中的 ffmpeg 任务进程（跨任务实例共享），供应用退出时统一优雅收尾 */
const activeProcesses = new Set<FfmpegProcess>()

/**
 * 应用退出时对所有 ffmpeg 写 'q' 优雅收尾；
 * 子进程会独立完成文件尾写入后自行退出，避免残留孤儿进程。
 * gracefulStop 内含超时强杀兜底，网络栈 hang 等场景下不会永久卡住
 */
export function stopAllFfmpegTasks(): void {
  for (const proc of activeProcesses) {
    try {
      proc.gracefulStop()
    }
    catch {
      // stdin 已关闭等场景忽略，进程即将随应用生命周期结束
    }
  }
}

/** 是否还有并发余量（达到上限时调用方应拒绝新任务并提示） */
export function hasFfmpegSlot(): boolean {
  return activeProcesses.size < MAX_CONCURRENT_FFMPEG_TASKS
}

/** FFmpeg 不可用的原因分类：渲染层据此外化不同的修复引导，不要用错误文案反向判断 */
export type FfmpegProblem = 'unset' | 'missing-dir' | 'missing-binary'

/** 生效来源：显式目录（用户配置或一键下载） / 系统安装（Linux 包管理器） */
export type FfmpegSource = 'directory' | 'system'

/**
 * FFmpeg 就绪状态：主进程是唯一判定方。
 * 渲染层（启动门禁 / 设置页 / 下载前校验）只消费该结构，不再各自 existsSync 一遍，
 * 避免「启动认为就绪、使用时才发现二进制缺失」这类口径分歧。
 */
export interface FfmpegStatus {
  ok: boolean
  /** ok 为 true 时恒为 null */
  problem: FfmpegProblem | null
  /** 当前生效的目录；未配置时为空串 */
  directory: string
  /** 校验通过时的可执行文件完整路径；未通过时为空串 */
  binaryPath: string
  /** 本次判定对应的来源 */
  source: FfmpegSource
  /** 当前平台是否支持一键下载（Linux 静态构建有 glibc DNS 缺陷，不支持一键下载） */
  canDownload?: boolean
}

/** 平台相关的可执行文件名拼装，唯一取值点（状态判定 / 二进制解析 / 下载落盘共用） */
export function ffmpegBinaryPath(ffmpegDir: string): string {
  return path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

/** 判定目录是否构成可用的 FFmpeg 环境（纯函数，可单测）：逐层区分未配置 / 目录不存在 / 缺二进制 */
export function inspectFfmpegDir(ffmpegDir: string): FfmpegStatus {
  const canDownload = process.platform !== 'linux'
  const directory = ffmpegDir?.trim() ?? ''
  if (!directory)
    return { ok: false, problem: 'unset', directory: '', binaryPath: '', source: 'directory', canDownload }
  if (!fs.existsSync(directory))
    return { ok: false, problem: 'missing-dir', directory, binaryPath: '', source: 'directory', canDownload }
  const binaryPath = ffmpegBinaryPath(directory)
  if (!fs.existsSync(binaryPath))
    return { ok: false, problem: 'missing-binary', directory, binaryPath: '', source: 'directory', canDownload }
  return { ok: true, problem: null, directory, binaryPath, source: 'directory', canDownload }
}

/**
 * 系统 ffmpeg 的兜底搜索位置：PATH 之外再试两个常见安装点。
 * 从 .desktop 启动时拿到的 PATH 可能不含 /usr/local/bin，只靠 PATH 会漏。
 */
const SYSTEM_FFMPEG_FALLBACK_DIRS = ['/usr/local/bin', '/usr/bin']

/** 存在 + 普通文件 + 有执行位；断链或权限不足一律视为不可用 */
function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  }
  catch {
    return false
  }
}

export interface SystemFfmpegProbeOptions {
  /** 被测平台，默认 process.platform */
  platform?: NodeJS.Platform
  /** 搜索路径串，默认 process.env.PATH */
  pathValue?: string
  /** 可执行判定，默认查 X_OK（单测注入） */
  isExecutable?: (candidate: string) => boolean
}

/**
 * 探测 Linux 包管理器安装的 ffmpeg（deb 的 depends 保证它存在）。
 *
 * 只在 linux 上探测：macOS / Windows 的下载产物没有下文的静态 glibc 缺陷，
 * 多一条来源只会让「用的是哪个 ffmpeg」变得不可预测。
 *
 * 为什么需要它：下载产物是 glibc 静态链接，域名解析要 dlopen libnss_dns.so.2，
 * 而静态程序没有动态加载器 —— 普通发行版上 getaddrinfo 返回 EAI_SYSTEM，
 * ChromeOS Crostini 容器里直接 SIGSEGV（详见 docs/live-playback-pipeline.md）。
 * 系统版是动态链接，与容器 ABI 一致，不存在这条路径。
 */
export function findSystemFfmpeg(options: SystemFfmpegProbeOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'linux')
    return null
  const isExecutable = options.isExecutable ?? isExecutableFile
  const pathValue = options.pathValue ?? process.env.PATH ?? ''
  const dirs = [...new Set([...pathValue.split(path.delimiter), ...SYSTEM_FFMPEG_FALLBACK_DIRS].filter(Boolean))]
  for (const dir of dirs) {
    const candidate = path.join(dir, 'ffmpeg')
    if (isExecutable(candidate))
      return candidate
  }
  return null
}

/**
 * 实际生效的 FFmpeg 环境：显式目录可用就用它；否则 linux 回落到系统 ffmpeg；
 * 两者都没有时原样返回显式目录的判定，让渲染层展示具体原因（不掩盖用户配错的路径）。
 *
 * 优先级刻意如此：用户显式指定 > 系统安装。下载目录不参与这里 —— 它下载后会被写进
 * ffmpegDirectory，本身就是一个「显式目录」，不另开来源，避免判定口径分裂。
 */
export function resolveFfmpegEnvironment(
  configuredDir: string,
  probe: () => string | null = findSystemFfmpeg,
): FfmpegStatus {
  const status = inspectFfmpegDir(configuredDir)
  if (status.ok)
    return status
  const systemBinary = probe()
  if (!systemBinary)
    return status
  return { ok: true, problem: null, directory: path.dirname(systemBinary), binaryPath: systemBinary, source: 'system', canDownload: false }
}

/** 各类不可用原因对应的失败信息：与 inspectFfmpegDir 同一口径 */
const RESOLVE_ERROR_MESSAGE: Record<FfmpegProblem, string> = {
  'unset': '尚未设置 ffmpeg 目录',
  'missing-dir': 'ffmpeg 目录不存在',
  'missing-binary': 'ffmpeg 二进制文件不存在',
}

/** 校验 ffmpeg 二进制并返回完整路径（Windows 下补 .exe）；不可用时抛错，供任务/拉流链路快速失败 */
export function resolveFfmpegBinary(configuredDir: string, probe: () => string | null = findSystemFfmpeg): string {
  const status = resolveFfmpegEnvironment(configuredDir, probe)
  if (!status.ok)
    throw new Error(RESOLVE_ERROR_MESSAGE[status.problem ?? 'missing-binary'])
  return status.binaryPath
}

const TIME_REGEX = /time=(\d+:\d+:\d+\.\d+)/

/**
 * 写 'q' 后等待进程自行收尾（写文件尾）的期限；超时视为进程卡死，强杀兜底。
 * 正常情况下 ffmpeg 写完文件尾毫秒级退出；任务要写 MP4 moov 等文件尾，
 * 比 stream.ts 的纯管道转流耗时略长，给到 5 秒宽裕期限。
 */
const GRACEFUL_STOP_TIMEOUT_MS = 5000

/** 从 ffmpeg stderr 输出里解析进度时间（无匹配返回 null）——纯函数，可单测 */
export function parseProgressTime(message: string): string | null {
  return TIME_REGEX.exec(message)?.[1] ?? null
}

export interface FfmpegProcessHandlers {
  /** stderr 匹配到 time=xx:xx:xx.xx 的进度行 */
  onProgress?: (time: string) => void
  /** 未匹配的 stderr 输出（调试用） */
  onStderr?: (message: string) => void
  /** spawn 失败（ffmpeg 可执行文件损坏、参数错误等） */
  onError?: (err: Error) => void
  /** 进程退出；SIGINT 视为正常收尾 */
  onClose?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * 单个 ffmpeg 子进程的封装：spawn、stderr 解析、优雅退出、退出 Promise。
 * 进程创建即进入全局 activeProcesses 表（供并发计数与应用退出收尾），
 * close/error 时自动移出——spawn 失败可能不触发 close，error 也一并清理，
 * 否则并发计数与同任务重启会永久挂起。
 */
export class FfmpegProcess {
  readonly child: ChildProcess
  /** 进程完全退出（含写文件尾收尾）后 resolve */
  readonly closePromise: Promise<void>

  constructor(options: {
    ffmpegPath: string
    url: string
    ffmpegArgs: string[]
    filePath: string
    handlers?: FfmpegProcessHandlers
  }) {
    const { ffmpegPath, url, ffmpegArgs, filePath, handlers = {} } = options
    // 输出参数由具体任务（MP4 转封装 / FLV 录制）提供，位于 '-c copy' 之后、输出文件之前
    this.child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'info',
      '-y',
      '-i',
      url,
      '-c',
      'copy',
      ...ffmpegArgs,
      filePath,
    ])
    activeProcesses.add(this)
    this.child.once('close', () => activeProcesses.delete(this))
    this.closePromise = new Promise<void>((resolve) => {
      this.child.once('close', () => resolve())
    })

    // 解析 stderr 中的进度信息；Windows 上 kill('SIGINT') 是强杀、来不及写文件尾，
    // 优雅退出统一走 writeQuit()（写 'q' 让 ffmpeg 自己收尾）
    this.child.stderr?.on('data', (chunk) => {
      const message = chunk.toString()
      const time = parseProgressTime(message)
      if (time)
        handlers.onProgress?.(time)
      else
        handlers.onStderr?.(message)
    })
    this.child.once('error', (err) => {
      error('[ffmpeg-process]spawn ffmpeg error', err)
      activeProcesses.delete(this)
      handlers.onError?.(err)
    })
    this.child.on('close', (code, signal) => {
      handlers.onClose?.(code, signal)
    })
  }

  /** 进程是否仍在运行 */
  get running(): boolean {
    return !this.child.killed && this.child.exitCode === null
  }

  /**
   * 优雅退出：向 stdin 写 'q'，ffmpeg 独立完成文件尾写入（MP4 moov atom /
   * FLV onMetaData）后自行退出。返回是否走了优雅路径；写失败时回退 SIGINT 强杀。
   * 写 'q' 成功不代表进程会退出：网络栈 hang 等场景下 ffmpeg 可能永不收尾，
   * 必须挂超时强杀兜底（与 stream.ts 的直播转流进程同一失败模式），
   * 否则挂死进程会永久占用并发槽、同任务重启挂起、应用退出时残留孤儿进程。
   */
  gracefulStop(): boolean {
    if (!this.running)
      return false
    try {
      this.child.stdin?.write('q')
      this.scheduleForceKill()
      return true
    }
    catch (e) {
      // 写 q 失败（stdin 已关闭 / 管道断开）只能回退到信号终止；
      // 不打日志的话，上层只会看到「停止失败已强杀」，看不到真正的原因
      error('[ffmpeg-process] 写 q 失败，回退 SIGINT:', e)
      this.child.kill('SIGINT')
      return false
    }
  }

  /** 超时未自行退出则强杀兜底；正常退出（close）时取消 */
  private scheduleForceKill(): void {
    const timer = setTimeout(() => {
      if (!this.running)
        return
      error('[ffmpeg-process]ffmpeg 优雅退出超时，强制结束进程')
      try {
        this.child.kill('SIGKILL')
      }
      catch (err) {
        error('[ffmpeg-process]强制结束 ffmpeg 失败:', err)
      }
    }, GRACEFUL_STOP_TIMEOUT_MS)
    timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
}
