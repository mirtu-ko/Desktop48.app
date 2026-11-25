/**
 * 两套更新后端：electron-updater 包装（in-app）与手动查版本（manual）。
 *
 * electron-updater 是事件式 API，这里验证的正是「事件如何被压成 candidate / progress」，
 * 以及镜像失败后整体切 GitHub 的行为——这条路径出错的表现是「有更新但永远查不到」。
 */
import type { UpdateCandidate } from '../src/main/updater/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }))

const { autoUpdaterMock, cancelMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (info: unknown) => void>()
  return {
    cancelMock: vi.fn(),
    listeners,
    autoUpdaterMock: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      on: vi.fn((event: string, cb: (info: unknown) => void) => listeners.set(event, cb)),
      off: vi.fn((event: string) => listeners.delete(event)),
    },
  }
})

vi.mock('electron-updater', () => ({
  default: { autoUpdater: autoUpdaterMock },
  CancellationToken: class {
    cancel = cancelMock
  },
}))

vi.mock('../src/main/ipc/send', () => ({ broadcastIpc: vi.fn(), sendIpc: vi.fn() }))

const { createInAppBackend, createManualBackend, MIRROR_CHECK_TIMEOUT_MS } = await import('../src/main/updater/backend')

const originalFetch = globalThis.fetch

/** 补取更新说明会打镜像 latest.json；默认给一个「查不到」的替身，避免测试碰真网络。 */
let fetchMock: ReturnType<typeof vi.fn>

function mirrorManifest(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  autoUpdaterMock.setFeedURL.mockClear()
  autoUpdaterMock.checkForUpdates.mockReset()
  autoUpdaterMock.downloadUpdate.mockReset()
  autoUpdaterMock.quitAndInstall.mockClear()
  listeners.clear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function checkResult(version: string, releaseNotes?: unknown) {
  return { updateInfo: { version, releaseNotes } }
}

describe('in-app 检查', () => {
  it('镜像可用时一次就拿到候选版本', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.1.0', '- 修复若干问题'))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate).toMatchObject({
      version: '1.1.0',
      releaseNotes: '- 修复若干问题',
      delivery: 'in-app',
      source: 'mirror',
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL.mock.calls[0][0]).toMatchObject({ provider: 'generic' })
  })

  it('镜像失败后整体切 GitHub，候选版本标记来源', async () => {
    autoUpdaterMock.checkForUpdates
      .mockRejectedValueOnce(new Error('HTTP 404'))
      .mockResolvedValueOnce(checkResult('1.2.0'))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate).toMatchObject({ version: '1.2.0', source: 'github' })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'github' }))
  })

  it('镜像挂起超过独立超时后，能自动切到 GitHub 兜底', async () => {
    vi.useFakeTimers()
    try {
      autoUpdaterMock.checkForUpdates
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(checkResult('1.2.0'))
      const backend = createInAppBackend()

      const pending = backend.check()
      await vi.advanceTimersByTimeAsync(MIRROR_CHECK_TIMEOUT_MS)

      await expect(pending).resolves.toMatchObject({ version: '1.2.0', source: 'github' })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'github' }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('外部信号中止后不再切换 GitHub 或继续重试', async () => {
    const controller = new AbortController()
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('ETIMEDOUT')
    })
    const backend = createInAppBackend()

    await expect(backend.check(controller.signal)).rejects.toThrow('ETIMEDOUT')
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
  })

  it('版本不比当前新时按已是最新处理', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.0.0'))
    const backend = createInAppBackend()

    await expect(backend.check()).resolves.toBeNull()
  })

  it('releaseNotes 是分段数组时拼成纯文本', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.1.0', [
      { version: '1.1.0', note: '- 新版本说明' },
    ]))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate?.releaseNotes).toBe('1.1.0\n- 新版本说明')
    // yml 里自带说明就不该再多打一次镜像
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('latest.yml 没有说明时用镜像 latest.json 补齐', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.1.0'))
    fetchMock.mockResolvedValueOnce(mirrorManifest({ version: 'v1.1.0', notes: '- 修复 Windows 版没有更新日志' }))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate?.releaseNotes).toBe('- 修复 Windows 版没有更新日志')
  })

  it('镜像清单版本与候选版本不一致时不借用说明', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.1.0'))
    fetchMock.mockResolvedValueOnce(mirrorManifest({ version: '1.2.0', notes: '- 这是别的版本的说明' }))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate?.releaseNotes).toBe('')
  })

  it('镜像不可用时补取失败也只是没有说明', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(checkResult('1.1.0'))
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const backend = createInAppBackend()

    const candidate = await backend.check()
    expect(candidate).toMatchObject({ version: '1.1.0', releaseNotes: '' })
  })
})

describe('in-app 下载', () => {
  it('进度事件转成 onProgress，结束后摘掉监听', async () => {
    const backend = createInAppBackend()
    const progress: number[] = []

    autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
      listeners.get('download-progress')?.({ percent: 40, bytesPerSecond: 1024, transferred: 400, total: 1000 })
      listeners.get('download-progress')?.({ percent: 100, bytesPerSecond: 1024, transferred: 1000, total: 1000 })
    })

    const candidate: UpdateCandidate = { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' }
    await backend.download?.(candidate, p => progress.push(p.percent), new AbortController().signal)

    expect(progress).toEqual([40, 100])
    expect(listeners.has('download-progress')).toBe(false)
  })

  it('取消信号触发 CancellationToken.cancel', async () => {
    const backend = createInAppBackend()
    const controller = new AbortController()

    autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
      controller.abort()
      expect(cancelMock).toHaveBeenCalled()
    })

    const candidate: UpdateCandidate = { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' }
    await backend.download?.(candidate, () => {}, controller.signal)
  })

  it('已取消的信号在开始前就被拒绝', async () => {
    const backend = createInAppBackend()
    const controller = new AbortController()
    controller.abort()

    const candidate: UpdateCandidate = { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' }
    await expect(backend.download?.(candidate, () => {}, controller.signal)).rejects.toThrowError('下载已取消')
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('in-app 安装', () => {
  it('构造时关掉 electron-updater 自己的自动下载与退出安装，安装走静默重启', () => {
    const backend = createInAppBackend()

    expect(autoUpdaterMock.autoDownload).toBe(false)
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)

    backend.install?.()
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})

describe('manual 后端', () => {
  it('镜像有新版本时给出 manual 交付', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: '',
      json: async () => ({ version: '1.1.0', notes: '说明', files: [] }),
    })) as unknown as typeof fetch

    const backend = createManualBackend()
    const candidate = await backend.check()
    expect(candidate).toMatchObject({ version: '1.1.0', delivery: 'manual', releaseNotes: '说明' })
  })

  it('版本不比当前新时返回 null', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: '',
      json: async () => ({ version: '1.0.0' }),
    })) as unknown as typeof fetch

    const backend = createManualBackend()
    await expect(backend.check()).resolves.toBeNull()
  })
})
