/**
 * macOS 手动更新检查。
 *
 * macOS 不走 electron-updater，只查询 GitHub latest Release；
 * 因此这里钉住 darwin，验证能发现新版本、能识别同版本、并保留重试语义。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appMock = { isPackaged: true, getVersion: () => '0.2.5' }
vi.mock('electron', () => ({ app: appMock }))

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }))
vi.mock('../src/main/ipc/send', () => ({ broadcastIpc: broadcastMock, sendIpc: vi.fn() }))

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => true) }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

Object.defineProperty(process, 'resourcesPath', { value: '/tmp/fake-resources', configurable: true })

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const { checkForUpdates, getUpdaterState } = await import('../src/main/updater')

const fetchMock = vi.fn()
const originalFetch = globalThis.fetch

beforeEach(() => {
  appMock.isPackaged = true
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  globalThis.fetch = fetchMock
  fetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.DESKTOP48_DEV_UPDATE_CHECK
  globalThis.fetch = originalFetch
})

afterAll(() => {
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform)
})

function githubResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

describe('macOS 手动更新检查', () => {
  it('发现新版本时返回 available，并标记为手动下载', async () => {
    fetchMock.mockResolvedValueOnce(githubResponse({ tag_name: 'v0.3.0', body: '### 修复\n- 更新检查' }))

    const state = await checkForUpdates()

    expect(state).toEqual({
      phase: 'available',
      version: '0.3.0',
      releaseNotes: '### 修复\n- 更新检查',
      manualUpdate: true,
      url: 'https://github.com/mirtu-ko/Desktop48.app/releases/latest',
    })
    expect(getUpdaterState()).toEqual(state)
  })

  it('release 版本不高于当前版本时保持 idle', async () => {
    fetchMock.mockResolvedValueOnce(githubResponse({ tag_name: 'v0.2.5', body: '' }))

    const state = await checkForUpdates()

    expect(state).toEqual({ phase: 'idle' })
  })

  it('临时性失败会重试', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { statusCode: 500 }))
      .mockResolvedValueOnce(githubResponse({ tag_name: 'v0.2.6', body: '' }))

    const promise = checkForUpdates()
    await vi.advanceTimersByTimeAsync(800)
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getUpdaterState().phase).toBe('available')
  })

  it('静默检查失败时还原检查前状态，不停留在 checking', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('Request timed out'), { statusCode: 408 }))

    const promise = checkForUpdates({ silent: true })
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2400)
    const state = await promise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(state.phase).toBe('available')
  })

  it('开发模式下显式开启 DEV 检查开关后走手动检查', async () => {
    appMock.isPackaged = false
    process.env.DESKTOP48_DEV_UPDATE_CHECK = '1'
    fetchMock.mockResolvedValueOnce(githubResponse({ tag_name: 'v0.3.0', body: '修复更新检查' }))

    const state = await checkForUpdates()

    expect(state).toMatchObject({ phase: 'available', manualUpdate: true, version: '0.3.0' })
  })

  it('gitHub API 限流时降级到 Release 页面检查', async () => {
    fetchMock
      .mockResolvedValueOnce(githubResponse({}, 403))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://github.com/mirtu-ko/Desktop48.app/releases/tag/v0.3.1',
        json: async () => ({}),
      })

    const state = await checkForUpdates()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state).toMatchObject({ phase: 'available', manualUpdate: true, version: '0.3.1' })
  })
})
