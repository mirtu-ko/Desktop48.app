import type { FfmpegStatus, FloatPlayerPayload } from '@preload/ipc-contract'
import Constants from '@renderer/utils/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLiveGuard } from '../src/renderer/src/composables/use-live-guard'
import { useFloatPlayersStore } from '../src/renderer/src/stores/float-players'

// 守卫用 ElMessage 提示；Router 直接注入替身，避免依赖组件上下文
const { pushMock, messageMock } = vi.hoisted(() => ({ pushMock: vi.fn(), messageMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: messageMock }))

const fakeRouter = { push: pushMock } as any

/** 就绪状态的基准值：各用例只覆盖自己关心的字段 */
const READY: FfmpegStatus = { ok: true, problem: null, directory: '/opt/ffmpeg', binaryPath: '/opt/ffmpeg/ffmpeg' }

/** 不可用状态：problem 由用例指定 */
function broken(problem: FfmpegStatus['problem'], directory = ''): FfmpegStatus {
  return { ok: false, problem, directory, binaryPath: '' }
}

function stubFfmpeg(getFfmpegStatus: (_dir?: string) => Promise<FfmpegStatus>) {
  vi.stubGlobal('window', { mainAPI: { getFfmpegStatus } })
}

/** 等待 openLive 内部的异步校验跑完（openLive 保持同步签名，校验在内部进行） */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(async () => {
  // 单飞状态挂在模块上：不清场的话下一个用例会拿到上一次的判定结果
  await flush()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useLiveGuard（开播前的 FFmpeg 校验）', () => {
  it('ffmpeg 可用时放行，不提示也不跳转', async () => {
    const getFfmpegStatus = vi.fn(async () => READY)
    stubFfmpeg(getFfmpegStatus)

    await expect(useLiveGuard(fakeRouter).checkLiveReady()).resolves.toBe(true)

    // 不传 dir：由主进程按当前生效配置判定，渲染层不自己拼目录
    expect(getFfmpegStatus).toHaveBeenCalledWith()
    expect(messageMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('未配置时说明「看直播为什么需要 FFmpeg」，并跳设置页', async () => {
    stubFfmpeg(async () => broken('unset'))

    await expect(useLiveGuard(fakeRouter).checkLiveReady()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '直播播放需要 FFmpeg，请先在「设置」中下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    // 跳转目标取常量而非硬编码字符串，改路由时这里跟着走
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('目录失效时按「目录不存在」给出提示并跳设置页', async () => {
    stubFfmpeg(async () => broken('missing-dir', '/Users/z/ffmpeg'))

    await expect(useLiveGuard(fakeRouter).checkLiveReady()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录已失效，请在「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).toHaveBeenCalledWith(Constants.Menu.SETTING)
  })

  it('目录内缺 ffmpeg 二进制时给出与「目录不存在」不同的提示', async () => {
    stubFfmpeg(async () => broken('missing-binary', '/Users/z/ffmpeg'))

    await expect(useLiveGuard(fakeRouter).checkLiveReady()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: '该目录下没有 FFmpeg，请在「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
  })

  it('拿不到 Router 时（非 setup 上下文 / 播放窗）只提示主窗口设置，不跳转', async () => {
    stubFfmpeg(async () => broken('missing-dir', '/Users/z/ffmpeg'))

    // 不显式注入 Router，也不安装全局 Router：三级回落全部落空
    await expect(useLiveGuard().checkLiveReady()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({
      message: 'FFmpeg 目录已失效，请在主窗口「设置」中重新下载或选择 FFmpeg 目录',
      type: 'warning',
    })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('查询失败时提示错误且不跳转（IPC 异常不该把人赶去设置页）', async () => {
    stubFfmpeg(async () => {
      throw new Error('ipc down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useLiveGuard(fakeRouter).checkLiveReady()).resolves.toBe(false)

    expect(messageMock).toHaveBeenCalledWith({ message: '检查播放环境失败，请稍后重试', type: 'error' })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('连点多次只判定一次、只提示一次', async () => {
    const getFfmpegStatus = vi.fn(async () => broken('unset'))
    stubFfmpeg(getFfmpegStatus)

    const results = await Promise.all([
      useLiveGuard(fakeRouter).checkLiveReady(),
      useLiveGuard(fakeRouter).checkLiveReady(),
      useLiveGuard(fakeRouter).checkLiveReady(),
    ])

    expect(results).toEqual([false, false, false])
    expect(getFfmpegStatus).toHaveBeenCalledTimes(1)
    expect(messageMock).toHaveBeenCalledTimes(1)
  })
})

describe('openLive 的开播前置校验（stores/float-players.ts）', () => {
  const payload: FloatPlayerPayload = {
    liveId: 'live-1',
    nickname: '测试成员',
    title: '测试直播',
    startTime: 1700000000000,
    liveType: 1,
    liveMode: 0,
  }

  it('ffmpeg 不可用时不开窗（不开一个必然空转的播放窗）', async () => {
    const openFloatWindow = vi.fn(async () => {})
    vi.stubGlobal('window', {
      mainAPI: { getFfmpegStatus: async () => broken('missing-binary', '/Users/z/ffmpeg'), openFloatWindow },
    })

    useFloatPlayersStore().openLive(payload)
    await flush()

    expect(messageMock).toHaveBeenCalledTimes(1)
    expect(openFloatWindow).not.toHaveBeenCalled()
  })

  it('ffmpeg 可用时照常开窗', async () => {
    const openFloatWindow = vi.fn(async () => {})
    vi.stubGlobal('window', {
      mainAPI: { getFfmpegStatus: async () => READY, openFloatWindow },
    })

    useFloatPlayersStore().openLive(payload)
    await vi.waitFor(() => expect(openFloatWindow).toHaveBeenCalledWith('live', payload))
  })

  it('回放窗不需要 FFmpeg 转流，不做校验', async () => {
    const getFfmpegStatus = vi.fn(async () => broken('unset'))
    const openFloatWindow = vi.fn(async () => {})
    vi.stubGlobal('window', { mainAPI: { getFfmpegStatus, openFloatWindow } })

    useFloatPlayersStore().openPlayback(payload)
    await flush()

    expect(getFfmpegStatus).not.toHaveBeenCalled()
    expect(openFloatWindow).toHaveBeenCalledWith('playback', payload)
  })
})
