/**
 * Windows 系统托盘（方案 B）：常驻托盘 + 右键菜单「显示主窗口 / 退出」。
 *
 * 范围只覆盖 Windows —— macOS 继续沿用 Dock 行为，Linux 保持现状（用户需求只提 Windows）。
 * 托盘图标必须在模块级持有一份引用，否则会被 GC 回收导致托盘图标消失；
 * 真正退出只能走托盘「退出」或系统退出（app.ts 的 before-quit 在此前置 isQuitting 并销毁托盘）。
 *
 * 未读角标：主进程已有 app.setBadgeCount（Windows 任务栏叠加数字）；托盘侧把未读量写进
 * tooltip（hover 可见），随 main/pocket48/pocket-unread.ts 的 publish 实时更新。
 */
import { app, Menu, Tray } from 'electron'
import { log } from './logger'

/** Windows 托盘实例；非 Windows 平台恒为 null（全模块各处据此 no-op） */
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
 * iconPath 由调用方（app.ts）用 `?asset` 传入，避免本模块被纯 Node 单测加载时踩到
 * electron-vite 的 `?asset` 构建专属修饰符。
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

/** 重建托盘右键菜单（图标状态 / 菜单项变化时调用） */
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

/** 更新托盘未读提示：数量经 tooltip 展示（图标本身由 ICO 承载多尺寸，不额外换图） */
export function setTrayUnread(total: number): void {
  if (!tray || total < 0)
    return
  tray.setToolTip(total > 0 ? `Desktop48 · 未读 ${total}` : 'Desktop48')
}
