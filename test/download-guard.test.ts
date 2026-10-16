import type { FfmpegStatus } from '@preload/ipc-contract'
import Constants from '@renderer/utils/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDownloadGuard } from '../src/renderer/src/composables/use-download-guard'

// useDownloadGuard 用 ElMessage 提示；主窗口 Router 直接注入替身，避免依赖组件上下文
const { pushMock, messageMock } = vi.hoisted(() => ({ pushMock: vi.fn(), messageMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: messageMock }))

const fakeRouter = { push: pushMock } as any

/** 就绪状态的基准值：各用例只覆盖自己关心的字段 */
const READY: FfmpegStatus = { ok: true, problem: null, directory: '/opt/ffmpeg', binaryPath: '/opt/ffmpeg/ffmpeg' }

function stubConfig(
  getConfig: (_key: string) => Promise<string>,
  getFfmpegStatus: (_dir?: string) => Promise<FfmpegStatus> = async () => READY,
) {
  vi.stubGlobal('window', { mainAPI: { getConfig, getFfmpegStatus } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useDownloadGuard（下载/录制前的环境校验）', () => {
  it('下载目录与 FFmpeg 都可用时放行，不提示也不跳转', async () => {
    const getConfig = vi.fn(async () => '/Users/z/Downloads')
    const getFfmpegStatus = vi.fn(async () => READY)
    stubConfig(getConfig, getFfmpegStatus)

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(true)

    expect(getConfig).toHaveBeenCalledWith('downloadDirectory')
    // 不传 dir：由主进程按当前生效配置判定，渲染层不自己拼目录
    expect(getFfmpegStatus).toHaveBeenCalledWith()
    expect(messageMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('下载目录为空（未配置）时提示并跳设置页', async () => {
    stubConfig(async () => '')

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '请先在「设置」中配置下载目录',
      type: 'warning',
    })
    // 跳转目标取常量而非硬编码字符串，改路由时这里跟着走
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('ffmpeg 未配置时提示并跳设置页', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => ({
      ok: false,
      problem: 'unset',
      directory: '',
      binaryPath: '',
    }))

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '请先在「设置」中下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('ffmpeg 目录已失效时按「目录不存在」给出提示并跳设置页', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => ({
      ok: false,
      problem: 'missing-dir',
      directory: '/Users/z/ffmpeg',
      binaryPath: '',
    }))

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录已失效：请在「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('目录内缺 ffmpeg 二进制时给出与「目录不存在」不同的提示', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => ({
      ok: false,
      problem: 'missing-binary',
      directory: '/Users/z/ffmpeg',
      binaryPath: '',
    }))

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '该目录下没有 FFmpeg：请在「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
  })

  it('环境不可用时播放浮窗只提示主窗口设置，不跳转', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => ({
      ok: false,
      problem: 'missing-dir',
      directory: '/Users/z/ffmpeg',
      binaryPath: '',
    }))

    await expect(useDownloadGuard().checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录已失效：请在主窗口「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('查询失败时提示错误且不跳转（IPC 异常不该把人赶去设置页）', async () => {
    stubConfig(async () => {
      throw new Error('ipc down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({ message: '检查下载环境失败，请稍后重试', type: 'error' })
    expect(pushMock).not.toHaveBeenCalled()
  })
})
