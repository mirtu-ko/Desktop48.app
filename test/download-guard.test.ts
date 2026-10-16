import Constants from '@renderer/utils/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDownloadGuard } from '../src/renderer/src/composables/use-download-guard'

// useDownloadGuard 用 ElMessage 提示；主窗口 Router 直接注入替身，避免依赖组件上下文
const { pushMock, messageMock } = vi.hoisted(() => ({ pushMock: vi.fn(), messageMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: messageMock }))

const fakeRouter = { push: pushMock } as any

function stubConfig(
  getConfig: (_key: string) => Promise<string>,
  checkFfmpegBinaries: () => Promise<boolean> = async () => true,
) {
  vi.stubGlobal('window', { mainAPI: { getConfig, checkFfmpegBinaries } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useDownloadGuard（下载/录制前的环境校验）', () => {
  it('下载目录与 FFmpeg 都可用时放行，不提示也不跳转', async () => {
    const getConfig = vi.fn(async () => '/Users/z/Downloads')
    const checkFfmpegBinaries = vi.fn(async () => true)
    stubConfig(getConfig, checkFfmpegBinaries)

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(true)

    expect(getConfig).toHaveBeenCalledWith('downloadDirectory')
    expect(checkFfmpegBinaries).toHaveBeenCalledWith('/Users/z/Downloads')
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

  it('ffmpeg 目录为空时提示并跳设置页', async () => {
    stubConfig(async key => (key === 'downloadDirectory' ? '/Users/z/Downloads' : ''))

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '请先在「设置」中下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('ffmpeg 目录失效时提示并跳设置页', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => {
      throw new Error('ffmpeg 不存在')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useDownloadGuard(fakeRouter).checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录不可用，请到「设置」重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('ffmpeg 目录失效时播放浮窗只提示主窗口设置，不跳转也不误报环境检查失败', async () => {
    stubConfig(async () => '/Users/z/Downloads', async () => {
      throw new Error('ffmpeg 不存在')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useDownloadGuard().checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录不可用，请到主窗口「设置」重新下载或选择 FFmpeg 目录',
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
