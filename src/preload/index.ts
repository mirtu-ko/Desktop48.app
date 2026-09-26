import type { AppConfig, ConfigKey } from '../common/app-config'
import type { electronAPI as ElectronAPI, FfmpegDownloadProgress, FloatPlayerKind, FloatPlayerPayload, IpcEventArgs, IpcEventChannel, IpcInvokeArgs, IpcInvokeChannel, IpcInvokeReturn, mainAPI, MemberDataContent, MemberFlagKind, NetRequestOptions, TaskSnapshot } from './ipc-contract'
import { contextBridge, ipcRenderer } from 'electron'

// 仅暴露渲染进程实际需要的最小 API
// sandbox 模式下 require 只能加载 electron 内置模块，无法 require 第三方包
const electronAPI = {
  process: {
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  },
} satisfies ElectronAPI

/**
 * 类型化 invoke：通道、参数与返回值全部由 ipc-contract 的 IpcInvokeMap 约束。
 * 通道名拼错、参数数量/类型不符或返回类型漂移都会在 typecheck 阶段失败。
 */
function invokeIpc<Channel extends IpcInvokeChannel>(
  channel: Channel,
  ...args: IpcInvokeArgs<Channel>
): Promise<IpcInvokeReturn<Channel>> {
  return ipcRenderer.invoke(channel, ...args)
}

/** 类型化事件订阅；返回取消订阅函数，通道与回调参数由 IpcEventMap 约束。 */
function onIpc<Channel extends IpcEventChannel>(
  channel: Channel,
  callback: (...args: IpcEventArgs<Channel>) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: IpcEventArgs<Channel>) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
/**
 * 渲染进程的自定义 API —— 这里是**进程边界**。
 *
 * 渲染层写 `window.mainAPI.foo(x)`，实际发生的是：
 *   参数结构化克隆 → IPC 通道 → 主进程 ipcMain.handle('foo') → 返回值克隆回来
 * 因此参数和返回值都必须可序列化（不能传函数、DOM 节点、类实例）。
 *
 * 分组顺序与 ipc-contract.d.ts 保持一致，便于按域对照阅读。
 * satisfies mainAPI：实现与契约在编译期强制一致，新增/改名通道漏改任何一侧都会 typecheck 报错。
 */
const api = {
  // ===== 运行环境 =====
  getPlatform: () => process.platform,

  // ===== 网络请求 =====
  // 对端：main/ipc/register-system-ipc.ts，走 Electron net 模块 + 域名白名单
  netRequest: (options: NetRequestOptions) => invokeIpc('netRequest', options),

  // ===== 成员与屏蔽名单 =====
  // 对端：main/ipc/register-database-ipc.ts
  saveMemberData: (data: Partial<MemberDataContent>) => invokeIpc('saveMemberData', data),
  getAllMembers: () => invokeIpc('getAllMembers'),
  hasMembers: () => invokeIpc('hasMembers'),
  getMemberInfo: (userId: number) => invokeIpc('getMemberInfo', userId),
  getMemberTree: () => invokeIpc('getMemberTree'),
  getMemberFlags: (kind: MemberFlagKind) => invokeIpc('getMemberFlags', kind),
  setMemberFlags: (kind: MemberFlagKind, ids: Array<number | string>) => invokeIpc('setMemberFlags', kind, ids),
  addMemberFlag: (kind: MemberFlagKind, userId: number) => invokeIpc('addMemberFlag', kind, userId),
  removeMemberFlag: (kind: MemberFlagKind, userId: number) => invokeIpc('removeMemberFlag', kind, userId),

  // ===== 应用配置 =====
  // 对端：main/ipc/register-database-ipc.ts
  getConfig: <K extends ConfigKey>(key: K) => invokeIpc('getConfig', key),
  setConfig: <K extends ConfigKey>(key: K, value: AppConfig[K]) => invokeIpc('setConfig', key, value),

  // ===== 文件系统与目录 =====
  // 对端：main/ipc/register-system-ipc.ts
  openPath: (filePath: string) => invokeIpc('openPath', filePath),
  getDesktopPath: () => invokeIpc('getDesktopPath'),
  selectDirectory: () => invokeIpc('selectDirectory'),
  pathJoin: (...paths: string[]) => invokeIpc('pathJoin', ...paths),

  // ===== FFmpeg 环境 =====
  checkFfmpegBinaries: (dir: string) => invokeIpc('checkFfmpegBinaries', dir),
  // 对端：main/ffmpeg/ffmpeg-download.ts，下载进度经 ffmpegDownloadProgress 回推
  downloadFfmpeg: () => invokeIpc('downloadFfmpeg'),
  onFfmpegDownloadProgress: (callback: (_progress: FfmpegDownloadProgress) => void) =>
    onIpc('ffmpegDownloadProgress', callback),

  // ===== 直播播放 =====
  // 对端：main/ipc/register-stream-ipc.ts；业务实现在 main/stream.ts
  createLiveStream: (rtmpUrl: string, liveId: string) => invokeIpc('createLiveStream', rtmpUrl, liveId),
  stopLiveStream: (liveId: string) => invokeIpc('stopLiveStream', liveId),

  // ===== 下载任务 =====
  // 对端：main/ipc/register-task-ipc.ts，通用任务机制在 main/ffmpeg/register-ffmpeg-task.ts
  downloadTaskStart: (url: string, filename: string, liveId: string) => invokeIpc('downloadTaskStart', url, filename, liveId),
  // 任务已在主进程登记（广播给全部窗口）：其它窗口据此把它补进自己的任务列表
  downloadTaskStarted: (callback: (_snapshot: TaskSnapshot) => void) =>
    onIpc('downloadTaskStarted', callback),
  downloadTaskProgress: (callback: (_liveId: string, _time: string) => void) =>
    onIpc('downloadTaskProgress', callback),
  downloadTaskEnd: (callback: (_liveId: string, _filePath: string) => void) =>
    onIpc('downloadTaskEnd', callback),
  downloadTaskError: (callback: (_liveId: string, _error: string) => void) =>
    onIpc('downloadTaskError', callback),
  downloadTaskStop: (liveId: string) => ipcRenderer.send(`downloadTaskStop:${liveId}`),
  downloadTaskList: () => invokeIpc('downloadTaskList'),
  downloadTaskRemove: (liveId: string) => invokeIpc('downloadTaskRemove', liveId),

  // ===== 录制任务 =====
  // 对端：main/ipc/register-task-ipc.ts，通用任务机制在 main/ffmpeg/register-ffmpeg-task.ts
  recordTaskStart: (url: string, filename: string, liveId: string) => invokeIpc('recordTaskStart', url, filename, liveId),
  // 任务已在主进程登记（广播给全部窗口）：其它窗口据此把它补进自己的任务列表
  recordTaskStarted: (callback: (_snapshot: TaskSnapshot) => void) =>
    onIpc('recordTaskStarted', callback),
  recordTaskProgress: (callback: (_liveId: string, _time: string) => void) =>
    onIpc('recordTaskProgress', callback),
  recordTaskEnd: (callback: (_liveId: string, _filePath: string) => void) =>
    onIpc('recordTaskEnd', callback),
  recordTaskError: (callback: (_liveId: string, _error: string) => void) =>
    onIpc('recordTaskError', callback),
  recordTaskStop: (liveId: string) => ipcRenderer.send(`recordTaskStop:${liveId}`),
  recordTaskList: () => invokeIpc('recordTaskList'),
  recordTaskRemove: (liveId: string) => invokeIpc('recordTaskRemove', liveId),

  // ===== 独立播放窗口 =====
  // 对端：main/ipc/register-float-window-ipc.ts，窗口生命周期在 main/float-window.ts
  openFloatWindow: (kind: FloatPlayerKind, payload: FloatPlayerPayload) => invokeIpc('openFloatWindow', kind, payload),
  floatPlayerGetPayload: (kind: FloatPlayerKind, liveId: string) => invokeIpc('floatPlayerGetPayload', kind, liveId),
  floatWindowFitAspect: (aspect: number) => invokeIpc('floatWindowFitAspect', aspect),
  floatWindowSetPlaying: (playing: boolean) => invokeIpc('floatWindowSetPlaying', playing),
  notifyLiveUnavailable: (liveId: string) => invokeIpc('notifyLiveUnavailable', liveId),
  // liveUnavailable 由 IpcEventMap 自动派生，此处必须实现以满足 satisfies mainAPI
  liveUnavailable: (callback: (_liveId: string) => void) =>
    onIpc('liveUnavailable', callback),

  // ===== 窗口与电源 =====
  // 对端：main/ipc/register-window-ipc.ts，窗口引用与休眠状态归 main/app.ts 管理
  windowMinimize: () => invokeIpc('windowMinimize'),
  windowToggleMaximize: () => invokeIpc('windowToggleMaximize'),
  windowClose: () => invokeIpc('windowClose'),
  windowIsMaximized: () => invokeIpc('windowIsMaximized'),
  windowOnMaximizeChange: (callback: (_isMaximized: boolean) => void) =>
    onIpc('windowOnMaximizeChange', callback),
  preventSleep: () => invokeIpc('preventSleep'),
  allowSleep: (id: number) => invokeIpc('allowSleep', id),
} satisfies mainAPI

// 经 contextBridge 暴露给渲染进程（上下文隔离已启用）
contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('mainAPI', api)
