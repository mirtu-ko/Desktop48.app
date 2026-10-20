/** Windows 系统托盘：常驻托盘 + 右键菜单「显示主窗口 / 退出」，仅 Windows 创建 */

import { app, Menu, Tray } from 'electron'
import { log } from './logger'

/** Windows 托盘实例（模块级持有防 GC 回收）；非 Windows 恒为 null，各处据此 no-op */
let tray: Tray | null = null

export interface TrayHandlers {
  /** 显示 / 聚焦主窗口（点托盘图标或菜单「显示主窗口」时调用） */
  showWindow: () => void
}

/** Windows 托盘是否已创建（供 app.ts 的 window-all-closed 判断是否保持常驻） */
export function isTrayActive(): boolean {
  return tray !== null
}

/**
 * 创建 Windows 托盘；非 Windows 或已存在则为 no-op。
 * iconPath 由调用方以 `?asset` 传入：本模块需被纯 Node 单测静态加载，不能自行引用 `?asset`
 */
export function installTray(iconPath: string, handlers: TrayHandlers): void {
  if (process.platform !== 'win32' || tray)
    return
  tray = new Tray(iconPath)
  tray.setToolTip('Desktop48')
  // 左键单击：直接恢复主窗口（与右键菜单「显示主窗口」同一条路径）
  tray.on('click', () => handlers.showWindow())
  rebuildMenu(handlers)
  log('[tray] Windows 系统托盘已创建')
}

/** 重建托盘右键菜单 */
function rebuildMenu(handlers: TrayHandlers): void {
  if (!tray)
    return
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => handlers.showWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

/** 应用退出前销毁托盘，避免退出后悬挂空的托盘图标 */
export function destroyTray(): void {
  if (!tray)
    return
  tray.destroy()
  tray = null
  log('[tray] Windows 系统托盘已销毁')
}

/** 更新托盘未读提示（写入 tooltip） */
export function setTrayUnread(total: number): void {
  if (!tray || total < 0)
    return
  tray.setToolTip(total > 0 ? `Desktop48 · 未读 ${total}` : 'Desktop48')
}
