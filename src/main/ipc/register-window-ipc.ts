/**
 * 窗口控制与系统休眠阻止的 IPC 通道注册。
 *
 * 窗口控制一律作用于「发起请求的窗口」（BrowserWindow.fromWebContents(event.sender)）：
 * 主窗口与独立播放窗共用同一组通道，原先恒取主窗口会让播放窗的关闭按钮关掉主窗口。
 * 休眠阻止状态（sleepBlockers）归 app.ts 管理，这里只做通道到函数的接线。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow } from 'electron'
import { allowSleepForSender, preventSleepForSender } from '../app'
import { handleTraced } from './trace'

function senderWindow(event: IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowIPC(): void {
  // 自定义标题栏窗口控制
  handleTraced('windowMinimize', (event) => {
    senderWindow(event)?.minimize()
  })
  handleTraced('windowToggleMaximize', (event) => {
    const win = senderWindow(event)
    if (!win)
      return
    if (win.isMaximized())
      win.unmaximize()
    else
      win.maximize()
  })
  handleTraced('windowClose', (event) => {
    senderWindow(event)?.close()
  })
  handleTraced('windowIsMaximized', (event) => {
    return senderWindow(event)?.isMaximized() ?? false
  })

  // 阻止/允许系统休眠：id 由主进程按 webContents 维护，
  // 渲染进程刷新或崩溃时无法回传 id，只能以 event.sender 为准
  handleTraced('preventSleep', event => preventSleepForSender(event.sender))
  handleTraced('allowSleep', (event, _id: number) => {
    allowSleepForSender(event.sender)
  })
}
