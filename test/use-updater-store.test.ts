/**
 * 渲染端更新单例（stores/use-updater.ts）。
 *
 * 钉住三件事：只订阅一次（设置页与横幅共用同一份状态）、订阅先于快照（否则漏掉首次广播）、
 * 以及「广播是唯一写入口」——IPC 回包不得回写状态，否则晚到的回包会把界面倒退。
 */
import type { UpdaterState } from '../src/preload/ipc-contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/utils/umami', () => ({ trackEvent: vi.fn() }))

const { trackEvent } = await import('@renderer/utils/umami')
const { useUpdater } = await import('@renderer/stores/use-updater')

function baseState(overrides: Partial<UpdaterState> = {}): UpdaterState {
  return {
    phase: 'idle',
    currentVersion: '1.0.0',
    checkedAt: null,
    candidate: null,
    download: null,
    error: null,
    unsupported: null,
    notice: null,
    ...overrides,
  }
}

type Broadcast = (state: UpdaterState) => void

const candidate = { version: '1.1.0', releaseNotes: '- 修补', delivery: 'in-app' as const, source: 'mirror' as const }
const readyState = baseState({
  phase: 'ready',
  candidate,
  notice: { version: '1.1.0', kind: 'ready' },
})
const downloadingState = baseState({
  phase: 'downloading',
  candidate,
  download: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
})

let broadcast: Broadcast
let subscribeCount: number
let resolveCheck: (state: UpdaterState) => void

beforeEach(() => {
  subscribeCount = 0
  vi.stubGlobal('window', {
    mainAPI: {
      updaterState: vi.fn((cb: Broadcast) => {
        subscribeCount += 1
        broadcast = cb
        return () => {}
      }),
      updaterGetState: vi.fn(async () => baseState()),
      getAppVersion: vi.fn(async () => '1.0.0'),
      // 回包故意可控：用来复现「回包晚于广播到达」
      updaterCheck: vi.fn(() => new Promise<UpdaterState>((resolve) => { resolveCheck = resolve })),
      updaterDownload: vi.fn(async () => downloadingState),
      updaterInstall: vi.fn(async () => {}),
      updaterDismiss: vi.fn(async () => readyState),
    },
  })
})

describe('useUpdater', () => {
  it('多次调用只订阅一次，并共享同一份状态', () => {
    const a = useUpdater()
    const b = useUpdater()

    expect(subscribeCount).toBe(1)
    expect(a.state).toBe(b.state)

    broadcast(readyState)
    expect(a.state.value.phase).toBe('ready')
    expect(b.description.value).toBe('新版本 v1.1.0 已下载完成，重启后生效')
    expect(a.banner.value).toMatchObject({ kind: 'install' })
  })

  it('广播后再取快照不会覆盖已有状态', async () => {
    const store = useUpdater()
    broadcast(readyState)
    await Promise.resolve()

    expect(store.state.value.phase).toBe('ready')
    expect(store.version.value).toBe('1.0.0')
  })

  it('check 走 IPC 并记录埋点，检查中防重入', async () => {
    const store = useUpdater()

    const first = store.check()
    const second = store.check()

    expect(trackEvent).toHaveBeenCalledWith('update:check')
    expect(window.mainAPI.updaterCheck).toHaveBeenCalledTimes(1)

    resolveCheck(readyState)
    await Promise.all([first, second])
    expect(store.checking.value).toBe(false)
  })

  it('回包晚于 ready 广播时不会把界面退回下载中', async () => {
    const store = useUpdater()

    const pending = store.check()
    // 下载很快：完成广播先到，随后「检查」的回包才带着 downloading 中间态落地
    broadcast(readyState)
    resolveCheck(downloadingState)
    await pending

    expect(store.state.value.phase).toBe('ready')
    expect(store.state.value.download).toBeNull()
    expect(store.action.value).toMatchObject({ kind: 'install' })
  })

  it('重试下载的回包同样不回写状态', async () => {
    const store = useUpdater()
    broadcast(readyState)

    await store.retryDownload()

    expect(window.mainAPI.updaterDownload).toHaveBeenCalledTimes(1)
    expect(store.state.value.phase).toBe('ready')
  })

  it('install 记录埋点并转发 IPC', () => {
    const store = useUpdater()

    store.install()
    expect(trackEvent).toHaveBeenCalledWith('update:install')
    expect(window.mainAPI.updaterInstall).toHaveBeenCalledTimes(1)
  })

  it('dismiss 记录版本埋点，横幅随广播消失', async () => {
    const store = useUpdater()
    broadcast(readyState)
    expect(store.banner.value).not.toBeNull()

    await store.dismiss()
    expect(trackEvent).toHaveBeenCalledWith('update:banner_dismiss', { version: '1.1.0' })
    expect(window.mainAPI.updaterDismiss).toHaveBeenCalledTimes(1)

    broadcast({ ...readyState, notice: null })
    expect(store.banner.value).toBeNull()
  })

  it('action 随状态切换语义', () => {
    const store = useUpdater()

    broadcast(readyState)
    expect(store.action.value).toMatchObject({ kind: 'install', label: '立即重启' })

    broadcast(baseState({ phase: 'error', error: '网络连接超时，请检查网络后重试' }))
    expect(store.action.value).toMatchObject({ kind: 'check', label: '重新检查' })
    expect(store.description.value).toBe('网络连接超时，请检查网络后重试')
  })
})
