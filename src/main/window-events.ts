/**
 * 窗口状态 → 渲染端的事件接线（目前只有最大化 / 还原）；
 * 主窗口与独立播放窗共用（两者都是无边框 + 自定义标题栏）。
 * ⚠️ 用 sendIpc 而非 broadcastIpc：最大化状态是每个窗口各自的，广播会串窗。
 */
import type { BrowserWindow } from 'electron'
import { sendIpc } from './ipc/send'

/** 把该窗口的最大化 / 还原变化推给它自己的渲染进程 */
export function wireWindowMaximizeEvents(win: BrowserWindow): void {
  const send = () => sendIpc(win.webContents, 'windowOnMaximizeChange', win.isMaximized())
  win.on('maximize', send)
  win.on('unmaximize', send)
}
