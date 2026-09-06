/**
 * 窗口控制与系统休眠阻止的 IPC 通道注册。
 *
 * 窗口引用（mainWindow）与休眠阻止状态（sleepBlockers）的生命周期归 app.ts 管理，
 * 这里只做通道到函数的接线；两处状态都不跨模块共享，避免 IPC 层持有可变全局态。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { WebContents } from 'electron'
import { activeWindow, allowSleepForSender, preventSleepForSender } from '../app'
import { handleTraced } from './trace'

export function registerWindowIPC(): void {
  // 自定义标题栏窗口控制
  handleTraced('windowMinimize', () => activeWindow()?.minimize())
  handleTraced('windowToggleMaximize', () => {
    const win = activeWindow()
    if (!win)
      return
    if (win.isMaximized())
      win.unmaximize()
    else
      win.maximize()
  })
  handleTraced('windowClose', () => activeWindow()?.close())
  handleTraced('windowIsMaximized', () => activeWindow()?.isMaximized() ?? false)

  // 阻止/允许系统休眠：id 由主进程按 webContents 维护，
  // 渲染进程刷新或崩溃时无法回传 id，只能以 event.sender 为准
  handleTraced('preventSleep', (event) => {
    return preventSleepForSender(event.sender as WebContents)
  })
  handleTraced('allowSleep', (event, _id: number) => {
    allowSleepForSender(event.sender as WebContents)
  })
}
