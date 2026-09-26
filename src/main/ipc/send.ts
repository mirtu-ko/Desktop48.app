import type { WebContents } from 'electron'
import type { IpcEventArgs, IpcEventChannel } from '../../preload/ipc-contract'
import { BrowserWindow } from 'electron'

/** 类型化事件发送；通道与参数由 IpcEventMap 约束，webContents 销毁后静默跳过。 */
export function sendIpc<Channel extends IpcEventChannel>(
  sender: WebContents,
  channel: Channel,
  ...args: IpcEventArgs<Channel>
): void {
  if (!sender.isDestroyed())
    sender.send(channel, ...args)
}

/**
 * 向所有窗口广播事件。
 *
 * 用于「状态由主进程统一持有、每个窗口各存一份镜像」的场景（如下载 / 录制任务：
 * 注册表在 main/ffmpeg/task-registry.ts，渲染端镜像在 stores/tasks.ts）。
 * 这类事件只回给发起方是不够的 —— 在独立播放窗发起的任务，
 * 主窗口的下载页就永远收不到它的状态变化。
 */
export function broadcastIpc<Channel extends IpcEventChannel>(
  channel: Channel,
  ...args: IpcEventArgs<Channel>
): void {
  for (const win of BrowserWindow.getAllWindows())
    sendIpc(win.webContents, channel, ...args)
}
