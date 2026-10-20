/** Windows 托盘（main/tray.ts）契约单测：无副作用加载 + 未安装时各导出为 no-op */

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
    // installTray 需真实平台位，不直接调用；no-op 契约须稳定成立
    expect(() => destroyTray()).not.toThrow()
    expect(() => setTrayUnread(5)).not.toThrow()
    expect(() => setTrayUnread(-1)).not.toThrow()
  })
})
