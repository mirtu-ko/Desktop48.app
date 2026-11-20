import type { TaskChannelAdapter } from '../src/renderer/src/services/task-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskState, startTask, stopTask } from '../src/renderer/src/services/task-runtime'

/**
 * 任务启动的状态流转。
 * 不变量：startTask 一进入就是 starting，直到确认 running——这段窗口内重复发起
 * 必须被挡住（stores/tasks.ts 的 handleTask 依赖它），否则会拉起两个写同一文件的 ffmpeg。
 */

function stubMainAPI(getConfig: () => Promise<string> = async () => '/downloads') {
  const pathJoin = vi.fn(async (...parts: string[]) => parts.join('/'))
  vi.stubGlobal('window', { mainAPI: { getConfig, pathJoin } })
  return { pathJoin }
}

/** 通道替身：subscribe 类通道只记录退订函数，用于断言失败/停止时清理干净 */
function makeChannels(startImpl: () => Promise<unknown>) {
  const start = vi.fn(startImpl)
  const stop = vi.fn()
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = []
  const subscribe = () => {
    const off = vi.fn()
    unsubscribers.push(off)
    return off
  }
  const channels: TaskChannelAdapter = { start, progress: subscribe, end: subscribe, error: subscribe, stop }
  return { channels, start, stop, unsubscribers }
}

const payload = { url: 'https://example.com/a.m3u8', filename: '甲202611210355.mp4', liveId: 'live-1' }

/** 让 startTask 跑到 channels.start 那一步（前面还有 getConfig / pathJoin 两次往返） */
const waitStartCalled = (start: ReturnType<typeof vi.fn>) => vi.waitFor(() => expect(start).toHaveBeenCalled())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('startTask / stopTask（任务状态机）', () => {
  it('调用即 starting，start 返回后才 running', async () => {
    stubMainAPI()
    let finishStart: () => void = () => {}
    const { channels, start } = makeChannels(() => new Promise<void>((resolve) => {
      finishStart = resolve
    }))
    const task = createTaskState(payload)

    const started = startTask(task, channels, 'test')
    // 同步断言：不能留给调用方任何「再点一次」的窗口
    expect(task.status).toBe('starting')

    await waitStartCalled(start)
    expect(task.status).toBe('starting')

    finishStart()
    await started
    expect(task.status).toBe('running')
  })

  it('启动失败落到 finished 并清掉监听器（同 liveId 之后仍可再次发起）', async () => {
    stubMainAPI()
    const { channels, unsubscribers } = makeChannels(async () => {
      throw new Error('spawn 失败')
    })
    const task = createTaskState(payload)

    await expect(startTask(task, channels, 'test')).rejects.toThrow('spawn 失败')

    expect(task.status).toBe('finished')
    expect(unsubscribers.length).toBeGreaterThan(0)
    for (const off of unsubscribers)
      expect(off).toHaveBeenCalled()
  })

  it('保存目录缺失时不会停在 starting', async () => {
    stubMainAPI(async () => '')
    const { channels } = makeChannels(async () => {})
    const task = createTaskState(payload)

    await expect(startTask(task, channels, 'test')).rejects.toThrow('保存目录为空')
    expect(task.status).toBe('finished')
  })

  it('启动期间被结束：不下发 stop（此刻主进程还没挂监听），start 返回后补发', async () => {
    stubMainAPI()
    let finishStart: () => void = () => {}
    const { channels, start, stop } = makeChannels(() => new Promise<void>((resolve) => {
      finishStart = resolve
    }))
    const task = createTaskState(payload)

    const started = startTask(task, channels, 'test')
    await waitStartCalled(start)

    stopTask(task, channels, 'test')
    expect(task.status).toBe('finished')
    expect(stop).not.toHaveBeenCalled()

    finishStart()
    await started
    // 补发后仍不能回到 running，否则会留下一张没人跟踪的「运行中」卡片
    expect(task.status).toBe('finished')
    expect(stop).toHaveBeenCalledWith('live-1')
  })

  it('运行中结束：立即下发 stop 并置 finished', async () => {
    stubMainAPI()
    const { channels, stop } = makeChannels(async () => {})
    const task = createTaskState(payload)

    await startTask(task, channels, 'test')
    expect(task.status).toBe('running')

    stopTask(task, channels, 'test')
    expect(stop).toHaveBeenCalledWith('live-1')
    expect(task.status).toBe('finished')
  })

  it('已结束的任务再 stop 不重复下发', async () => {
    stubMainAPI()
    const { channels, stop } = makeChannels(async () => {})
    const task = createTaskState(payload)

    await startTask(task, channels, 'test')
    stopTask(task, channels, 'test')
    stopTask(task, channels, 'test')

    expect(stop).toHaveBeenCalledTimes(1)
  })
})
