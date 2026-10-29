/**
 * macOS 手动更新检查。
 *
 * macOS 不走 electron-updater，只读镜像上的 latest.json 判断版本；
 * 镜像不可用时回落 GitHub（API → Release 页面）。这里覆盖这三级来源与重试语义。
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

/** 当前架构对应的镜像安装包直链；清单里两种架构都给，避免断言随机器变化 */
const ARCH_SUFFIX = process.arch === 'arm64' ? 'arm64' : 'x64'
const MIRROR_URL = `https://dl.v2ing.com/Desktop48-0.3.0-${ARCH_SUFFIX}.dmg`

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

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

/** 镜像清单：两种架构都列上，版本由用例决定 */
function manifest(version: string, notes = '') {
  return jsonResponse({
    version,
    notes,
    files: [
      { name: `Desktop48-${version}-arm64.dmg`, size: 1 },
      { name: `Desktop48-${version}-x64.dmg`, size: 1 },
    ],
  })
}

describe('macOS 手动更新检查', () => {
  it('镜像清单有新版本时返回 available，下载地址直接指向安装包', async () => {
    fetchMock.mockResolvedValueOnce(manifest('0.3.0', '### 修复\n- 更新检查'))

    const state = await checkForUpdates()

    expect(state).toEqual({
      phase: 'available',
      version: '0.3.0',
      releaseNotes: '### 修复\n- 更新检查',
      manualUpdate: true,
      url: MIRROR_URL,
    })
    expect(getUpdaterState()).toEqual(state)
    // 命中镜像就不该再碰 GitHub
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('版本不高于当前版本时返回 up-to-date', async () => {
    fetchMock.mockResolvedValueOnce(manifest('0.2.5'))

    const state = await checkForUpdates()

    expect(state).toEqual({ phase: 'up-to-date' })
  })

  it('镜像不可用时回落 GitHub API，下载地址退回 Release 页面', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('mirror down'), { statusCode: 503 }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v0.3.0', body: '修复更新检查' }))

    const state = await checkForUpdates()

    expect(state).toMatchObject({
      phase: 'available',
      version: '0.3.0',
      releaseNotes: '修复更新检查',
      url: 'https://github.com/mirtu-ko/Desktop48.app/releases/latest',
    })
  })

  it('镜像清单 404 同样换 GitHub：配置错不能靠重试自愈', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('manifest 404'), { statusCode: 404 }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v0.3.0', body: '' }))

    const state = await checkForUpdates()

    expect(state).toMatchObject({ phase: 'available', version: '0.3.0' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('镜像与 GitHub 都失败时按重试语义继续，恢复后成功', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('mirror 500'), { statusCode: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('github 500'), { statusCode: 500 }))
      .mockResolvedValueOnce(manifest('0.2.6'))

    const promise = checkForUpdates()
    // 先让首次尝试（镜像 + GitHub）落地，退避定时器才真正排上
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(getUpdaterState().phase).toBe('available')
  })

  it('两级来源都限流时降级到 Release 页面解析 tag', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('mirror down'), { statusCode: 500 }))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://github.com/mirtu-ko/Desktop48.app/releases/tag/v0.3.1',
        json: async () => ({}),
      })

    const state = await checkForUpdates()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(state).toMatchObject({ phase: 'available', manualUpdate: true, version: '0.3.1' })
  })

  it('静默检查失败时还原检查前状态，不停留在 checking', async () => {
    // 先做一次成功的检查，得到一个非 idle 的基线
    fetchMock.mockResolvedValueOnce(manifest('0.3.0'))
    await checkForUpdates()
    const baseline = getUpdaterState()
    expect(baseline.phase).toBe('available')

    // 3 次尝试 ×（镜像 + GitHub 各一次）；先清掉基线那次成功的抓取记录
    fetchMock.mockClear()
    fetchMock.mockRejectedValue(Object.assign(new Error('Request timed out'), { statusCode: 408 }))
    const promise = checkForUpdates({ silent: true })
    for (let i = 0; i < 4; i++)
      await vi.advanceTimersByTimeAsync(1000)
    const state = await promise

    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(state).toEqual(baseline)
  })

  it('开发模式下显式开启 DEV 检查开关后走手动检查', async () => {
    appMock.isPackaged = false
    process.env.DESKTOP48_DEV_UPDATE_CHECK = '1'
    fetchMock.mockResolvedValueOnce(manifest('0.3.0'))

    const state = await checkForUpdates()

    expect(state).toMatchObject({ phase: 'available', manualUpdate: true, version: '0.3.0' })
  })
})
