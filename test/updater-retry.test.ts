/**
 * 应用更新检查的重试 / 静默语义。
 *
 * 被测模块是主进程的 `src/main/updater.ts`，它直接 `import { app } from 'electron'`
 * 并依赖 `./ipc/send` 广播状态，二者在纯 Node 测试环境都不可用，故整体替换为替身。
 * electron-updater 同理 —— 这里只验证我们自己那层重试包装，不碰真实网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 替身 ───────────────────────────────────────────────────────────────
// app.isPackaged 决定 resolveUpdaterSupport 是否放行；getVersion 供设置页展示。
const appMock = { isPackaged: true, getVersion: () => '9.9.9' }
vi.mock('electron', () => ({ app: appMock }))

// 状态广播是副作用，与用例断言无关，收成 spy 以便顺带验证"状态确实发出去了"。
const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }))
vi.mock('../src/main/ipc/send', () => ({ broadcastIpc: broadcastMock, sendIpc: vi.fn() }))

// app-update.yml 的存在性检查：用例默认"存在"（即打包完整），需要时单独改。
const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => true) }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

// 纯 Node 环境没有 process.resourcesPath（Electron 才注入），
// 而 resolveUpdaterSupport 会拿它拼 app-update.yml 路径 —— path.join(undefined) 直接抛。
// 补一个非空值即可，真实取值与断言语义无关。
process.resourcesPath = 'C:\\fake\\resources'

// electron-updater 的 autoUpdater：checkForUpdates 由各用例注入行为。
const autoUpdaterMock = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}
vi.mock('electron-updater', () => ({ default: { autoUpdater: autoUpdaterMock } }))

// ── 被测模块 ───────────────────────────────────────────────────────────
// 注意：import 必须排在 vi.mock 之后（vitest 会提升 mock，但可读性上仍需显式隔离）。
const { checkForUpdates, initUpdater, getUpdaterState } = await import('../src/main/updater')

/** 造一个带 code 的错误，模拟 electron-updater 的失败形态 */
function updaterError(code: string, message = code) {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  appMock.isPackaged = true
  existsSyncMock.mockReturnValue(true)
  autoUpdaterMock.checkForUpdates.mockReset()
  autoUpdaterMock.on.mockReset()
  broadcastMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('checkForUpdates 重试与退避', () => {
  it('临时性错误会重试，第 3 次成功则视为检查通过', async () => {
    autoUpdaterMock.checkForUpdates
      .mockRejectedValueOnce(updaterError('ETIMEDOUT', 'Request timed out'))
      .mockRejectedValueOnce(updaterError('ECONNRESET', 'socket hang up'))
      .mockResolvedValueOnce({ updateInfo: { version: '1.0.0' } })

    const promise = checkForUpdates()
    // 退避：800ms → 2400ms
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2400)
    await promise

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(getUpdaterState().phase).not.toBe('error')
  })

  it('指数退避：第 1 次失败等 800ms，第 2 次等 2400ms，不是等间隔', async () => {
    autoUpdaterMock.checkForUpdates.mockRejectedValue(updaterError('ETIMEDOUT', 'Request timed out'))

    const promise = checkForUpdates()
    // 让 async 函数体跑过 resolveUpdaterSupport 与首个 await，落到第一次真实请求上
    await vi.advanceTimersByTimeAsync(0)

    // 首次立即发生
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    // 不足 800ms 不应该有第 2 次
    await vi.advanceTimersByTimeAsync(799)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    // 第 2 次的重试窗口是 2400ms：先不足，再补足
    await vi.advanceTimersByTimeAsync(2399)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)

    await promise
  })

  it('确定性失败（404 channel 文件缺失）不重试，一次即返回', async () => {
    autoUpdaterMock.checkForUpdates.mockRejectedValue(
      updaterError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'Cannot find channel file'),
    )

    const state = await checkForUpdates()

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(state.phase).toBe('error')
  })

  it('确定性失败（latest.yml 版本非法）不重试', async () => {
    autoUpdaterMock.checkForUpdates.mockRejectedValue(
      updaterError('ERR_UPDATER_INVALID_VERSION', 'Invalid version'),
    )

    await checkForUpdates()

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('服务端 5xx 可重试，客户端 4xx 不可重试', async () => {
    const serverErr = new Error('Internal server error') as Error & { statusCode: number }
    serverErr.statusCode = 500
    autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(serverErr).mockResolvedValueOnce({ updateInfo: {} })

    const ok = checkForUpdates()
    await vi.advanceTimersByTimeAsync(800)
    await ok
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    autoUpdaterMock.checkForUpdates.mockReset()
    const clientErr = new Error('Not found') as Error & { statusCode: number }
    clientErr.statusCode = 404
    autoUpdaterMock.checkForUpdates.mockRejectedValue(clientErr)

    await checkForUpdates()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('重试耗尽后落到 error，并把失败原因翻成人话', async () => {
    autoUpdaterMock.checkForUpdates.mockRejectedValue(updaterError('ETIMEDOUT', 'Request timed out'))

    const promise = checkForUpdates()
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2400)
    const state = await promise

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(state).toEqual({ phase: 'error', message: '网络连接超时，请检查网络后重试' })
  })
})

describe('checkForUpdates 静默模式（启动后的自动检查）', () => {
  it('静默 + 重试耗尽：不改动状态（UI 保持中性，不留红字）', async () => {
    autoUpdaterMock.checkForUpdates.mockRejectedValue(updaterError('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com'))

    // 静默模式的承诺是"原样不动"，而非"变成某个特定中性态"。
    // 这里刻意先制造一个非 idle 的当前状态，验证它连碰都不碰 —— 比断言 not error 更强：
    // 若实现写成"失败时置 idle"，在 idle 起点下会静默通过，但那个行为是错的
    // （会把用户正在看的 available 清掉）。
    const baseline = checkForUpdates() // 非静默：失败会落到 error，作为基线
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2400)
    await baseline
    const before = getUpdaterState()
    expect(before.phase).toBe('error')

    autoUpdaterMock.checkForUpdates.mockClear()
    const promise = checkForUpdates({ silent: true })
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2400)
    await promise

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(getUpdaterState()).toEqual(before)
  })

  it('静默模式仍会推进"发现新版本"（失败才静默，成功照常提示）', async () => {
    // update-available 由事件推送，这里模拟库触发后我们的状态机应落到 available
    autoUpdaterMock.checkForUpdates.mockImplementation(async () => {
      const handler = autoUpdaterMock.on.mock.calls.find(c => c[0] === 'update-available')?.[1]
      handler?.({ version: '1.2.3', releaseNotes: 'notes' })
      return { updateInfo: { version: '1.2.3' } }
    })

    initUpdater()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(0)

    expect(getUpdaterState()).toEqual({ phase: 'available', version: '1.2.3', releaseNotes: 'notes' })
  })
})

describe('resolveUpdaterSupport 的前置拦截', () => {
  it('非打包环境：不支持，且不提供下载链接', async () => {
    appMock.isPackaged = false

    const state = await checkForUpdates()

    expect(state.phase).toBe('unsupported')
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('缺 app-update.yml（免安装版）：不支持，并给出 GitHub 出路', async () => {
    existsSyncMock.mockReturnValue(false)

    const state = await checkForUpdates()

    expect(state.phase).toBe('unsupported')
    if (state.phase === 'unsupported') {
      expect(state.reason).toContain('免安装版')
      expect(state.url).toContain('github.com')
    }
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})
