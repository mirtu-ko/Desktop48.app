/**
 * 任务注册表：单一职责地管理两类状态——
 * 1. 任务快照表：渲染端刷新后通过 List 通道恢复列表，直到显式 Remove 才删除
 * 2. closePromise 表：同一 liveId 的上一进程必须完全退出（含写文件尾收尾）后
 *    才能重启，避免两个 ffmpeg 同时写同一文件
 */

export interface TaskSnapshot {
  liveId: string
  url: string
  filename: string
  filePath: string
  saveDirectory: string
  status: 'running' | 'finish' | 'error'
  startedAt: number
  error?: string
}

export class TaskRegistry {
  private readonly snapshots = new Map<string, TaskSnapshot>()
  private readonly closePromises = new Map<string, Promise<void>>()

  list(): TaskSnapshot[] {
    return Array.from(this.snapshots.values())
  }

  get(liveId: string): TaskSnapshot | undefined {
    return this.snapshots.get(liveId)
  }

  put(snapshot: TaskSnapshot): void {
    this.snapshots.set(snapshot.liveId, snapshot)
  }

  remove(liveId: string): void {
    this.snapshots.delete(liveId)
  }

  /** 正常结束（含用户 stop）记为 finish；快照不存在时静默跳过 */
  markFinish(liveId: string): void {
    const snapshot = this.snapshots.get(liveId)
    if (snapshot)
      snapshot.status = 'finish'
  }

  markError(liveId: string, message: string): void {
    const snapshot = this.snapshots.get(liveId)
    if (snapshot) {
      snapshot.status = 'error'
      snapshot.error = message
    }
  }

  waitForClose(liveId: string): Promise<void> | undefined {
    return this.closePromises.get(liveId)
  }

  registerClose(liveId: string, promise: Promise<void>): void {
    this.closePromises.set(liveId, promise)
  }

  clearClose(liveId: string): void {
    this.closePromises.delete(liveId)
  }
}
