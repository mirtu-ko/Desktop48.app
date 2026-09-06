/**
 * IPC invoke 通道的 verbose 追踪包装器。
 *
 * 新人理解这个项目最大的障碍是「渲染层调了一个 API，主进程到底发生了什么」。
 * handleTraced 在 verbose 模式下为每个 invoke 通道记录：通道名、参数摘要、耗时、成功/失败，
 * 使完整调用流在 main.log / DevTools 控制台里可直接观察，无需逐层打断点。
 *
 * 生产环境（verbose 关闭）直接透传 ipcMain.handle，零额外开销。
 * 仅覆盖 invoke（请求-响应）通道；send/once 类单向通知由各业务模块自行记日志。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import { debug, isVerboseEnabled } from '../logger'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

const MAX_ARG_PREVIEW = 200

/** 参数摘要：截断长字符串与大对象，避免 verbose 日志被 payload 淹没 */
function summarizeArgs(args: unknown[]): string {
  if (args.length === 0)
    return ''
  return args
    .map((a) => {
      if (typeof a === 'string')
        return a.length > MAX_ARG_PREVIEW ? `"${a.slice(0, MAX_ARG_PREVIEW)}…"` : JSON.stringify(a)
      if (a === undefined || a === null || typeof a === 'number' || typeof a === 'boolean')
        return String(a)
      try {
        const json = JSON.stringify(a)
        return json && json.length > MAX_ARG_PREVIEW ? `${json.slice(0, MAX_ARG_PREVIEW)}…` : json
      }
      catch {
        return Object.prototype.toString.call(a)
      }
    })
    .join(', ')
}

export function handleTraced(channel: string, handler: InvokeHandler): void {
  if (!isVerboseEnabled()) {
    ipcMain.handle(channel, handler)
    return
  }

  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = performance.now()
    debug(`[ipc] → ${channel}(${summarizeArgs(args)})`)
    try {
      const result = await handler(event, ...args)
      debug(`[ipc] ← ${channel} ${(performance.now() - startedAt).toFixed(1)}ms`)
      return result
    }
    catch (err) {
      debug(`[ipc] ✕ ${channel} ${(performance.now() - startedAt).toFixed(1)}ms:`, err)
      throw err
    }
  })
}
