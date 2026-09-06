import type { Ref } from 'vue'
import type { TaskChannelAdapter } from '../../services/task-base'
import type { TaskPayload, TaskSnapshot } from '../../services/task-payload'
import { ElMessage } from 'element-plus'
import { reactive, ref } from 'vue'
import { subscribe } from '../../services/event-bus'
import TaskBase from '../../services/task-base'
import { debugLog } from '../../utils/debug'

export type TaskKind = 'download' | 'record'

interface TaskKindConfig {
  channels: TaskChannelAdapter
  list: Ref<TaskBase[]>
  listApi: () => Promise<TaskSnapshot[]>
  removeApi: (_liveId: string) => Promise<void>
  runningMessage: string
  startMessage: string
  restartMessage: string
  logTag: string
}

// ★ 跨进程：下方 taskConfigs 里的 downloadTask* / recordTask* 通道全部经
// preload/index.ts 转到 main/ipc/register-task-ipc.ts（机制在 main/ffmpeg/register-ffmpeg-task.ts）。
// 与其它 IPC 不同，这组是**双向**的：invoke 发起任务，主进程再用 ipcRenderer.on
// 持续回推 progress / end / error 事件（见 preload 里返回 unsubscribe 的那几个）。
//
// 模块级单例：任务不随 Downloads 页面卸载而消失。
// 否则在列表页/悬浮迷你窗发起的录制会因为 Downloads 未挂载而丢失事件，
// 只能靠「先跳到下载页」这种副作用来保证任务被接住。
const downloadTasks = ref([]) as Ref<TaskBase[]>
const recordTasks = ref([]) as Ref<TaskBase[]>

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
    listApi: () => window.mainAPI.downloadTaskList(),
    removeApi: liveId => window.mainAPI.downloadTaskRemove(liveId),
    runningMessage: '该回放正在下载',
    startMessage: '下载开始',
    restartMessage: '下载已重新开始，原任务将被覆盖',
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
    listApi: () => window.mainAPI.recordTaskList(),
    removeApi: liveId => window.mainAPI.recordTaskRemove(liveId),
    runningMessage: '该直播正在录制',
    startMessage: '录制开始',
    restartMessage: '录制已重新开始，原任务将被覆盖',
    logTag: 'record',
  },
}

/** 由类型差异配置直接构造任务实例（替代原 DownloadTask/RecordTask 薄子类） */
function createTask(kind: TaskKind, taskData: TaskPayload): TaskBase {
  return new TaskBase(taskConfigs[kind].channels, taskData.url, taskData.filename, taskData.liveId, taskConfigs[kind].logTag)
}

async function startTask(task: TaskBase, config: TaskKindConfig, message: string) {
  // 用 reactive 包裹后再 push：任务类字段都是普通属性（TS private 编译产物），
  // Proxy 完全透明不会破坏方法；关键是 start()/end 回调里 this 绑定到代理，
  // _status 的每次赋值都走 Proxy set，从而驱动下载页卡片与播放器按钮自动刷新
  const reactiveTask = reactive(task) as TaskBase
  try {
    await reactiveTask.start(() => {
      ElMessage({ message, type: 'info' })
    })
    // 重启路径下任务已在列表中，避免重复 push 导致卡片重复
    if (!config.list.value.includes(reactiveTask))
      config.list.value.push(reactiveTask)
  }
  catch (error) {
    console.error(`[use-tasks] ${config.logTag} task start failed`, error)
    ElMessage({ message: String(error), type: 'error' })
  }
}

async function handleTask(taskData: TaskPayload, kind: TaskKind) {
  const config = taskConfigs[kind]
  const exists = config.list.value.find(item => item.getLiveId() === taskData.liveId)
  if (exists) {
    if (exists.isRunning()) {
      debugLog('tasks', kind, taskData.liveId, '任务已在运行，忽略本次发起')
      ElMessage({ message: config.runningMessage, type: 'warning' })
      return
    }
    // 任务已结束：按最新参数重启（覆盖原文件）
    debugLog('tasks', kind, taskData.liveId, '重启已结束任务（覆盖原文件）:', taskData.filename)
    exists.setUrl(taskData.url)
    exists.setFilename(taskData.filename)
    await startTask(exists, config, config.restartMessage)
    return
  }
  debugLog('tasks', kind, taskData.liveId, '发起新任务:', taskData.filename)
  await startTask(createTask(kind, taskData), config, config.startMessage)
}

async function removeTask(task: TaskBase, kind: TaskKind) {
  const config = taskConfigs[kind]
  const index = config.list.value.findIndex(item => item.getLiveId() === task.getLiveId())
  if (index !== -1)
    config.list.value.splice(index, 1)
  // 同步删除主进程快照，否则刷新后该任务会再次出现
  await config.removeApi(task.getLiveId())
}

// 刷新不会清空主进程实际运行的 ffmpeg，任务状态仍以主进程为准
async function restoreTasks(kind: TaskKind) {
  const config = taskConfigs[kind]
  const snapshots = await config.listApi()
  debugLog('tasks', `从主进程恢复 ${kind} 任务快照: ${snapshots.length} 个`)
  for (const snapshot of snapshots) {
    // 已有同 liveId 任务则跳过，避免重复卡片
    if (config.list.value?.some(item => item.getLiveId() === snapshot.liveId))
      continue
    const task = createTask(kind, { url: snapshot.url, filename: snapshot.filename, liveId: snapshot.liveId })
    task.restore(snapshot)
    // 与 startTask 同样用 reactive 包裹，保证 restore 后的状态变化也走 Proxy
    config.list.value?.push(reactive(task) as TaskBase)
  }
}

/** 该直播/回放的任务是否正在运行：供播放器按钮展示状态 */
function isTaskRunning(kind: TaskKind, liveId: string): boolean {
  return taskConfigs[kind].list.value.some(task => task.getLiveId() === liveId && task.isRunning())
}

/** 停止任务：优先走任务对象，让状态与下载页卡片共用同一份真相 */
function stopTask(kind: TaskKind, liveId: string) {
  const config = taskConfigs[kind]
  const task = config.list.value.find(item => item.getLiveId() === liveId)
  if (task) {
    task.stop()
    return
  }
  // 快照尚未恢复等情况下本地没有任务对象，退回 IPC，保证停止指令一定送达主进程
  config.channels.stop(liveId)
}

let restored = false
let installed = false
let unsubscribe: Array<() => void> = []

/** 首次调用时从主进程恢复一次任务快照（幂等） */
async function ensureRestored() {
  if (restored)
    return
  restored = true
  await Promise.all([restoreTasks('download'), restoreTasks('record')])
}

/**
 * 应用级安装：由入口 main.ts 显式调用一次，注册事件订阅并恢复一次任务快照。
 *  副作用从"import 即执行"改为"显式安装"，消除 import 顺序依赖与 HMR 重复订阅；
 *  重复调用安全（幂等），HMR 时自动卸载旧实例监听。
 */
export function installTasks() {
  if (installed)
    return
  installed = true
  // subscribe 返回卸载函数，供 HMR dispose / 测试重置统一卸载
  unsubscribe = [
    subscribe('download-task', payload => handleTask(payload, 'download')),
    subscribe('record-task', payload => handleTask(payload, 'record')),
  ]
  // 订阅须早于任何组件 setup：发起方可能在 Downloads 未挂载的页面上，
  // 若等到页面 mount 再订阅，事件可能在订阅前发出而静默丢失。
  // 应用启动即恢复一次：播放器可能在下载页从未挂载过的情况下进入，
  // 此时也要能正确显示「录制中」并能停止
  void ensureRestored().catch((error: any) => {
    console.error('[use-tasks] 恢复任务列表失败:', error)
  })
}

// HMR：卸载旧实例的监听，避免热更新后残留过期订阅
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe.forEach(off => off())
    unsubscribe = []
  })
}

export function useTasks() {
  return {
    downloadTasks,
    recordTasks,
    handleTask,
    removeTask,
    restoreTasks,
    isTaskRunning,
    stopTask,
  }
}

export default useTasks
