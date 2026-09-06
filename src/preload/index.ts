import type { electronAPI as ElectronAPI, mainAPI, MemberDataContent, NetRequestOptions } from './api-types'
import { contextBridge, ipcRenderer } from 'electron'

// 替代 @electron-toolkit/preload，仅暴露渲染进程实际需要的最小 API
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
 * 渲染进程的自定义 API —— 这里是**进程边界**。
 *
 * 渲染层写 `window.mainAPI.foo(x)`，实际发生的是：
 *   参数结构化克隆 → IPC 通道 → 主进程 ipcMain.handle('foo') → 返回值克隆回来
 * 因此参数和返回值都必须可序列化（不能传函数、DOM 节点、类实例）。
 *
 * 渲染层每个调用点都标了 `★ 跨进程` 注释，注明对端 handler 在 src/main 的哪个文件。
 *
 * satisfies mainAPI：实现与契约在编译期强制一致，新增/改名通道漏改任何一侧都会 typecheck 报错。
 */
const api = {
  saveMemberData: (data: Partial<MemberDataContent>) => ipcRenderer.invoke('saveMemberData', data),
  // 成员（对端：main/ipc/register-database-ipc.ts）
  getMemberInfo: (userId: number) => ipcRenderer.invoke('getMemberInfo', userId),
  getMemberTree: () => ipcRenderer.invoke('getMemberTree'),
  getBlockedMembers: () => ipcRenderer.invoke('getBlockedMembers'),
  setBlockedMembers: (ids: number[]) => ipcRenderer.invoke('setBlockedMembers', ids),
  addBlockedMember: (userId: number) => ipcRenderer.invoke('addBlockedMember', userId),
  removeBlockedMember: (userId: number) => ipcRenderer.invoke('removeBlockedMember', userId),
  hasMembers: () => ipcRenderer.invoke('hasMembers'),
  // 配置相关（对端：main/ipc/register-database-ipc.ts）
  getConfig: <T>(key: string, defaultValue?: T) => ipcRenderer.invoke('getConfig', key, defaultValue),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke('setConfig', key, value),
  // 网络（对端：main/app.ts，走 Electron net 模块 + 域名白名单）
  netRequest: (options: NetRequestOptions) => ipcRenderer.invoke('netRequest', options),
  // 播放（对端：main/stream.ts。createLiveStream 只登记会话，
  // FFmpeg 由 main/http-server.ts 在播放器实际拉流时才 spawn）
  createLiveStream: (rtmpUrl: string, liveId: string) => ipcRenderer.invoke('createLiveStream', rtmpUrl, liveId),
  stopLiveStream: (liveId: string) => ipcRenderer.invoke('stopLiveStream', liveId),
  // 文件夹目录
  openPath: (filePath: string) => ipcRenderer.invoke('openPath', filePath),
  getDesktopPath: () => ipcRenderer.invoke('getDesktopPath'),
  selectDirectory: () => ipcRenderer.invoke('selectDirectory'),
  checkFfmpegBinaries: (dir: string) => ipcRenderer.invoke('checkFfmpegBinaries', dir),
  getPlatform: () => process.platform,
  pathJoin: (...paths: string[]) => ipcRenderer.invoke('pathJoin', ...paths),
  // 下载（对端：main/ffmpeg/register-ffmpeg-task.ts）
  downloadTaskStart: (url: string, filename: string, liveId: string) => ipcRenderer.invoke('downloadTaskStart', url, filename, liveId),
  downloadTaskProgress: (callback: (_liveId: string, _time: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, time: string) => callback(liveId, time)
    ipcRenderer.on('downloadTaskProgress', listener)
    return () => ipcRenderer.removeListener('downloadTaskProgress', listener)
  },
  downloadTaskEnd: (callback: (_liveId: string, _filePath: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, filePath: string) => callback(liveId, filePath)
    ipcRenderer.on('downloadTaskEnd', listener)
    return () => ipcRenderer.removeListener('downloadTaskEnd', listener)
  },
  downloadTaskError: (callback: (_liveId: string, _error: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, error: string) => callback(liveId, error)
    ipcRenderer.on('downloadTaskError', listener)
    return () => ipcRenderer.removeListener('downloadTaskError', listener)
  },
  downloadTaskStop: (liveId: string) => ipcRenderer.send(`downloadTaskStop:${liveId}`),
  downloadTaskList: () => ipcRenderer.invoke('downloadTaskList'),
  downloadTaskRemove: (liveId: string) => ipcRenderer.invoke('downloadTaskRemove', liveId),
  // 录制（对端：main/ffmpeg/register-ffmpeg-task.ts）
  recordTaskStart: (url: string, filename: string, liveId: string) => ipcRenderer.invoke('recordTaskStart', url, filename, liveId),
  recordTaskProgress: (callback: (_liveId: string, _time: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, time: string) => callback(liveId, time)
    ipcRenderer.on('recordTaskProgress', listener)
    return () => ipcRenderer.removeListener('recordTaskProgress', listener)
  },
  recordTaskEnd: (callback: (_liveId: string, _filePath: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, filePath: string) => callback(liveId, filePath)
    ipcRenderer.on('recordTaskEnd', listener)
    return () => ipcRenderer.removeListener('recordTaskEnd', listener)
  },
  recordTaskError: (callback: (_liveId: string, _error: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, liveId: string, error: string) => callback(liveId, error)
    ipcRenderer.on('recordTaskError', listener)
    return () => ipcRenderer.removeListener('recordTaskError', listener)
  },
  recordTaskStop: (liveId: string) => ipcRenderer.send(`recordTaskStop:${liveId}`),
  recordTaskList: () => ipcRenderer.invoke('recordTaskList'),
  recordTaskRemove: (liveId: string) => ipcRenderer.invoke('recordTaskRemove', liveId),
  // 窗口控制（对端：main/app.ts）
  windowMinimize: () => ipcRenderer.invoke('windowMinimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('windowToggleMaximize'),
  windowClose: () => ipcRenderer.invoke('windowClose'),
  windowIsMaximized: () => ipcRenderer.invoke('windowIsMaximized'),
  windowOnMaximizeChange: (callback: (_isMaximized: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on('windowOnMaximizeChange', listener)
    return () => ipcRenderer.removeListener('windowOnMaximizeChange', listener)
  },
  // 阻止系统休眠
  preventSleep: () => ipcRenderer.invoke('preventSleep'),
  // 允许系统休眠
  allowSleep: (id: number) => ipcRenderer.invoke('allowSleep', id),
} satisfies mainAPI

// 经 contextBridge 暴露给渲染进程（上下文隔离已启用）
contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('mainAPI', api)
