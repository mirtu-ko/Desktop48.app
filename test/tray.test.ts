/**
 * Windows 托盘（main/tray.ts）契约单测。
 *
 * 托盘创建依赖 process.platform + 真实 Electron Tray，纯 Node 环境无法模拟平台位，
 * 这里只验证它的**安全边界**：模块可被无副作用地加载、未安装托盘时各导出均为 no-op。
 * 这个 no-op 契约正是 pocket-unread.ts 的 publish → setTrayUnread 在非 Windows / 未建托盘的
 * 场景下能安全运行的保证（托盘相关模块不额外 mock electron 时也能静态加载）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { destroyTray, isTrayActive, setTrayUnread } from '../src/main/tray'

// vi.mock 会被 vitest 提升到所有 import 之前，故静态 import 可放在其上方
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(() => ({})),
}))

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
}))

describe('tray（Windows 系统托盘）', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('未安装托盘时 isTrayActive 为 false，各导出均为安全 no-op', () => {
    expect(isTrayActive()).toBe(false)
    // installTray 依赖真实平台位，不在本测试直接调用；其余 no-op 契约必须稳定成立
    expect(() => destroyTray()).not.toThrow()
    expect(() => setTrayUnread(5)).not.toThrow()
    expect(() => setTrayUnread(-1)).not.toThrow()
  })
})
