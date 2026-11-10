/** 托盘 / 菜单栏（main/tray.ts）契约单测：平台闸门、模板图、未读房间菜单 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface TrayMock {
  destroy: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  popUpContextMenu: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  setImage: ReturnType<typeof vi.fn>
  setIgnoreDoubleClickEvents: ReturnType<typeof vi.fn>
  setToolTip: ReturnType<typeof vi.fn>
}
interface ImageMock {
  path: string
  setTemplateImage: ReturnType<typeof vi.fn>
}
interface MenuItemMock {
  label?: string
  type?: string
  enabled?: boolean
  click?: () => void
  submenu?: MenuItemMock[]
}

const { trayInstances, images, templates } = vi.hoisted(() => ({
  trayInstances: [] as TrayMock[],
  images: [] as ImageMock[],
  templates: [] as MenuItemMock[][],
}))

// vi.mock 会被 vitest 提升到所有 import 之前，故静态 import 可放在其上方
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn((template: MenuItemMock[]) => {
      templates.push(template)
      return { menu: true }
    }),
  },
  // 必须用函数表达式而非箭头函数：`new Tray(...)` 要求可构造
  // eslint-disable-next-line prefer-arrow-callback
  Tray: vi.fn(function TrayCtorMock() {
    const instance: TrayMock = {
      destroy: vi.fn(),
      on: vi.fn(),
      popUpContextMenu: vi.fn(),
      setContextMenu: vi.fn(),
      setImage: vi.fn(),
      setIgnoreDoubleClickEvents: vi.fn(),
      setToolTip: vi.fn(),
    }
    trayInstances.push(instance)
    return instance
  }),
  nativeImage: {
    createFromPath: vi.fn((path: string) => {
      const image: ImageMock = { path, setTemplateImage: vi.fn() }
      images.push(image)
      return image
    }),
  },
}))

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
}))

const { destroyTray, installTray, isTrayActive, setTrayUnread } = await import('../src/main/tray')
const { Tray: TrayCtor } = await import('electron')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
/** 平台位在调用时判定，故用例内改即可生效 */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

const showWindow = vi.fn()
const openRoom = vi.fn()
const HANDLERS = { showWindow, openRoom }
const ICON = '/fake/trayTemplate.png'
const UNREAD = '/fake/trayUnread.png'
const MAC_ICONS = { icon: ICON, unread: UNREAD }

/** 造未读房间；默认按 userId 递增给 latestTime，顺序即传入顺序 */
function rooms(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    userId: i + 1,
    name: `成员${i + 1}`,
    count: i + 1,
    latestTime: 1000 - i,
  }))
}

/** 取托盘注册的某个事件回调 */
function handlerOf(tray: TrayMock, event: string): (() => void) | undefined {
  const call = tray.on.mock.calls.find(([name]) => name === event)
  return call?.[1] as (() => void) | undefined
}

/** 最近一次构建的菜单模板 */
function lastMenu(): MenuItemMock[] {
  return templates.at(-1) ?? []
}

/** 最近一次 setImage 的图片路径 */
function lastImagePath(tray: TrayMock): string | undefined {
  const call = tray.setImage.mock.calls.at(-1)
  return (call?.[0] as ImageMock | undefined)?.path
}

function labels(items: MenuItemMock[]): string[] {
  return items.map(item => item.label ?? item.type ?? '')
}

describe('tray / 菜单栏', () => {
  beforeEach(() => {
    trayInstances.length = 0
    images.length = 0
    templates.length = 0
    vi.clearAllMocks()
    showWindow.mockReset()
    openRoom.mockReset()
  })

  afterAll(() => {
    if (originalPlatform)
      Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('未安装托盘时 isTrayActive 为 false，各导出均为安全 no-op', () => {
    expect(isTrayActive()).toBe(false)
    expect(() => destroyTray()).not.toThrow()
    expect(() => setTrayUnread(rooms(2))).not.toThrow()
  })

  it('非 Windows / macOS 平台不创建托盘', () => {
    stubPlatform('linux')
    installTray(MAC_ICONS, HANDLERS)
    expect(TrayCtor).not.toHaveBeenCalled()
    expect(isTrayActive()).toBe(false)
  })

  it('macOS 用模板图建托盘：左键弹菜单，右键唤回主窗口，重复创建为 no-op', () => {
    stubPlatform('darwin')
    installTray(MAC_ICONS, HANDLERS)

    expect(isTrayActive()).toBe(true)
    expect(TrayCtor).toHaveBeenCalledTimes(1)
    expect(images[0]?.path).toBe(ICON)
    // 只用 alpha 通道，系统据此按菜单栏明暗反色
    expect(images[0]?.setTemplateImage).toHaveBeenCalledWith(true)

    const tray = trayInstances[0] as TrayMock
    // 不挂常驻菜单：设置后系统会把左右键都接管成弹菜单，右键就分不出来
    expect(tray.setContextMenu).not.toHaveBeenCalled()
    expect(tray.setIgnoreDoubleClickEvents).toHaveBeenCalledWith(true)

    handlerOf(tray, 'click')?.()
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1)
    expect(showWindow).not.toHaveBeenCalled()

    handlerOf(tray, 'right-click')?.()
    expect(showWindow).toHaveBeenCalledTimes(1)
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1)

    installTray(MAC_ICONS, HANDLERS)
    expect(TrayCtor).toHaveBeenCalledTimes(1)

    destroyTray()
  })

  it('windows 平台预挂右键菜单（单击仍走唤回）', () => {
    stubPlatform('win32')
    installTray({ icon: ICON }, HANDLERS)

    const tray = trayInstances[0] as TrayMock
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
    expect(tray.setIgnoreDoubleClickEvents).not.toHaveBeenCalled()
    handlerOf(tray, 'click')?.()
    expect(showWindow).toHaveBeenCalledTimes(1)

    destroyTray()
  })

  it('未读超过 4 个：顶层只列前 4 个，「更多」子菜单只列第 5 个起，点击房间回调带 userId', () => {
    stubPlatform('darwin')
    installTray(MAC_ICONS, HANDLERS)
    const tray = trayInstances[0] as TrayMock

    setTrayUnread(rooms(6))
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Desktop48 · 未读 21')
    expect(lastImagePath(tray)).toBe(UNREAD)
    expect(images.find(i => i.path === UNREAD)?.setTemplateImage).toHaveBeenCalledWith(true)

    const menu = lastMenu()
    expect(labels(menu)).toEqual([
      '显示主窗口',
      'separator',
      '未读消息（21）',
      '成员1（1）',
      '成员2（2）',
      '成员3（3）',
      '成员4（4）',
      '更多',
      'separator',
      '退出 Desktop48',
    ])
    // 「更多」是悬停展开的二级菜单，只补顶层没列到的房间，不重复前 4 个
    const more = menu.find(item => item.label === '更多')
    expect(labels(more?.submenu ?? [])).toEqual(['成员5（5）', '成员6（6）'])

    menu.find(item => item.label === '成员2（2）')?.click?.()
    expect(openRoom).toHaveBeenCalledWith(2)
    more?.submenu?.[1]?.click?.()
    expect(openRoom).toHaveBeenLastCalledWith(6)
    // 顶层房间项不超过 4 个（label 里带「（」的即房间项）
    expect(menu.filter(item => item.label?.includes('（'))).toHaveLength(5) // 含「未读消息（21）」
    // 恰好 5 个时「更多」只补第 5 个
    setTrayUnread(rooms(5))
    expect(labels(lastMenu().find(item => item.label === '更多')?.submenu ?? [])).toEqual(['成员5（5）'])

    destroyTray()
  })

  it('未读不超过 4 个时不出现「更多」；归零后菜单显示暂无未读且图标复位', () => {
    stubPlatform('darwin')
    installTray(MAC_ICONS, HANDLERS)
    const tray = trayInstances[0] as TrayMock

    setTrayUnread(rooms(3))
    expect(labels(lastMenu())).not.toContain('更多')
    // 未读数变化但图片不变时不该重绘
    tray.setImage.mockClear()
    setTrayUnread(rooms(3))
    expect(tray.setImage).not.toHaveBeenCalled()

    setTrayUnread([])
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Desktop48')
    expect(lastImagePath(tray)).toBe(ICON)
    expect(lastMenu()).toContainEqual(expect.objectContaining({ label: '暂无未读消息', enabled: false }))
    expect(images.filter(i => i.path === ICON)).toHaveLength(1)

    destroyTray()
  })

  it('windows 未读变化重新挂菜单，但不切图标', () => {
    stubPlatform('win32')
    installTray({ icon: ICON }, HANDLERS)
    const tray = trayInstances[0] as TrayMock

    setTrayUnread(rooms(2))
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2)
    expect(labels(lastMenu())).toContain('成员1（1）')
    expect(tray.setImage).not.toHaveBeenCalled()
    expect(images.find(i => i.path === ICON)?.setTemplateImage).not.toHaveBeenCalled()

    destroyTray()
  })

  it('销毁后各导出恢复为 no-op', () => {
    stubPlatform('darwin')
    installTray(MAC_ICONS, HANDLERS)
    const tray = trayInstances[0] as TrayMock

    destroyTray()
    expect(isTrayActive()).toBe(false)
    expect(tray.destroy).toHaveBeenCalledTimes(1)
    expect(() => setTrayUnread(rooms(1))).not.toThrow()
    expect(tray.setImage).not.toHaveBeenCalled()
  })
})
