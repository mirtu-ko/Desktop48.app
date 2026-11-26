/**
 * 更新通道判定（resolveUpdaterSupport）：按打包态、平台与 AppImage 环境区分
 * in-app / manual / unsupported。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { appMock, existsSyncMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true, getVersion: () => '1.0.0' },
  existsSyncMock: vi.fn(() => true),
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

const { resolveUpdaterSupport } = await import('../src/main/updater/index')

describe('resolveUpdaterSupport', () => {
  const originalPlatform = process.platform
  const originalAppImage = process.env.APPIMAGE
  const originalDevFlag = process.env.DESKTOP48_DEV_UPDATE_CHECK
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    appMock.isPackaged = true
    existsSyncMock.mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true })
    if (originalAppImage === undefined)
      delete process.env.APPIMAGE
    else
      process.env.APPIMAGE = originalAppImage
    if (originalDevFlag === undefined)
      delete process.env.DESKTOP48_DEV_UPDATE_CHECK
    else
      process.env.DESKTOP48_DEV_UPDATE_CHECK = originalDevFlag
  })

  it('开发模式默认不检查更新', () => {
    appMock.isPackaged = false
    delete process.env.DESKTOP48_DEV_UPDATE_CHECK
    expect(resolveUpdaterSupport()).toEqual({ ok: false, reason: '开发模式下不检查更新' })
  })

  it('macOS 走 manual 手动更新', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(resolveUpdaterSupport()).toEqual({ ok: true, mode: 'manual' })
  })

  it('linux 非 AppImage（如 deb）走 manual 手动更新', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.APPIMAGE
    expect(resolveUpdaterSupport()).toEqual({ ok: true, mode: 'manual' })
  })

  it('linux AppImage 且存在 app-update.yml 时走 in-app 更新', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.APPIMAGE = '/tmp/Desktop48.AppImage'
    Object.defineProperty(process, 'resourcesPath', { value: '/tmp/resources', configurable: true })
    existsSyncMock.mockReturnValue(true)
    expect(resolveUpdaterSupport()).toEqual({ ok: true, mode: 'in-app' })
  })

  it('windows 缺少 app-update.yml 视为免安装版，不支持自动更新', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: 'C:\\resources', configurable: true })
    existsSyncMock.mockReturnValue(false)
    expect(resolveUpdaterSupport()).toMatchObject({ ok: false })
  })
})
