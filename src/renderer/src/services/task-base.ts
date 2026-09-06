import type { TaskSnapshot } from './task-payload'
import Constants from '../utils/constants'
import { debugLog } from '../utils/debug'

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
 * 直播任务基类：封装下载/录制任务的公共状态与生命周期（实际工作均由主进程 ffmpeg 完成）
 */
export default class TaskBase {
  private _url: string
  private _saveDirectory: string = ''
  private _filename: string
  private _filePath: string = ''
  private _status: number = Constants.TaskStatus.Prepared
  private _liveId: string

  // 保存已注册的 IPC 监听器取消函数，任务结束时统一移除，避免监听器泄漏
  private _unsubscribers: Array<() => void> = []

  private readonly channels: TaskChannelAdapter
  private readonly _logTag: string

  constructor(
    channels: TaskChannelAdapter,
    url: string,
    filename: string,
    liveId: string,
    logTag: string,
  ) {
    this.channels = channels
    this._url = url
    this._filename = filename
    this._liveId = liveId
    this._logTag = logTag
  }

  /** 异步初始化：从主进程配置读取保存目录（构造函数不能 await，故单独一步） */
  public async init() {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts 的 'getConfig'
    this._saveDirectory = await window.mainAPI.getConfig('downloadDirectory', '')
  }

  public getUrl(): string {
    return this._url
  }

  public setUrl(value: string) {
    this._url = value
  }

  public getFilename(): string {
    return this._filename
  }

  public setFilename(value: string) {
    this._filename = value
  }

  public getLiveId(): string {
    return this._liveId
  }

  public getFilePath(): string {
    return this._filePath
  }

  /**
   * 移除所有已注册的 IPC 监听器
   */
  private cleanupListeners() {
    for (const unsubscribe of this._unsubscribers)
      unsubscribe()
    this._unsubscribers = []
  }

  public async start(startListener: () => void): Promise<void> {
    await this.init()
    if (!this._saveDirectory)
      throw new Error('保存目录为空')

    // ★ 跨进程：路径拼接交给主进程，避免渲染层猜测平台分隔符（对端 main/ipc/register-system-ipc.ts）
    this._filePath = await window.mainAPI.pathJoin(this._saveDirectory, this._filename)

    // 先注册监听器，避免 ffmpeg 启动后立即发送的事件丢失。
    this._unsubscribers.push(this.channels.progress((liveId: string, time: string) => {
      if (liveId === this._liveId) {
        // progress 每个 ffmpeg 心跳都触发，用 debug 门控避免生产环境控制台被刷屏
        debugLog('tasks', `[${this._logTag}] task progress:`, liveId, time)
      }
    }))
    this.subscribeEndEvents()

    try {
      console.info(`[${this._logTag}] task start:`, this._url, this._filename, this._liveId)
      await this.channels.start(this._url, this._filename, this._liveId)
      this._status = Constants.TaskStatus.Running
      startListener()
    }
    catch (error) {
      this.cleanupListeners()
      console.error(`[${this._logTag}] task start failed`, error)
      throw error
    }
  }

  public isRunning(): boolean {
    return this._status === Constants.TaskStatus.Running
  }

  public isFinish(): boolean {
    return this._status === Constants.TaskStatus.Finish
  }

  /**
   * 注册任务结束（end / error）监听器；start 与 restore 共用
   */
  private subscribeEndEvents() {
    // 监听任务完成
    this._unsubscribers.push(this.channels.end((liveId: string, filePath: string) => {
      if (liveId === this._liveId) {
        this._filePath = filePath
        this._status = Constants.TaskStatus.Finish
        this.cleanupListeners()
        console.info(`[${this._logTag}] task end:`, liveId)
      }
    }))
    // 监听任务错误
    this._unsubscribers.push(this.channels.error((liveId: string, error: any) => {
      if (liveId === this._liveId) {
        console.error(`[${this._logTag}] task error`, error)
        this._status = Constants.TaskStatus.Finish
        this.cleanupListeners()
      }
    }))
  }

  /**
   * 从主进程快照恢复任务状态。
   * 渲染端刷新（F5）后原页面与监听器已销毁，主进程 ffmpeg 仍在运行；
   * 这里根据快照重建状态，若任务仍在运行则重新订阅结束事件以续接其生命周期。
   */
  public restore(snapshot: TaskSnapshot) {
    this._saveDirectory = snapshot.saveDirectory
    this._filePath = snapshot.filePath
    this._status = snapshot.status === 'running' ? Constants.TaskStatus.Running : Constants.TaskStatus.Finish
    if (this._status === Constants.TaskStatus.Running)
      this.subscribeEndEvents()
  }

  public stop() {
    if (this._status !== Constants.TaskStatus.Running) {
      return
    }
    this.channels.stop(this._liveId)
    this._status = Constants.TaskStatus.Finish
    this.cleanupListeners()
    console.info(`[${this._logTag}] task stop`)
  }

  public openSaveDirectory() {
    if (!this._saveDirectory) {
      console.error('saveDirectory is not initialized')
      return
    }
    // ★ 跨进程：preload/index.ts → main/ipc/register-system-ipc.ts 的 'openPath'（调用系统文件管理器）
    window.mainAPI.openPath(this._saveDirectory)
  }
}
