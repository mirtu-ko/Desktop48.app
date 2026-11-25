/**
 * 更新状态机：一次会话只有一条流程——静默检查 → 有新版自动下载 → 提示 / 下次启动安装。
 * 所有对外的可见变化都过 `publish()`：合并补丁、重算 notice、广播给所有窗口。
 */
import type { MemoryStore } from './memory'
import type { DownloadProgress, UpdateCandidate, UpdaterBackend, UpdaterState } from './types'
import { app } from 'electron'
import { broadcastIpc } from '../ipc/send'
import { log } from '../logger'
import { humanizeError, withTimeout } from './errors'
import { updaterMemoryStore } from './memory'
import { reconcileMemory, resolveNotice, shouldInstallOnLaunch } from './policy'

/** 检查整体超时：electron-updater 自己的 timeout 不生效，只能外层兜。 */
export const CHECK_TIMEOUT_MS = 20_000

/** 启动安装的时间预算：本地已有包，正常只有一次清单请求 + 一次校验。 */
export const STARTUP_INSTALL_TIMEOUT_MS = 8_000

/** 这么久没有新进度就认为连接死了，取消让用户重试。 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000

/** 进度广播间隔：200ms 已经够顺滑。 */
const PROGRESS_THROTTLE_MS = 200

const ZERO_PROGRESS: DownloadProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 }

export interface UpdaterEngineOptions {
  /** null 表示当前环境不支持更新（dev / 免安装版），此时所有动作都是空转 */
  backend: UpdaterBackend | null
  unsupported?: { reason: string, url?: string } | null
  /** 测试注入用，默认落盘到 userData/updater-memory.json */
  memory?: MemoryStore
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdaterEngine {
  private readonly backend: UpdaterBackend | null
  private readonly memory: MemoryStore
  private state: UpdaterState
  private pendingCheck: Promise<UpdaterState> | null = null
  private pendingDownload: Promise<UpdaterState> | null = null

  constructor(options: UpdaterEngineOptions) {
    this.backend = options.backend
    this.memory = options.memory ?? updaterMemoryStore()
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      checkedAt: null,
      candidate: null,
      download: null,
      error: null,
      unsupported: null,
      notice: null,
    }

    if (options.unsupported) {
      this.state.phase = 'unsupported'
      this.state.unsupported = options.unsupported
      return
    }

    this.reconcile()
  }

  getState(): UpdaterState {
    return this.state
  }

  /** 检查更新。`silent` 只影响失败时是否把错误摆到界面上（启动检查用）。 */
  check(options: { silent?: boolean } = {}): Promise<UpdaterState> {
    if (this.pendingCheck)
      return this.pendingCheck
    if (this.pendingDownload)
      return this.pendingDownload
    if (!this.backend)
      return Promise.resolve(this.state)

    this.pendingCheck = this.runCheck(options.silent ?? false, this.state)
      .finally(() => {
        this.pendingCheck = null
      })
    return this.pendingCheck
  }

  private async runCheck(silent: boolean, baseline: UpdaterState): Promise<UpdaterState> {
    const backend = this.backend
    if (!backend)
      return this.state

    this.publish({ phase: 'checking', error: null })
    const controller = new AbortController()

    try {
      const candidate = await withTimeout(backend.check(controller.signal), CHECK_TIMEOUT_MS)
      this.memory.write({ lastCheckAt: Date.now(), lastResult: 'ok' })
      const checkedAt = Date.now()

      if (!candidate)
        return this.publish({ phase: 'up-to-date', checkedAt, candidate: null, download: null })

      // 已经下好同一版本就保持 ready，避免重新走一遍下载并闪烁进度条
      if (baseline.phase === 'ready' && candidate.version === baseline.candidate?.version)
        return this.publish({ ...baseline, checkedAt })

      const canDownload = candidate.delivery === 'in-app' && Boolean(backend.download)
      this.publish({
        phase: canDownload ? 'downloading' : 'available',
        candidate,
        checkedAt,
        download: canDownload ? { ...ZERO_PROGRESS } : null,
        error: null,
      })

      // in-app 有新版直接开始下，不让用户先做决定
      if (canDownload)
        void this.download()

      return this.state
    }
    catch (error) {
      controller.abort()
      this.memory.write({ lastCheckAt: Date.now(), lastResult: 'error' })
      log('[updater] 检查更新失败：', errorText(error))
      // 静默检查或已就绪时失败保留原状态，别把可安装的「立即重启」入口冲掉
      if (silent || baseline.phase === 'ready')
        return this.publish(baseline)
      return this.publish({ phase: 'error', error: humanizeError(error), download: null })
    }
  }

  /** 下载（也用于失败后重试）。同一时刻只允许一个下载任务。 */
  download(): Promise<UpdaterState> {
    if (this.pendingDownload)
      return this.pendingDownload

    const backend = this.backend
    const candidate = this.state.candidate
    if (!backend?.download || !candidate || candidate.delivery !== 'in-app')
      return Promise.resolve(this.state)

    this.pendingDownload = this.runDownload(backend, candidate)
      .finally(() => {
        this.pendingDownload = null
      })
    return this.pendingDownload
  }

  private async runDownload(backend: UpdaterBackend, candidate: UpdateCandidate): Promise<UpdaterState> {
    const download = backend.download
    if (!download)
      return this.state

    const controller = new AbortController()
    let latest = ZERO_PROGRESS
    let lastEmit = 0
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    const armWatchdog = (): void => {
      if (stallTimer)
        clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        log(`[updater] 下载 ${candidate.version} 停滞超过 ${DOWNLOAD_STALL_TIMEOUT_MS}ms，中止`)
        controller.abort()
      }, DOWNLOAD_STALL_TIMEOUT_MS)
      stallTimer.unref?.()
    }

    this.publish({ phase: 'downloading', download: latest, error: null })
    armWatchdog()

    try {
      await download(candidate, (progress) => {
        latest = progress
        armWatchdog()
        const now = Date.now()
        // 100% 必须广播，其余按间隔节流
        if (progress.percent < 100 && now - lastEmit < PROGRESS_THROTTLE_MS)
          return
        lastEmit = now
        this.publish({ download: progress })
      }, controller.signal)

      this.memory.write({ downloadedVersion: candidate.version })
      return this.publish({ phase: 'ready', download: { ...latest, percent: 100 } })
    }
    catch (error) {
      const aborted = controller.signal.aborted
      log('[updater] 下载更新失败：', errorText(error))
      return this.publish({
        phase: 'error',
        download: null,
        error: aborted ? '下载超时或已中断，请稍后重试或前往官网下载' : `下载失败：${humanizeError(error, '未知错误')}`,
      })
    }
    finally {
      if (stallTimer)
        clearTimeout(stallTimer)
    }
  }

  /** 立即安装：只有包已下好（ready）时可用。 */
  install(): void {
    const install = this.backend?.install
    if (this.state.phase !== 'ready' || !install)
      return

    // 先落盘再退出：安装器接管后进程就没机会写文件了
    const version = this.state.candidate?.version ?? this.memory.read().downloadedVersion
    if (version)
      this.memory.write({ installAttempt: { version, at: Date.now() } })

    this.publish({ phase: 'installing' })
    install()
  }

  /** 「稍后」：同一版本不再提示。 */
  dismiss(): UpdaterState {
    const version = this.state.notice?.version ?? this.state.candidate?.version
    if (!version)
      return this.state
    this.memory.write({ dismissedVersion: version, dismissedAt: Date.now() })
    return this.publish()
  }

  /**
   * 启动时安装上次已下好的包；返回 true 表示已交给安装器（不要继续建窗口）。
   */
  async startPendingInstall(): Promise<boolean> {
    const backend = this.backend
    if (!backend?.download || !backend.install)
      return false
    if (!shouldInstallOnLaunch(this.memory.read(), this.state.currentVersion, Date.now()))
      return false

    // 磁盘上那个包的版本：本次启动只装它
    const pendingVersion = this.memory.read().downloadedVersion
    const controller = new AbortController()

    this.publish({ phase: 'installing', error: null })

    try {
      // 重走一次检查：确认版本还有效，也让 electron-updater 复用磁盘上的包
      const candidate = await withTimeout(backend.check(controller.signal), STARTUP_INSTALL_TIMEOUT_MS, '启动安装前检查超时')
      if (!candidate) {
        // 版本已撤回或已是最新：清掉记录，正常启动
        this.memory.write({ downloadedVersion: null, installAttempt: null })
        return this.abandonInstall()
      }

      // 线上出了更新的版本：磁盘包已被取代，新包该由启动后的后台流程去下
      if (candidate.version !== pendingVersion) {
        log(`[updater] 磁盘包 v${pendingVersion} 已被 v${candidate.version} 取代，跳过启动安装`)
        this.memory.write({ downloadedVersion: null, installAttempt: null })
        return this.abandonInstall()
      }

      await withTimeout(
        backend.download(candidate, () => {}, controller.signal),
        STARTUP_INSTALL_TIMEOUT_MS,
        '启动安装下载超时',
      )

      this.memory.write({
        downloadedVersion: candidate.version,
        installAttempt: { version: candidate.version, at: Date.now() },
      })
      this.publish({ phase: 'ready', candidate })
      backend.install()
      return true
    }
    catch (error) {
      // 超时只 reject 外层 Promise，底层下载不会自己停，必须显式取消
      controller.abort()
      log('[updater] 启动时安装已下载的更新失败，按普通启动继续：', errorText(error))
      // 记一次失败尝试，否则每次启动都要再等一轮超时
      if (pendingVersion)
        this.memory.write({ installAttempt: { version: pendingVersion, at: Date.now() } })
      return this.abandonInstall()
    }
  }

  /** 放弃本次启动安装：回到 idle，让正常启动流程继续。 */
  private abandonInstall(): false {
    this.publish({ phase: 'idle', download: null })
    return false
  }

  /** 版本对账：已经跑到记录里的版本就不再惦记它。 */
  private reconcile(): void {
    const memory = this.memory.read()
    const next = reconcileMemory(memory, this.state.currentVersion)
    if (next === memory)
      return
    this.memory.write({
      downloadedVersion: next.downloadedVersion,
      installAttempt: next.installAttempt,
      dismissedVersion: next.dismissedVersion,
      dismissedAt: next.dismissedAt,
    })
  }

  /** 合并状态补丁、按当前记忆重算提示、广播。 */
  private publish(patch: Partial<UpdaterState> = {}): UpdaterState {
    const next: UpdaterState = { ...this.state, ...patch }
    next.notice = resolveNotice(next, this.memory.read())
    this.state = next
    broadcastIpc('updaterState', next)
    return next
  }
}
