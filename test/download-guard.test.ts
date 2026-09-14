import Constants from '@renderer/utils/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDownloadGuard } from '../src/renderer/src/composables/use-download-guard'

// useDownloadGuard 在 setup 内取 router、用 ElMessage 提示；Node 环境两者都不可用
const { pushMock, messageMock } = vi.hoisted(() => ({ pushMock: vi.fn(), messageMock: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('element-plus', () => ({ ElMessage: messageMock }))

function stubConfig(getConfig: (_key: string) => Promise<string>) {
  vi.stubGlobal('window', { mainAPI: { getConfig } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useDownloadGuard（下载/录制前的目录校验）', () => {
  it('目录已配置时放行，不提示也不跳转', async () => {
    const getConfig = vi.fn(async () => '/Users/z/Downloads')
    stubConfig(getConfig)

    await expect(useDownloadGuard().checkDownloadDirectory()).resolves.toBe(true)

    expect(getConfig).toHaveBeenCalledWith('downloadDirectory')
    expect(messageMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('目录为空（未配置）时提示并跳设置页', async () => {
    stubConfig(async () => '')

    await expect(useDownloadGuard().checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '下载目录不存在，请先配置下载目录',
      type: 'warning',
    })
    // 跳转目标取常量而非硬编码字符串，改路由时这里跟着走
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('查询失败时提示错误且不跳转（IPC 异常不该把人赶去设置页）', async () => {
    stubConfig(async () => {
      throw new Error('ipc down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useDownloadGuard().checkDownloadDirectory()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({ message: '检查下载目录失败', type: 'error' })
    expect(pushMock).not.toHaveBeenCalled()
  })
})
