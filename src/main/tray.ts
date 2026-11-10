/** 系统托盘 / macOS 菜单栏常驻：图标、未读房间列表与「显示主窗口 / 退出」菜单 */

import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { app, Menu, nativeImage, Tray } from 'electron'
import { log } from './logger'

/** 菜单里直接列出的房间数上限，其余收进「更多」子菜单 */
const MAX_ROOM_ITEMS = 4

/** 托盘实例（模块级持有防 GC 回收）；不支持托盘的平台恒为 null，各处据此 no-op */
let tray: Tray | null = null
/** 托盘菜单；macOS 未 setContextMenu，由左键 click 主动弹出 */
let contextMenu: Menu | null = null
/** 图标路径集合；未安装时 null */
let iconPaths: TrayIconPaths | null = null
/** 当前图片路径，用于跳过重复 setImage（未读状态变化时才真的换图） */
let currentPath: string | null = null
/** 未读房间明细（已按最新消息时间倒序），菜单与角标共用 */
let unreadRooms: TrayUnreadRoom[] = []
/** 已加载图片缓存，同一路径只读盘一次 */
const imageCache = new Map<string, NativeImage>()
/** 菜单点击回调；菜单随未读重建，回调留在此处供模板引用 */
let handlers: TrayHandlers | null = null

/**
 * 图标两张，macOS 都是纯黑 + alpha 的模板图：系统只取 alpha，按菜单栏自身的明暗反色，
 * 全屏变暗、自动模式、亮壁纸等场景都能跟上，无需主进程判断主题。
 * 两图画布与字形位置一致，切图时只有右上角圆点出现/消失。
 */
export interface TrayIconPaths {
  /** 无未读：只有「48」 */
  icon: string
  /** 有未读：「48」+ 右上角圆点 */
  unread?: string
}

/** 菜单里的一个未读房间；名称由未读服务从本地成员名录解析 */
export interface TrayUnreadRoom {
  userId: number
  name: string
  count: number
  /** 最新一条未读消息时刻（ms），用于排序 */
  latestTime: number
}

export interface TrayHandlers {
  /** 显示 / 聚焦主窗口（点托盘图标或菜单「显示主窗口」时调用） */
  showWindow: () => void
  /** 点未读房间：显示主窗口并打开该房间 */
  openRoom: (userId: number) => void
}

/** 托盘是否已创建（供 app.ts 的 window-all-closed 判断是否保持常驻） */
export function isTrayActive(): boolean {
  return tray !== null
}

/** 托盘只在 Windows（系统托盘）与 macOS（菜单栏）存在，其余平台不创建 */
function isTrayPlatform(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/** 读取图标；macOS 标为 template，Retina 的 `@2x` 由 createFromPath 按同目录同名自动挂载 */
function loadImage(path: string, template: boolean): NativeImage {
  const cached = imageCache.get(path)
  if (cached)
    return cached
  const image = nativeImage.createFromPath(path)
  if (template)
    image.setTemplateImage(true)
  imageCache.set(path, image)
  return image
}

/** 按未读选定图标；路径未变则不动，避免无谓重绘 */
function applyIcon(): void {
  if (!tray || !iconPaths)
    return
  const path = (unreadRooms.length > 0 && iconPaths.unread) || iconPaths.icon
  if (path === currentPath)
    return
  currentPath = path
  tray.setImage(loadImage(path, process.platform === 'darwin'))
}

/** 单个房间菜单项：显示名 + 未读条数，点击交给 app.ts 唤回并定位房间 */
function roomItem(room: TrayUnreadRoom): MenuItemConstructorOptions {
  return {
    label: `${room.name}（${room.count}）`,
    click: () => handlers?.openRoom(room.userId),
  }
}

/**
 * 托盘菜单：显示主窗口 / 未读房间列表 / 退出。
 * 未读超过 4 个时顶层列前 4 个，第 5 个起收进「更多」子菜单，
 * macOS 悬停即展开，Windows 点击展开。
 */
function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: '显示主窗口', click: () => handlers?.showWindow() },
    { type: 'separator' },
  ]
  if (!unreadRooms.length) {
    template.push({ label: '暂无未读消息', enabled: false })
  }
  else {
    const total = unreadRooms.reduce((sum, room) => sum + room.count, 0)
    template.push({ label: `未读消息（${total}）`, enabled: false })
    for (const room of unreadRooms.slice(0, MAX_ROOM_ITEMS))
      template.push(roomItem(room))
    if (unreadRooms.length > MAX_ROOM_ITEMS)
      template.push({ label: '更多', submenu: unreadRooms.slice(MAX_ROOM_ITEMS).map(roomItem) })
  }
  template.push(
    { type: 'separator' },
    { label: process.platform === 'darwin' ? '退出 Desktop48' : '退出', click: () => app.quit() },
  )
  return Menu.buildFromTemplate(template)
}

/** 未读变化后重建菜单：macOS 留着供左键弹出，Windows 需重新挂一次才生效 */
function refreshMenu(): void {
  if (!tray)
    return
  contextMenu = buildMenu()
  if (process.platform !== 'darwin')
    tray.setContextMenu(contextMenu)
}

/**
 * 创建托盘；不支持托盘的平台或已存在则为 no-op。
 * 图标路径由调用方以 `?asset` 传入：本模块需被纯 Node 单测静态加载，不能自行引用 `?asset`
 */
export function installTray(paths: TrayIconPaths, nextHandlers: TrayHandlers): void {
  if (!isTrayPlatform() || tray)
    return
  handlers = nextHandlers
  iconPaths = paths
  unreadRooms = []
  currentPath = paths.icon
  tray = new Tray(loadImage(paths.icon, process.platform === 'darwin'))
  tray.setToolTip('Desktop48')

  if (process.platform === 'darwin') {
    // 不 setContextMenu：设置后左右键都会被系统接管弹菜单，右键就分不出来了。
    // 双击会拆成两次左键，禁掉后双击仍是两次弹菜单
    tray.setIgnoreDoubleClickEvents(true)
    tray.on('click', () => {
      if (contextMenu)
        tray?.popUpContextMenu(contextMenu)
    })
    tray.on('right-click', () => handlers?.showWindow())
  }
  else {
    // Windows 左键唤回主窗口，右键菜单由 refreshMenu 的 setContextMenu 提供
    tray.on('click', () => handlers?.showWindow())
  }
  refreshMenu()
  log(`[tray] ${process.platform === 'darwin' ? 'macOS 菜单栏' : 'Windows 系统托盘'}已创建`)
}

/** 应用退出前销毁托盘，避免退出后悬挂空的托盘图标 */
export function destroyTray(): void {
  if (!tray)
    return
  tray.destroy()
  tray = null
  contextMenu = null
  iconPaths = null
  handlers = null
  currentPath = null
  unreadRooms = []
  imageCache.clear()
  log('[tray] 系统托盘已销毁')
}

/** 更新未读：角标、tooltip 与房间菜单一同刷新；房间明细由未读服务按最新消息时间排好序 */
export function setTrayUnread(rooms: TrayUnreadRoom[]): void {
  if (!tray)
    return
  unreadRooms = rooms
  const total = rooms.reduce((sum, room) => sum + room.count, 0)
  tray.setToolTip(total > 0 ? `Desktop48 · 未读 ${total}` : 'Desktop48')
  applyIcon()
  refreshMenu()
}
