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

/** 校验 ffmpeg 二进制并返回完整路径（Windows 下补 .exe） */
export function resolveFfmpegBinary(ffmpegDir: string): string {
  const ffmpegPath = path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (!fs.existsSync(ffmpegPath))
    throw new Error('ffmpeg 二进制文件不存在')
  return ffmpegPath
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
      this.child.kill('SIGINT')
      void e
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
