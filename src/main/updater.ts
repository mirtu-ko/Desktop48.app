/**
 * 应用自动更新封装。
 * 更新源由 electron-builder 打包写入；仅打包环境可用，macOS 走手动下载。
 */
import type { ProgressInfo, UpdateCheckResult, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { broadcastIpc } from './ipc/send'
import { log } from './logger'

/** electron-updater 为 CJS 包，autoUpdater 需延迟到运行时取用。 */
function getAutoUpdater() {
  return electronUpdater.autoUpdater
}

/**
 * 主进程持有的更新状态，经 updaterState 广播给窗口；phase 为判别键。
 * unsupported.url 非空时作为手动下载入口。
 */
export type UpdaterState
  = | { phase: 'idle' }
    | { phase: 'checking' }
    | { phase: 'available', version: string, releaseNotes: string }
    | { phase: 'downloading', version: string, percent: number, bytesPerSecond: number, transferred: number, total: number }
    | { phase: 'ready', version: string }
    | { phase: 'error', message: string }
    | { phase: 'unsupported', reason: string, url?: string }

/** GitHub Release 手动下载页；仓库地址变更时需同步 publish 配置。 */
const RELEASE_PAGE_URL = 'https://github.com/mirtu-ko/Desktop48.app/releases/latest'

/*
 * 不单独配置请求超时：electron-updater 的 timeout 配置在当前实现中未生效。
 * 失败后由下方重试兜底。
 */
/** 检查重试次数（含首次）；间歇性网络故障下递增退避仍在可等待范围。 */
const CHECK_MAX_ATTEMPTS = 3

/** 退避基数：第 n 次失败后等 BASE * 3^(n-1)。递增而非等间隔，给网络恢复留时间 */
const RETRY_BACKOFF_BASE_MS = 800

/** 只重试临时性故障；404、无效更新信息等确定性失败立即返回。 */
function isRetryableError(err: any): boolean {
  const code: string = err?.code ?? ''
  const message: string = err?.message ?? ''

  // 明确的「确定性」失败：直接放弃
  if (
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
    || code === 'ERR_UPDATER_INVALID_VERSION'
    || code.startsWith('ERR_UPDATER_INVALID_')
  ) {
    return false
  }

  // HTTP 状态码：5xx / 408 / 429 可重试，其余 4xx 是请求本身的问题
  const status = err?.statusCode
  if (typeof status === 'number') {
    return status >= 500 || status === 408 || status === 429
  }

  // 网络层临时故障（Node socket 错误码）
  const transientCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
  ]
  if (transientCodes.includes(code))
    return true

  // electron-updater 的超时是普通 Error("Request timed out")，没有 code，只能匹配文案
  if (/timed out|timeout|socket hang up|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message))
    return true

  return false
}

/** 将高频 electron-updater 错误转成用户可读文案；未知错误保留原文。 */
function humanizeError(err: any): string {
  const code: string = err?.code ?? ''
  const message: string = err?.message ?? ''

  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
    return '未找到可用的更新包，请稍后重试或前往 GitHub 下载'
  if (code === 'ERR_UPDATER_INVALID_VERSION' || code.startsWith('ERR_UPDATER_INVALID_'))
    return '更新信息格式异常，请稍后重试或前往 GitHub 下载'
  if (typeof err?.statusCode === 'number' && err.statusCode >= 500)
    return '更新服务器暂时不可用，请稍后重试'
  if (/timed out|timeout|ETIMEDOUT/i.test(code + message))
    return '网络连接超时，请检查网络后重试'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(code + message))
    return '无法连接到更新服务器，请检查网络后重试'

  return message || '检查更新失败'
}

/** 等待指定毫秒（重试退避用） */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let currentState: UpdaterState = { phase: 'idle' }

/** 标记检查循环进行中；重试期间的瞬时 error 事件不应推给 UI。 */
let checkingInProgress = false

/** 是否具备自动更新条件；不满足时给出原因，渲染端据此禁用按钮并说明 */
export function resolveUpdaterSupport(): { ok: true } | { ok: false, reason: string, url?: string } {
  if (!app.isPackaged)
    return { ok: false, reason: '开发模式下不检查更新' }
  if (process.platform === 'darwin')
    return { ok: false, reason: 'macOS 版本暂不支持自动更新，请前往 GitHub 下载新版本', url: RELEASE_PAGE_URL }

  // 免安装包缺少 app-update.yml，提前拦截并说明。
  if (!existsSync(path.join(process.resourcesPath, 'app-update.yml')))
    return { ok: false, reason: '当前为免安装版，不支持自动更新（请使用安装包版本）', url: RELEASE_PAGE_URL }

  return { ok: true }
}

function setState(next: UpdaterState): void {
  currentState = next
  // 状态全局唯一 -> 广播给全部窗口（主窗口与独立播放窗共用 mainAPI）
  broadcastIpc('updaterState', next)
}

export function getUpdaterState(): UpdaterState {
  return currentState
}

/** 当前版本号；开发模式下会显示 Electron 自身版本。 */
export function getAppVersion(): string {
  return app.getVersion()
}

/** 把 electron-updater 的 releaseNotes 归一化成纯文本（可能是 string 或 { version, note }[]） */
function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes)
    return ''
  if (typeof notes === 'string')
    return notes
  return notes
    .map(n => (n?.note ?? ''))
    .filter(Boolean)
    .join('\n')
}

let wired = false

/** 接线 electron-updater 事件，只在进程生命周期内执行一次。 */
function wireEvents(): void {
  if (wired)
    return
  wired = true

  const autoUpdater = getAutoUpdater()

  autoUpdater.on('checking-for-update', () => {
    log('[updater] 正在检查更新…')
    setState({ phase: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log('[updater] 发现新版本:', info.version)
    setState({ phase: 'available', version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) })
  })

  autoUpdater.on('update-not-available', () => {
    log('[updater] 当前已是最新版本')
    setState({ phase: 'idle' })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const version = currentState.phase === 'downloading' ? currentState.version : ''
    setState({
      phase: 'downloading',
      version,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    log('[updater] 更新已下载，等待重启安装:', event.version)
    setState({ phase: 'ready', version: event.version })
  })

  autoUpdater.on('error', (err: Error) => {
    // 检查循环内的失败由 checkForUpdates 汇总处理，避免重试期间闪错误状态。
    log('[updater] 更新出错:', err?.message || err)
    if (checkingInProgress)
      return
    setState({ phase: 'error', message: humanizeError(err) })
  })
}

/** 初始化事件并在启动后做一次静默检查；下载始终由用户确认。 */
export function initUpdater(): void {
  const support = resolveUpdaterSupport()
  if (!support.ok) {
    log('[updater] 未启用:', support.reason)
    currentState = { phase: 'unsupported', reason: support.reason, url: support.url }
    return
  }

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  // 仅在退出时安装，不主动重启应用。
  autoUpdater.autoInstallOnAppQuit = true

  wireEvents()

  // 延迟后台检查；启动检查失败保持中性状态。
  setTimeout(() => {
    void checkForUpdates({ silent: true })
  }, 5000)
}

/** 检查更新的可选项 */
interface CheckOptions {
  /** 静默失败；用于启动后的后台检查。 */
  silent?: boolean
}
/** 检查更新；临时性错误按策略重试，最终失败只更新状态不抛出。 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdaterState> {
  const support = resolveUpdaterSupport()
  if (!support.ok) {
    currentState = { phase: 'unsupported', reason: support.reason, url: support.url }
    return currentState
  }

  let lastError: any = null

  checkingInProgress = true
  try {
    for (let attempt = 1; attempt <= CHECK_MAX_ATTEMPTS; attempt++) {
      try {
        const result: UpdateCheckResult | null = await getAutoUpdater().checkForUpdates()
        // 未返回结果时（已在检查中）保留当前状态
        if (!result)
          return currentState
        return currentState
      }
      catch (err: any) {
        lastError = err
        const retryable = isRetryableError(err)
        const isLast = attempt === CHECK_MAX_ATTEMPTS

        if (!retryable || isLast) {
          log(`[updater] 检查更新失败（第 ${attempt}/${CHECK_MAX_ATTEMPTS} 次，${retryable ? '已达上限' : '不可重试'}）:`, err?.message || err)
          break
        }

        const wait = RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1)
        log(`[updater] 检查更新失败（第 ${attempt}/${CHECK_MAX_ATTEMPTS} 次），${wait}ms 后重试:`, err?.message || err)
        await delay(wait)
      }
    }
  }
  finally {
    checkingInProgress = false
  }

  // 静默模式不推送错误状态。
  if (options.silent) {
    log('[updater] 静默检查失败，保持当前状态不提示')
    return currentState
  }

  currentState = { phase: 'error', message: humanizeError(lastError) }
  return currentState
}

/** 用户确认后开始下载；状态由 download-progress 事件推送。 */
export async function downloadUpdate(): Promise<void> {
  if (currentState.phase !== 'available')
    return
  try {
    // 先切到 downloading 占位。
    setState({ phase: 'downloading', version: currentState.version, percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 })
    await getAutoUpdater().downloadUpdate()
  }
  catch (err: any) {
    log('[updater] 下载更新失败:', err?.message || err)
    setState({ phase: 'error', message: err?.message || '下载更新失败' })
  }
}

/** 退出并安装已下载的更新。 */
export function installUpdate(): void {
  if (currentState.phase !== 'ready')
    return
  // 走安装向导并在完成后拉起应用。
  getAutoUpdater().quitAndInstall(false, true)
}
