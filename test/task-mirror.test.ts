import type { TaskState } from '../src/renderer/src/services/task-runtime'
import { describe, expect, it } from 'vitest'
import { decideTaskMerge } from '../src/renderer/src/services/task-runtime'

/**
 * 跨窗任务镜像的并入判据（stores/tasks.ts 的 mergeStartedTask 核心）。
 * 这段逻辑决定「主进程广播的 Started 快照要不要在本窗口补卡片 / 重新对齐」。
 */

function makeTask(liveId: string, unsubscriberCount: number): TaskState {
  return {
    liveId,
    url: 'http://example.com/stream',
    filename: `${liveId}.mp4`,
    filePath: `/downloads/${liveId}.mp4`,
    saveDirectory: '/downloads',
    status: unsubscriberCount > 0 ? 'running' : 'finished',
    unsubscribers: Array.from({ length: unsubscriberCount }, () => () => {}),
  }
}

const runningSnapshot = { liveId: 'live-1', url: 'u', filename: 'f', filePath: '/p', saveDirectory: '/d', status: 'running' as const, startedAt: 0 }

describe('decideTaskMerge', () => {
  it('本窗口发起：列表已有且在跟踪 → skip（不重复建卡片、不重复弹提示）', () => {
    const list = [makeTask('live-1', 2)]
    expect(decideTaskMerge(list, runningSnapshot).action).toBe('skip')
  })

  it('本窗口已结束的任务被重启：有卡片但监听器已清空 → resync（按快照重新对齐）', () => {
    // startTask 失败 / 任务结束后 cleanupListeners 会清空 unsubscribers，
    // 此时列表里留着卡片但没人跟踪它，必须重新挂监听器
    const list = [makeTask('live-1', 0)]
    const decision = decideTaskMerge(list, runningSnapshot)
    expect(decision.action).toBe('resync')
    if (decision.action === 'resync')
      expect(decision.existing).toBe(list[0])
  })

  it('其它窗口发起：列表没有该 liveId → mirror（新建镜像卡片）', () => {
    expect(decideTaskMerge([makeTask('other', 2)], runningSnapshot).action).toBe('mirror')
    expect(decideTaskMerge([], runningSnapshot).action).toBe('mirror')
  })

  it('快照非 running 时不做 resync（已结束的任务无需补监听器）', () => {
    const list = [makeTask('live-1', 0)]
    const finished = { ...runningSnapshot, status: 'finish' as const }
    expect(decideTaskMerge(list, finished).action).toBe('skip')
  })

  it('按 liveId 匹配，不受列表顺序影响', () => {
    const list = [makeTask('a', 0), makeTask('live-1', 1), makeTask('b', 0)]
    expect(decideTaskMerge(list, runningSnapshot).action).toBe('skip')
  })
})
