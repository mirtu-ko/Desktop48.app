import type { TaskPayload, TaskSnapshot } from '@renderer/services/task-payload'
import { debugLog } from '@renderer/utils/debug'

/**
 * 任务通道适配器：收敛下载/录制两组 IPC API 的差异
 */
export interface TaskChannelAdapter {
  start: (_url: string, _filename: string, _liveId: string) => Promise<any>
  progress: (_callback: (_liveId: string, _time: string) => void) => () => void
  end: (_callback: (_liveId: string, _filePath: string) => void) => () => void
  error: (_callback: (_liveId: string, _error: any) => void) => () => void
  stop: (_liveId: string) => void
}

/**
 * 任务状态。
 * - prepared：已创建、尚未启动成功
 * - running：主进程 ffmpeg 正在跑
 * - finished：已完成 / 被停止 / 出错（三者都终止任务，故共用一个状态）
 */
export type TaskStatus = 'prepared' | 'running' | 'finished'

/**
 * 一个下载/录制任务的完整状态：**普通对象，没有任何方法**。
 *
 * 它的变化（status / filePath）之所以能驱动视图，靠的是它被放进 store 的
 * ref 列表后由 Vue 建立依赖追踪——不需要 class 的 getter/setter，也不需要
 * 手动 reactive() 加类型断言那套技巧。
 */
export interface TaskState {
  /** 唯一键：直播 / 回放的 liveId */
  liveId: string
  /** 源地址：下载为 HLS，录制为 RTMP */
  url: string
  /** 文件名（不含目录） */
  filename: string
  /** 落盘绝对路径：start 时算出、end 时由主进程回填；未就绪时为空串 */
  filePath: string
  /** 保存目录：启动时从配置读取，供「打开文件夹」使用 */
  saveDirectory: string
  status: TaskStatus
  /** 已注册的 IPC 监听器取消函数（基础设施字段，不是业务数据）：任务终止时清空，避免泄漏 */
  unsubscribers: Array<() => void>
}

/** 任务正常完成的回调：由 store 注入用于弹提示（本模块不直接碰 UI） */
export type TaskEndListener = (_task: TaskState) => void

/** 纯工厂：只组装初始数据，不产生任何副作用 */
export function createTaskState(payload: TaskPayload): TaskState {
  return {
    liveId: payload.liveId,
    url: payload.url,
    filename: payload.filename,
    filePath: '',
    saveDirectory: '',
    status: 'prepared',
    unsubscribers: [],
  }
}

/** 移除该任务已注册的全部 IPC 监听器（幂等） */
function cleanupListeners(task: TaskState) {
  for (const unsubscribe of task.unsubscribers)
    unsubscribe()
  task.unsubscribers.length = 0
}

/**
 * 注册任务结束（end / error）监听器；start 与 restore 共用。
 * 两者都把任务置为 finished，差别只在 error 额外打日志、且不触发完成提示。
 */
function subscribeEndEvents(
  task: TaskState,
  channels: TaskChannelAdapter,
  logTag: string,
  onEnd?: TaskEndListener,
) {
  task.unsubscribers.push(channels.end((liveId: string, filePath: string) => {
    if (liveId !== task.liveId)
      return
    task.filePath = filePath
    task.status = 'finished'
    cleanupListeners(task)
    onEnd?.(task)
    debugLog('tasks', `[${logTag}] task end:`, liveId)
  }))
  task.unsubscribers.push(channels.error((liveId: string, error: any) => {
    if (liveId !== task.liveId)
      return
    console.error(`[${logTag}] task error`, error)
    task.status = 'finished'
    cleanupListeners(task)
  }))
}

/**
 * 启动任务：读保存目录 → 拼落盘路径 → 订阅事件 → 下发 IPC。
 *
 * 直接改写 task 上的字段，store 侧看到的就是同一份状态。
 * 失败时自行清理已注册的监听器后抛出，由调用方决定提示与列表处理。
 */
export async function startTask(
  task: TaskState,
  channels: TaskChannelAdapter,
  logTag: string,
  onEnd?: TaskEndListener,
): Promise<void> {
  // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts 的 'getConfig'
  task.saveDirectory = await window.mainAPI.getConfig('downloadDirectory', '')
  if (!task.saveDirectory)
    throw new Error('保存目录为空')

  // ★ 跨进程：路径拼接交给主进程，避免渲染层猜测平台分隔符（对端 main/ipc/register-system-ipc.ts）
  task.filePath = await window.mainAPI.pathJoin(task.saveDirectory, task.filename)

  // 先注册监听器，避免 ffmpeg 启动后立即发送的事件丢失
  task.unsubscribers.push(channels.progress((liveId: string, time: string) => {
    // progress 每个 ffmpeg 心跳都触发，用 debug 门控避免生产环境控制台被刷屏
    if (liveId === task.liveId)
      debugLog('tasks', `[${logTag}] task progress:`, liveId, time)
  }))
  subscribeEndEvents(task, channels, logTag, onEnd)

  try {
    debugLog('tasks', `[${logTag}] task start:`, task.url, task.filename, task.liveId)
    await channels.start(task.url, task.filename, task.liveId)
    task.status = 'running'
  }
  catch (error) {
    cleanupListeners(task)
    console.error(`[${logTag}] task start failed`, error)
    throw error
  }
}

/**
 * 从主进程快照恢复任务状态。
 * 渲染端刷新（F5）后原页面与监听器已销毁，主进程 ffmpeg 仍在运行；
 * 这里根据快照重建状态，若任务仍在运行则重新订阅结束事件以续接其生命周期。
 */
export function restoreTask(
  task: TaskState,
  snapshot: TaskSnapshot,
  channels: TaskChannelAdapter,
  logTag: string,
  onEnd?: TaskEndListener,
): void {
  task.saveDirectory = snapshot.saveDirectory
  task.filePath = snapshot.filePath
  task.status = snapshot.status === 'running' ? 'running' : 'finished'
  if (task.status === 'running')
    subscribeEndEvents(task, channels, logTag, onEnd)
}

/** 停止任务：已是终态则什么都不做 */
export function stopTask(task: TaskState, channels: TaskChannelAdapter, logTag: string): void {
  if (task.status !== 'running')
    return
  channels.stop(task.liveId)
  task.status = 'finished'
  cleanupListeners(task)
  debugLog('tasks', `[${logTag}] task stop`)
}

/** 在系统文件管理器中打开该任务的保存目录 */
export function openSaveDirectory(task: TaskState): void {
  if (!task.saveDirectory) {
    console.error('saveDirectory is not initialized')
    return
  }
  // ★ 跨进程：preload/index.ts → main/ipc/register-system-ipc.ts 的 'openPath'
  window.mainAPI.openPath(task.saveDirectory)
}
