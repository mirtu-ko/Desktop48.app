/**
 * 窗口状态 → 渲染端的事件接线（最大化 / 还原）与 Linux 重绘兜底；
 * 主窗口与独立播放窗共用（两者都是无边框 + 自定义标题栏）。
 * ⚠️ 用 sendIpc 而非 broadcastIpc：最大化状态是每个窗口各自的，广播会串窗。
 */
import type { BrowserWindow } from 'electron'
import { sendIpc } from '../ipc/send'

/** 合成器把窗口拉伸到新尺寸后才重建表面，留一帧以上的余量再补重绘 */
const REPAINT_DELAY = 120

/**
 * 强制整窗重绘。
 *
 * ChromeOS 的 Sommelier 在最大化 / 全屏切换时偶尔只把旧表面拉伸到新尺寸，
 * 客户端收不到新的绘制请求，画面就停在拉伸后的旧帧上（表现为「内容被拉变形」）。
 * invalidate 与是否真的换了尺寸无关，只是重排一次绘制，故对未换尺寸的窗口也是无害的。
 * 只在 Linux 上挂：其他平台的合成器没这个毛病，不必多耗一次全窗重绘。
 */
function scheduleRepaint(win: BrowserWindow): void {
  if (process.platform !== 'linux')
    return
  setTimeout(() => {
    if (!win.isDestroyed())
      win.webContents.invalidate()
  }, REPAINT_DELAY)
}

/** 把该窗口的最大化 / 还原 / 全屏变化推给它自己的渲染进程，并在 Linux 上补一次重绘 */
export function wireWindowStateEvents(win: BrowserWindow): void {
  const send = () => sendIpc(win.webContents, 'windowOnMaximizeChange', win.isMaximized())
  win.on('maximize', () => {
    send()
    scheduleRepaint(win)
  })
  win.on('unmaximize', () => {
    send()
    scheduleRepaint(win)
  })
  // 全屏同样会换尺寸：独立播放窗的容器全屏由 Electron 转成窗口级全屏，走这里
  win.on('enter-full-screen', () => scheduleRepaint(win))
  win.on('leave-full-screen', () => scheduleRepaint(win))
}
