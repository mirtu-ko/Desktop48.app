/**
 * ⚠️ 全局单例 store（原 composables/tasks/use-tasks.ts）
 *
 * 下载 / 录制任务的状态定义在模块作用域，**不随任何组件卸载而销毁**：
 * 任何页面调用 useTasksStore() 拿到的都是同一份任务列表。
 * 因此这里不叫 use-tasks 那种"组合式函数"名字——它不是组件私有状态。
 *
 * 本文件只负责「响应式 + 列表 + 用户提示」；任务的生命周期动作
 * （启动 / 恢复 / 停止 / 打开目录）都在 services/task-runtime.ts，那里是
 * 纯普通对象操作，不依赖 Vue。
 */

import type { TaskPayload, TaskSnapshot } from '@renderer/services/task-payload'
import type { TaskChannelAdapter, TaskState } from '@renderer/services/task-runtime'
import type { Ref } from 'vue'
import { createTaskState, decideTaskMerge, openSaveDirectory, restoreTask, startTask, stopTask } from '@renderer/services/task-runtime'
import { debugLog } from '@renderer/utils/debug'
import { ElMessage } from 'element-plus'
import { reactive, ref } from 'vue'

export type TaskKind = 'download' | 'record'

interface TaskKindConfig {
  channels: TaskChannelAdapter
  /** 主进程广播的「任务已登记」订阅：其它窗口据此把任务补进本地镜像列表 */
  started: (_callback: (_snapshot: TaskSnapshot) => void) => () => void
  list: Ref<TaskState[]>
  listApi: () => Promise<TaskSnapshot[]>
  removeApi: (_liveId: string) => Promise<void>
  runningMessage: string
  startMessage: string
  restartMessage: string
  /** 任务完成提示文案（正常结束；手动停止与出错不提示，另有状态展示） */
  endMessage: string
  logTag: string
}

// 任务通道是双向的：invoke 发起任务，主进程经 ipcRenderer.on 回推状态。
// store 是单个渲染进程内的单例；独立播放窗是另一个进程，每个窗口都要
// installTasks() 各自镜像主进程注册表，由广播事件保持同步。
const downloadTasks = ref<TaskState[]>([])
const recordTasks = ref<TaskState[]>([])

// 下载/录制两类任务的差异配置：处理骨架完全一致
const taskConfigs: Record<TaskKind, TaskKindConfig> = {
  download: {
    channels: {
      start: window.mainAPI.downloadTaskStart,
      progress: window.mainAPI.downloadTaskProgress,
      end: window.mainAPI.downloadTaskEnd,
      error: window.mainAPI.downloadTaskError,
      stop: window.mainAPI.downloadTaskStop,
    },
    list: downloadTasks,
    started: window.mainAPI.downloadTaskStarted,
    listApi: () => window.mainAPI.downloadTaskList(),
    removeApi: liveId => window.mainAPI.downloadTaskRemove(liveId),
    runningMessage: '该回放正在下载',
    startMessage: '下载开始',
    restartMessage: '下载已重新开始，原任务将被覆盖',
    endMessage: '下载完成',
    logTag: 'download',
  },
  record: {
    channels: {
      start: window.mainAPI.recordTaskStart,
      progress: window.mainAPI.recordTaskProgress,
      end: window.mainAPI.recordTaskEnd,
      error: window.mainAPI.recordTaskError,
      stop: window.mainAPI.recordTaskStop,
    },
    list: recordTasks,
    started: window.mainAPI.recordTaskStarted,
    listApi: () => window.mainAPI.recordTaskList(),
    removeApi: liveId => window.mainAPI.recordTaskRemove(liveId),
    runningMessage: '该直播正在录制',
    startMessage: '录制开始',
    restartMessage: '录制已重新开始，原任务将被覆盖',
    endMessage: '录制完成',
    logTag: 'record',
  },
}

/**
 * 新建任务：普通对象直接放进 reactive 即成响应式，
 * 之后 task.status / task.filePath 的每次赋值都会自动刷新下载页卡片与播放器按钮。
 */
function newTask(payload: TaskPayload): TaskState {
  return reactive(createTaskState(payload))
}

/** 任务正常完成的提示：带文件名，多任务并行时能区分是哪一个完成 */
function onTaskEnd(config: TaskKindConfig) {
  return (task: TaskState) => ElMessage({ message: `${task.filename} ${config.endMessage}`, type: 'success' })
}

/**
 * 入列 + 启动 + 提示。
 *
 * 先同步入列再异步启动：handleTask 查重与 isTaskRunning 都依赖列表，
 * 若等 start（多次串行 IPC 往返，数百毫秒）完成后再入列，窗口期内的
 * 重复触发会查不到任务，进而创建同 liveId 的重复任务。
 */
async function launchTask(task: TaskState, config: TaskKindConfig, message: string) {
  const existedBefore = config.list.value.includes(task)
  if (!existedBefore)
    config.list.value.push(task)
  try {
    await startTask(task, config.channels, config.logTag, onTaskEnd(config))
    ElMessage({ message, type: 'success' })
  }
  catch (error) {
    // 新任务启动失败则移除占位，避免留下永不运行的卡片；
    // 重启路径的任务本就在列表中，维持原状（保留其原状态展示）
    if (!existedBefore) {
      const index = config.list.value.indexOf(task)
      if (index !== -1)
        config.list.value.splice(index, 1)
    }
    console.error(`[stores/tasks] ${config.logTag} task start failed`, error)
    ElMessage({ message: String(error), type: 'error' })
  }
}

async function handleTask(payload: TaskPayload, kind: TaskKind) {
  const config = taskConfigs[kind]
  const exists = config.list.value.find(item => item.liveId === payload.liveId)
  if (exists) {
    if (exists.status === 'running') {
      debugLog('tasks', kind, payload.liveId, '任务已在运行，忽略本次发起')
      ElMessage({ message: config.runningMessage, type: 'warning' })
      return
    }
    // 任务已结束：按最新参数重启（覆盖原文件）
    debugLog('tasks', kind, payload.liveId, '重启已结束任务（覆盖原文件）:', payload.filename)
    exists.url = payload.url
    exists.filename = payload.filename
    await launchTask(exists, config, config.restartMessage)
    return
  }
  debugLog('tasks', kind, payload.liveId, '发起新任务:', payload.filename)
  await launchTask(newTask(payload), config, config.startMessage)
}

/**
 * 移除任务卡片，并同步删除主进程快照（否则刷新后任务会再次出现）。
 * ⚠️ 删除不广播（TaskEventMap 无 Removed 通道）：目前只有主窗口能删除，故无可见影响；
 * 将来若在播放窗也加删除入口，必须先补 Removed 广播，否则两窗镜像会分叉。
 */
async function removeTask(task: TaskState, kind: TaskKind) {
  const config = taskConfigs[kind]
  const index = config.list.value.findIndex(item => item.liveId === task.liveId)
  if (index !== -1)
    config.list.value.splice(index, 1)
  await config.removeApi(task.liveId)
}

/**
 * 把主进程广播的「任务已登记」快照并入本地列表（判据见 task-runtime.ts 的 decideTaskMerge）。
 * 镜像一律不挂完成提示：提示只由发起窗口给，避免两个窗口各弹一次。
 */
function mergeStartedTask(snapshot: TaskSnapshot, config: TaskKindConfig) {
  const decision = decideTaskMerge(config.list.value, snapshot)
  if (decision.action === 'skip')
    return

  if (decision.action === 'resync') {
    restoreTask(decision.existing, snapshot, config.channels, config.logTag)
    return
  }

  const task = newTask({ url: snapshot.url, filename: snapshot.filename, liveId: snapshot.liveId })
  restoreTask(task, snapshot, config.channels, config.logTag)
  config.list.value.push(task)
  debugLog('tasks', `并入其它窗口发起的 ${config.logTag} 任务:`, snapshot.liveId)
}

/**
 * 从主进程快照恢复任务列表。
 * 刷新不会清空主进程实际运行的 ffmpeg，任务状态仍以主进程为准。
 * silent 用于播放窗：它只做静默镜像，不重复弹完成提示。
 */
async function restoreTasks(kind: TaskKind, silent: boolean) {
  const config = taskConfigs[kind]
  const snapshots = await config.listApi()
  debugLog('tasks', `从主进程恢复 ${kind} 任务快照: ${snapshots.length} 个`)
  for (const snapshot of snapshots) {
    // 已有同 liveId 任务则跳过，避免重复卡片
    if (config.list.value.some(item => item.liveId === snapshot.liveId))
      continue
    const task = newTask({ url: snapshot.url, filename: snapshot.filename, liveId: snapshot.liveId })
    restoreTask(task, snapshot, config.channels, config.logTag, silent ? undefined : onTaskEnd(config))
    config.list.value.push(task)
  }
}

/** 该直播/回放的任务是否正在运行：供播放器按钮展示状态 */
function isTaskRunning(kind: TaskKind, liveId: string): boolean {
  return taskConfigs[kind].list.value.some(task => task.liveId === liveId && task.status === 'running')
}

/**
 * 按 liveId 停止任务：下载页卡片与播放器按钮共用这一个入口。
 * 优先走列表里的任务对象，让状态与卡片展示共用同一份真相。
 */
function stopTaskByLiveId(kind: TaskKind, liveId: string) {
  const config = taskConfigs[kind]
  const task = config.list.value.find(item => item.liveId === liveId)
  if (task) {
    stopTask(task, config.channels, config.logTag)
    return
  }
  // 快照尚未恢复等情况下本地没有任务对象，退回 IPC，保证停止指令一定送达主进程
  config.channels.stop(liveId)
}

let restored = false
let installed = false

/** 首次调用时从主进程恢复一次任务快照（幂等） */
async function ensureRestored(silent: boolean) {
  if (restored)
    return
  restored = true
  await Promise.all([restoreTasks('download', silent), restoreTasks('record', silent)])
}

/** 应用级安装：订阅任务事件并恢复快照，每个窗口都要调用；silent 模式只镜像不弹提示 */
export function installTasks(options: { silent?: boolean } = {}) {
  if (installed)
    return
  installed = true
  // 订阅「任务已登记」广播：把其它窗口发起的任务补进本窗口列表
  for (const config of Object.values(taskConfigs))
    config.started(snapshot => mergeStartedTask(snapshot, config))
  // 应用启动即恢复一次：播放器可能在下载页从未挂载过的情况下进入，
  // 此时也要能正确显示「录制中」并能停止
  void ensureRestored(options.silent ?? false).catch((error: any) => {
    console.error('[stores/tasks] 恢复任务列表失败:', error)
  })
}

/** 任务 store：下载 / 录制任务的全局状态与操作（模块级单例，见文件头说明） */
export function useTasksStore() {
  return {
    downloadTasks,
    recordTasks,
    handleTask,
    removeTask,
    isTaskRunning,
    stopTaskByLiveId,
    openSaveDirectory,
  }
}

export type { TaskState }
export default useTasksStore
