/**
 * 更新状态机（UpdaterEngine）的行为。
 *
 * 被测模块只依赖三样外部东西：electron 的 app（取版本号）、IPC 广播、更新后端。
 * 三者全部替身化——这里验证的是「状态怎么走」，不碰真实网络、也不写真实磁盘。
 */
import type { UpdateCandidate, UpdaterBackend, UpdaterMemory } from '../src/main/updater/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// app.getVersion 是状态的 currentVersion 来源；其余 Electron 能力用不到
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0', isPackaged: true } }))

// 广播是副作用:收成 spy,顺带验证状态确实发出去了
const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }))
vi.mock('../src/main/ipc/send', () => ({ broadcastIpc: broadcastMock, sendIpc: vi.fn() }))

const { UpdaterEngine } = await import('../src/main/updater/engine')
const { INSTALL_RETRY_COOLDOWN_MS } = await import('../src/main/updater/memory')
const { DOWNLOAD_STALL_TIMEOUT_MS, CHECK_TIMEOUT_MS, STARTUP_INSTALL_TIMEOUT_MS } = await import('../src/main/updater/engine')

/** 内存版记忆存储：engine 只认 read/write，不关心落盘 */
function createMemory(initial: Partial<UpdaterMemory> = {}) {
  let memory: UpdaterMemory = {
    lastCheckAt: null,
    lastResult: null,
    downloadedVersion: null,
    dismissedVersion: null,
    dismissedAt: null,
    installAttempt: null,
    ...initial,
  }
  const write = vi.fn((patch: Partial<UpdaterMemory>) => {
    memory = { ...memory, ...patch }
    return memory
  })
  return { store: { read: () => memory, write }, read: () => memory, write }
}

function createCandidate(overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    version: '1.1.0',
    releaseNotes: '- 修好了若干问题',
    delivery: 'in-app',
    source: 'mirror',
    ...overrides,
  }
}

function createBackend(overrides: Partial<UpdaterBackend> = {}): UpdaterBackend {
  return {
    mode: 'in-app',
    check: vi.fn(async () => createCandidate()),
    download: vi.fn(async (_candidate, onProgress) => {
      onProgress({ percent: 100, bytesPerSecond: 1024, transferred: 2048, total: 2048 })
    }),
    install: vi.fn(),
    ...overrides,
  }
}

/** 把「检查 → 自动下载」推到底（download 是 fire-and-forget 起的） */
async function settle(engine: InstanceType<typeof UpdaterEngine>): Promise<void> {
  await engine.download()
}

beforeEach(() => {
  broadcastMock.mockClear()
})

describe('updaterEngine 检查', () => {
  it('初始是 idle，并带上当前版本号', () => {
    const engine = new UpdaterEngine({ backend: createBackend(), memory: createMemory().store })
    const state = engine.getState()
    expect(state.phase).toBe('idle')
    expect(state.currentVersion).toBe('1.0.0')
    expect(state.notice).toBeNull()
  })

  it('没有新版本时落到 up-to-date，并记下检查成功', () => {
    const memory = createMemory()
    const engine = new UpdaterEngine({
      backend: createBackend({ check: vi.fn(async () => null) }),
      memory: memory.store,
    })

    return engine.check().then((state) => {
      expect(state.phase).toBe('up-to-date')
      expect(state.checkedAt).toBeTypeOf('number')
      expect(memory.read().lastResult).toBe('ok')
      expect(state.notice).toBeNull()
    })
  })

  it('in-app 新版本直接进入下载，完成后 ready 并记下已下载版本', async () => {
    const memory = createMemory()
    let finish: () => void = () => {}
    const backend = createBackend({
      download: vi.fn((_candidate, onProgress) => new Promise<void>((resolve) => {
        onProgress({ percent: 42, bytesPerSecond: 1024, transferred: 1024, total: 2048 })
        finish = () => {
          onProgress({ percent: 100, bytesPerSecond: 1024, transferred: 2048, total: 2048 })
          resolve()
        }
      })),
    })
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    const state = await engine.check()
    // 检查返回时已经在下载（不经过 available，用户不需要先点一次）
    expect(state.phase).toBe('downloading')
    expect(state.notice).toBeNull()

    finish()
    await settle(engine)

    const done = engine.getState()
    expect(done.phase).toBe('ready')
    expect(done.notice).toEqual({ version: '1.1.0', kind: 'ready' })
    expect(memory.read().downloadedVersion).toBe('1.1.0')
  })

  it('manual 交付只落 available，不触发下载', async () => {
    const backend = createBackend({ check: vi.fn(async () => createCandidate({ delivery: 'manual', url: 'https://48.v2ing.com/' })) })
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    const state = await engine.check()
    expect(state.phase).toBe('available')
    expect(state.candidate?.delivery).toBe('manual')
    expect(state.notice).toEqual({ version: '1.1.0', kind: 'available' })
    expect(backend.download).not.toHaveBeenCalled()
  })

  it('静默检查失败保持上一次的结论，不动界面', async () => {
    const backend = createBackend({ check: vi.fn(async () => null) })
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })
    await engine.check()

    backend.check = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const state = await engine.check({ silent: true })

    expect(state.phase).toBe('up-to-date')
    expect(state.error).toBeNull()
  })

  it('手动检查失败把中文结论摆出来', async () => {
    const backend = createBackend({
      check: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { statusCode: 502 })
      }),
    })
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    const state = await engine.check()
    expect(state.phase).toBe('error')
    expect(state.error).toBe('更新服务器暂时不可用，请稍后重试')
  })

  it('检查超时不会把界面永久卡在 checking', async () => {
    vi.useFakeTimers()
    try {
      const backend = createBackend({ check: vi.fn(() => new Promise<UpdateCandidate | null>(() => {})) })
      const engine = new UpdaterEngine({ backend, memory: createMemory().store })

      const pending = engine.check()
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
      const state = await pending

      expect(state.phase).toBe('error')
      expect(state.error).toContain('超时')
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('updaterEngine 下载与安装', () => {
  it('下载停滞超过阈值就中止，并给出可重试的结论', async () => {
    vi.useFakeTimers()
    try {
      const backend = createBackend({
        download: vi.fn((_candidate, _onProgress, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })),
      })
      const engine = new UpdaterEngine({ backend, memory: createMemory().store })

      void engine.check()
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 10)
      const state = engine.getState()

      expect(state.phase).toBe('error')
      expect(state.error).toBe('下载超时或已中断，请稍后重试或前往官网下载')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('未就绪时 install 是空转', () => {
    const backend = createBackend()
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    engine.install()
    expect(backend.install).not.toHaveBeenCalled()
    expect(engine.getState().phase).toBe('idle')
  })

  it('ready 后 install 先落盘重试标记再交给安装器', async () => {
    const memory = createMemory()
    const backend = createBackend()
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await engine.check()
    await settle(engine)
    engine.install()

    expect(engine.getState().phase).toBe('installing')
    expect(memory.read().installAttempt).toMatchObject({ version: '1.1.0' })
    expect(backend.install).toHaveBeenCalledTimes(1)
  })

  it('dismiss 记下版本，同一版本不再提示', async () => {
    const memory = createMemory()
    const engine = new UpdaterEngine({ backend: createBackend(), memory: memory.store })

    await engine.check()
    await settle(engine)
    const state = engine.dismiss()

    expect(memory.read().dismissedVersion).toBe('1.1.0')
    // 只记版本不够：过期后要能重新提示
    expect(memory.read().dismissedAt).toEqual(expect.any(Number))
    expect(state.notice).toBeNull()
  })

  it('下载中再次 check 不会并发触发检查', async () => {
    let resolveDownload!: () => void
    const backend = createBackend({
      download: vi.fn(() => new Promise<void>((resolve) => {
        resolveDownload = resolve
      })),
    })
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    await engine.check()
    expect(engine.getState().phase).toBe('downloading')

    const concurrent = engine.check()
    expect(backend.check).toHaveBeenCalledTimes(1)

    resolveDownload()
    await expect(concurrent).resolves.toMatchObject({ phase: 'ready' })
  })

  it('ready 态重新检查失败或仍是同一版本时，保留 ready 状态与重启入口', async () => {
    const checkMock = vi.fn()
      .mockResolvedValueOnce(createCandidate({ version: '1.1.0' }))
      .mockResolvedValueOnce(createCandidate({ version: '1.1.0' }))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const backend = createBackend({ check: checkMock })
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    await engine.check()
    await settle(engine)
    expect(engine.getState().phase).toBe('ready')
    vi.mocked(backend.download!).mockClear()

    // 仍是同一版本：不重走 download
    await engine.check()
    expect(engine.getState().phase).toBe('ready')
    expect(backend.download).not.toHaveBeenCalled()

    // 检查失败：不把 ready 冲成 error
    await engine.check()
    expect(engine.getState().phase).toBe('ready')
  })
})

describe('updaterEngine 启动安装', () => {
  it('没有待装版本时直接走普通启动', async () => {
    const backend = createBackend()
    const engine = new UpdaterEngine({ backend, memory: createMemory().store })

    await expect(engine.startPendingInstall()).resolves.toBe(false)
    expect(backend.install).not.toHaveBeenCalled()
  })

  it('有已下好的新版本时复用磁盘包并交给安装器', async () => {
    const memory = createMemory({ downloadedVersion: '1.1.0' })
    const backend = createBackend()
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await expect(engine.startPendingInstall()).resolves.toBe(true)
    expect(backend.check).toHaveBeenCalledTimes(1)
    expect(backend.download).toHaveBeenCalledTimes(1)
    expect(backend.install).toHaveBeenCalledTimes(1)
    // 先落盘再退出：installAttempt 决定「装失败回来后 24h 内不再自动装」
    expect(memory.read().installAttempt).toMatchObject({ version: '1.1.0' })
  })

  it('24h 内已经试过安装同一版本就不再重试（防重启环）', async () => {
    const memory = createMemory({
      downloadedVersion: '1.1.0',
      installAttempt: { version: '1.1.0', at: Date.now() - INSTALL_RETRY_COOLDOWN_MS + 60_000 },
    })
    const backend = createBackend()
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await expect(engine.startPendingInstall()).resolves.toBe(false)
    expect(backend.install).not.toHaveBeenCalled()
  })

  it('安装前检查失败时按普通启动继续', async () => {
    const memory = createMemory({ downloadedVersion: '1.1.0' })
    const backend = createBackend({
      check: vi.fn(async () => {
        throw new Error('ENOTFOUND dl.v2ing.com')
      }),
    })
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await expect(engine.startPendingInstall()).resolves.toBe(false)
    expect(engine.getState().phase).toBe('idle')
    expect(backend.install).not.toHaveBeenCalled()
  })

  it('线上版本已超过磁盘包时跳过启动安装，清掉陈旧记录', async () => {
    const memory = createMemory({ downloadedVersion: '1.1.0' })
    const backend = createBackend({ check: vi.fn(async () => createCandidate({ version: '1.2.0' })) })
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await expect(engine.startPendingInstall()).resolves.toBe(false)
    // 新包该由启动后的后台流程去下，不该在启动阶段抢带宽
    expect(backend.download).not.toHaveBeenCalled()
    expect(backend.install).not.toHaveBeenCalled()
    expect(memory.read().downloadedVersion).toBeNull()
    expect(memory.read().installAttempt).toBeNull()
  })

  it('下载超时会中止底层任务，不留后台孤儿', async () => {
    vi.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | undefined
      const memory = createMemory({ downloadedVersion: '1.1.0' })
      const backend = createBackend({
        download: vi.fn((_candidate, _onProgress, signal: AbortSignal) => {
          capturedSignal = signal
          // 永不 settle：模拟 8s 内完不成的下载
          return new Promise<void>(() => {})
        }),
      })
      const engine = new UpdaterEngine({ backend, memory: memory.store })

      const pending = engine.startPendingInstall()
      await vi.advanceTimersByTimeAsync(STARTUP_INSTALL_TIMEOUT_MS)
      await expect(pending).resolves.toBe(false)

      expect(capturedSignal?.aborted ?? false).toBe(true)
      expect(engine.getState().phase).toBe('idle')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('启动安装失败会记一次尝试，避免每次启动都等一轮超时', async () => {
    const memory = createMemory({ downloadedVersion: '1.1.0' })
    const backend = createBackend({
      download: vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    })
    const engine = new UpdaterEngine({ backend, memory: memory.store })

    await expect(engine.startPendingInstall()).resolves.toBe(false)
    expect(memory.read().installAttempt).toMatchObject({ version: '1.1.0' })
    expect(memory.read().downloadedVersion).toBe('1.1.0')
    expect(engine.getState().phase).toBe('idle')
  })

  it('版本追上记录后启动时不再惦记旧版本', () => {
    const memory = createMemory({
      downloadedVersion: '1.0.0',
      dismissedVersion: '1.0.0',
      lastResult: 'ok',
    })
    const engine = new UpdaterEngine({ backend: createBackend(), memory: memory.store })

    expect(memory.read().downloadedVersion).toBeNull()
    expect(memory.read().dismissedVersion).toBeNull()
    expect(engine.getState().phase).toBe('idle')
  })
})
