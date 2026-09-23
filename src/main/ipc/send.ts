import type { WebContents } from 'electron'
import type { IpcEventArgs, IpcEventChannel } from '../../preload/ipc-contract'

/** 类型化事件发送；通道与参数由 IpcEventMap 约束，webContents 销毁后静默跳过。 */
export function sendIpc<Channel extends IpcEventChannel>(
  sender: WebContents,
  channel: Channel,
  ...args: IpcEventArgs<Channel>
): void {
  if (!sender.isDestroyed())
    sender.send(channel, ...args)
}
