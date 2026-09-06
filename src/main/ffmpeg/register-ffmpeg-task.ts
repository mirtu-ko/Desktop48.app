import type { IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { isAllowedStreamUrl } from '../allowed-hosts'
import { Database } from '../database'
import { handleTraced } from '../ipc/trace'
import { log, warn } from '../logger'
import { FfmpegProcess, hasFfmpegSlot, MAX_CONCURRENT_FFMPEG_TASKS, resolveFfmpegBinary } from './ffmpeg-process'
import { nextAvailablePath } from './output-path'
import { TaskRegistry } from './task-registry'

interface FfmpegTaskConfig {
  /** IPC 通道名前缀，如 'downloadTask' / 'recordTask' */
  channelPrefix: string
  /** 日志前缀，如 'download.ts' / 'record.ts' */
  logTag: string
  /** ffmpeg 输出参数（位于 '-c copy' 之后、输出文件之前） */
  ffmpegArgs: string[]
}

/**
 * 注册一组由 ffmpeg 承担的任务 IPC 通道：
 * `${prefix}Start`(invoke) / `${prefix}Progress|End|Error`(send) / `${prefix}Stop:${liveId}`(once) / `${prefix}List|Remove`(invoke)
 *
 * 编排职责划分：目录/二进制校验、并发熔断、文件冲突检测、进程生命周期在这里串起来；
 * 进程细节在 ffmpeg-process.ts，状态在 task-registry.ts，冲突序号在 output-path.ts。
 */
export function registerFfmpegTask(config: FfmpegTaskConfig): void {
  const { channelPrefix, logTag, ffmpegArgs } = config
  const registry = new TaskRegistry()

  // 查询当前所有任务快照，供渲染端刷新后恢复列表
  handleTraced(`${channelPrefix}List`, () => registry.list())
  // 从快照表删除任务（对应渲染端移除卡片）
  handleTraced(`${channelPrefix}Remove`, (_event: IpcMainInvokeEvent, liveId: string) => {
    registry.remove(liveId)
  })

  handleTraced(`${channelPrefix}Start`, async (event: IpcMainInvokeEvent, url: string, filename: string, liveId: string) => {
    // 输入地址白名单：url 直接交给 ffmpeg（-i），不经校验会形成 netRequest 之外的安全旁路
    if (!isAllowedStreamUrl(url))
      throw new Error(`任务源地址不在允许范围内: ${url}`)
    // 保存目录与 ffmpeg 二进制校验
    const saveDir: string = Database.instance().getConfig('downloadDirectory', '') as string
    if (!fs.existsSync(saveDir))
      throw new Error('保存目录不存在')
    const ffmpegDir: string = Database.instance().getConfig('ffmpegDirectory', '') as string
    if (!fs.existsSync(ffmpegDir))
      throw new Error('ffmpeg 目录不存在')
    const ffmpegPath = resolveFfmpegBinary(ffmpegDir)
    // 全局并发熔断：达到上限直接拒绝（错误经 IPC 抛回渲染端，use-tasks 会用 ElMessage 展示）
    if (!hasFfmpegSlot()) {
      throw new Error(`下载/录制任务已达并发上限（${MAX_CONCURRENT_FFMPEG_TASKS}），请先停止或等待部分任务完成`)
    }
    // 文件冲突保护：仅"同一任务重启"允许覆盖自己上次写的文件（渲染端重启语义即为覆盖原文件）；
    // 其余任何冲突（如同分钟内对同一成员重复发起下载）一律自动追加序号，杜绝静默覆盖已下载内容
    const intendedPath = path.join(saveDir, filename)
    const isRestartOfSameTask = registry.get(liveId)?.filePath === intendedPath
    const filePath = isRestartOfSameTask
      ? intendedPath
      : nextAvailablePath(intendedPath, p => fs.existsSync(p))
    if (filePath !== intendedPath)
      log(`[${logTag}]目标文件已存在，自动改用新文件名`, filePath)
    // 同一 liveId 上一进程可能仍在优雅退出（写文件尾），等待其完全退出后再启动
    await registry.waitForClose(liveId)

    // 窗口销毁后不能再用 event.sender.send，否则会抛 "Object has been destroyed"
    const safeSend = (channel: string, ...args: unknown[]) => {
      if (!event.sender.isDestroyed())
        event.sender.send(channel, ...args)
    }
    // 外部 stop：向 ffmpeg stdin 写 'q' 优雅退出（once 监听器在 close 时显式移除，
    // 避免同 liveId 多次重启导致监听器无限累积）。
    // 先于 proc 声明：onClose 回调需要引用它们做监听器清理
    const stopChannel = `${channelPrefix}Stop:${liveId}`
    let activeProcess: FfmpegProcess | null = null
    const stopListener = () => {
      const proc = activeProcess
      if (!proc?.running)
        return
      if (proc.gracefulStop())
        log(`[${logTag}]task stopped by user (graceful)`, liveId)
      else
        warn(`[${logTag}]graceful stop failed, fallback to kill`, liveId)
    }
    const proc = new FfmpegProcess({
      ffmpegPath,
      url,
      ffmpegArgs,
      filePath,
      handlers: {
        onProgress: time => safeSend(`${channelPrefix}Progress`, liveId, time),
        onStderr: message => log(`[${logTag}]ffmpeg stderr(no match):`, message.trim()),
        onError: (err) => {
          const errMsg = `[${logTag}]ffmpeg error: ${err.message}`
          registry.clearClose(liveId)
          registry.markError(liveId, errMsg)
          safeSend(`${channelPrefix}Error`, liveId, errMsg)
        },
        onClose: (code, signal) => {
          ipcMain.removeListener(stopChannel, stopListener)
          registry.clearClose(liveId)
          // 正常结束（含用户 stop，SIGINT）记为 finish，异常退出记为 error
          if (code === 0 || signal === 'SIGINT') {
            log(`[${logTag}]spawn ffmpeg end`, liveId, filePath)
            registry.markFinish(liveId)
            safeSend(`${channelPrefix}End`, liveId, filePath)
          }
          else {
            const errMsg = `[${logTag}]ffmpeg exited with code ${code}`
            registry.markError(liveId, errMsg)
            safeSend(`${channelPrefix}Error`, liveId, errMsg)
          }
        },
      },
    })
    log(`[${logTag}]spawn ffmpeg start`, filePath)
    registry.registerClose(liveId, proc.closePromise)
    activeProcess = proc
    // 记录任务快照（running），冲突保护可能已改用带序号的新文件名，快照以实际路径为准
    registry.put({
      liveId,
      url,
      filename: path.basename(filePath),
      filePath,
      saveDirectory: saveDir,
      status: 'running',
      startedAt: Date.now(),
    })

    ipcMain.once(stopChannel, stopListener)

    // IPC 调用只表示 ffmpeg 已成功启动；任务结束由 End/Error 通道通知。
    return new Promise<string>((resolve, reject) => {
      proc.child.once('spawn', () => resolve(filePath))
      proc.child.once('error', (err) => {
        reject(new Error(`[${logTag}]ffmpeg error: ${err.message}`))
      })
    })
  })
}

// 具体任务通道组（downloadTask / recordTask）的配置与注册在 ipc/register-task-ipc.ts，
// 本模块只提供通用工厂，不再自带副作用调用。
