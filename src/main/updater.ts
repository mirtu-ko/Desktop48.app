/**
 * 应用自动更新封装。
 * 更新源优先走自建镜像（大陆可直连），失败再回落 GitHub；仅打包环境可用，macOS 走手动下载。
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
    | { phase: 'up-to-date' }
    | { phase: 'available', version: string, releaseNotes: string, manualUpdate?: boolean, url?: string }
    | { phase: 'downloading', version: string, percent: number, bytesPerSecond: number, transferred: number, total: number }
    | { phase: 'ready', version: string }
    | { phase: 'error', message: string }
    | { phase: 'unsupported', reason: string, url?: string }

/**
 * 镜像站：安装包与 electron-updater 的 latest*.yml 同源，由发布脚本一并上传。
 * 换域名时这里和 electron-builder 的 artifact 命名都不用动，只改这两个常量。
 */
const MIRROR_BASE = 'https://dl.v2ing.com'

/** 发布脚本写的版本清单（含版本号、更新说明、各平台文件名），主页也在读它。 */
const MIRROR_MANIFEST_URL = `${MIRROR_BASE}/latest.json`

/** 镜像不可用时的手动下载出路：官网下载区，比 GitHub Release 页面更适合大陆用户。 */
const DOWNLOAD_PAGE_URL = 'https://48.v2ing.com/'

/** GitHub 兜底用的仓库地址；仓库变更时需同步 electron-builder 的 publish 配置。 */
const GITHUB_OWNER = 'mirtu-ko'
const GITHUB_REPO = 'Desktop48.app'
const GITHUB_RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** GitHub latest Release API；镜像不可用时才用，可带上更新说明原文。 */
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const MANUAL_CHECK_TIMEOUT_MS = 10 * 1000

/**
 * electron-updater 的更新源。generic 直接按 `${url}/latest*.yml` 取清单，
 * 清单里是相对文件名，下载地址会拼回镜像——不需要在镜像上再放一份 app-update.yml。
 */
const FEED_MIRROR = { provider: 'generic', url: MIRROR_BASE } as const
const FEED_GITHUB = { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO } as const

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
    return '未找到可用的更新包，请稍后重试或前往官网下载'
  if (code === 'ERR_UPDATER_INVALID_VERSION' || code.startsWith('ERR_UPDATER_INVALID_'))
    return '更新信息格式异常，请稍后重试或前往官网下载'
  if (err?.statusCode === 403)
    return 'GitHub 访问受限或请求过于频繁；如仍失败可前往官网手动下载'
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

/** 把 v1.2.3 / 1.2.3 归一成可比数字；非法段视为 0，避免比较时抛错。 */
function parseVersion(version: string): number[] {
  return version.trim().replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10))
}

/** 语义化版本比较（项目当前只用 x.y.z）：next 大于 current 时返回 true。 */
function isNewerVersion(next: string, current: string): boolean {
  const a = parseVersion(next)
  const b = parseVersion(current)
  const width = Math.max(a.length, b.length)
  for (let i = 0; i < width; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv)
      return av > bv
  }
  return false
}

/** 手动检查的归一结果：版本、说明、下载入口。镜像与 GitHub 两条来源都要交出这三件事。 */
interface ReleaseInfo {
  version: string
  releaseNotes: string
  url: string
}

/** GitHub latest Release 的响应字段（只取更新检查需要的内容）。 */
interface GithubLatestRelease {
  tag_name?: string
  body?: string | null
}

/** 发布脚本写入镜像的版本清单；这里只关心版本、说明与文件名。 */
interface MirrorManifest {
  version?: string
  notes?: string | null
  files?: { name?: string }[]
}

/** tag / version 统一成裸版本号；缺失时按 502 抛出，交给外层重试判定。 */
function readVersion(raw: string | null | undefined, source: string): string {
  const version = String(raw ?? '').trim().replace(/^v/i, '')
  if (!version) {
    const error = new Error(`${source} 缺少版本号`) as Error & { statusCode: number }
    error.statusCode = 502
    throw error
  }
  return version
}

/** 按当前架构挑安装包；清单里没有对应文件就退回官网下载区。 */
function pickMirrorDownloadUrl(files: MirrorManifest['files']): string {
  const suffix = process.arch === 'arm64' ? '-arm64.dmg' : '-x64.dmg'
  const hit = files?.find(file => typeof file?.name === 'string' && file.name.endsWith(suffix))
  return hit?.name ? `${MIRROR_BASE}/${encodeURIComponent(hit.name)}` : DOWNLOAD_PAGE_URL
}

/** 镜像最新版本：清单是 no-store 的，发布后立刻可见。 */
async function fetchReleaseFromMirror(): Promise<ReleaseInfo> {
  const response = await fetch(MIRROR_MANIFEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(MANUAL_CHECK_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`镜像版本清单请求失败: HTTP ${response.status}`) as Error & { statusCode: number }
    error.statusCode = response.status
    throw error
  }
  const manifest = await response.json() as MirrorManifest
  return {
    version: readVersion(manifest.version, '镜像版本清单'),
    releaseNotes: manifest.notes ?? '',
    url: pickMirrorDownloadUrl(manifest.files),
  }
}

/** 从 GitHub Release 页面重定向后的最终地址解析 tag；API 限流时的降级来源。 */
async function fetchLatestReleaseFromPage(): Promise<GithubLatestRelease> {
  const response = await fetch(GITHUB_RELEASE_PAGE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(MANUAL_CHECK_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`GitHub Release 页面请求失败: HTTP ${response.status}`) as Error & { statusCode: number }
    error.statusCode = response.status
    throw error
  }
  const segments = new URL(response.url).pathname.split('/').filter(Boolean)
  const tag = segments[segments.length - 1] ?? ''
  if (!/^v?\d/.test(tag)) {
    throw new Error(`无法从 GitHub Release 页面解析版本号: ${response.url}`)
  }
  return { tag_name: decodeURIComponent(tag) }
}

/** GitHub 兜底：优先 API（带更新说明），遇 403/429 限流时用 Release 页面取版本号。 */
async function fetchReleaseFromGithub(): Promise<ReleaseInfo> {
  let release: GithubLatestRelease
  try {
    release = await fetchLatestReleaseFromApi()
  }
  catch (err: any) {
    if (err?.statusCode === 403 || err?.statusCode === 429) {
      log('[updater] GitHub API 限流，改用 Release 页面检查版本号')
      release = await fetchLatestReleaseFromPage()
    }
    else {
      throw err
    }
  }
  return {
    version: readVersion(release.tag_name, 'GitHub Release'),
    releaseNotes: release.body ?? '',
    url: GITHUB_RELEASE_PAGE_URL,
  }
}

/**
 * 手动检查入口：镜像优先，失败一律回落 GitHub。
 * 镜像失败不区分是否可重试——404 这类配置错误同样该让 GitHub 顶一次，再由 GitHub 的错误决定重试语义。
 */
async function fetchReleaseInfo(): Promise<ReleaseInfo> {
  try {
    return await fetchReleaseFromMirror()
  }
  catch (err: any) {
    log('[updater] 镜像版本清单不可用，改用 GitHub 检查：', err?.message || err)
    return fetchReleaseFromGithub()
  }
}

async function fetchLatestReleaseFromApi(): Promise<GithubLatestRelease> {
  const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      'accept': 'application/vnd.github+json',
      'user-agent': `Desktop48/${app.getVersion()}`,
    },
    signal: AbortSignal.timeout(MANUAL_CHECK_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`GitHub Release 请求失败: HTTP ${response.status}`) as Error & { statusCode: number }
    error.statusCode = response.status
    throw error
  }
  return await response.json() as GithubLatestRelease
}

let currentState: UpdaterState = { phase: 'idle' }

/** 标记检查循环进行中；重试期间的瞬时 error 事件不应推给 UI。 */
let checkingInProgress = false

/**
 * electron-updater 当前生效的更新源。
 * 下载/安装沿用最后一次检查时的源，所以只在检查开始时重置回镜像，不能在 downloadUpdate 里重置。
 */
let activeFeed: 'mirror' | 'github' | null = null

/** 切换更新源；electron-updater 的 setFeedURL 幂等，重复调用无害，但日志会啰嗦，故先判同。 */
function applyFeed(feed: 'mirror' | 'github'): void {
  if (activeFeed === feed)
    return
  activeFeed = feed
  getAutoUpdater().setFeedURL(feed === 'mirror' ? FEED_MIRROR : FEED_GITHUB)
  log(`[updater] 更新源切换为 ${feed === 'mirror' ? `镜像 ${MIRROR_BASE}` : 'GitHub Releases'}`)
}

/** 是否具备自动更新条件；不满足时给出原因，渲染端据此禁用按钮并说明 */
export type UpdaterSupport
  = | { ok: true, mode: 'auto' | 'manual' }
    | { ok: false, reason: string, url?: string }

/** 是否具备更新检查条件；不满足时给出原因，渲染端据此说明 */
const DEV_UPDATE_CHECK_ENV = 'DESKTOP48_DEV_UPDATE_CHECK'

/** 是否具备更新检查条件；不满足时给出原因，渲染端据此说明 */
export function resolveUpdaterSupport(): UpdaterSupport {
  const devUpdateCheckEnabled = process.env[DEV_UPDATE_CHECK_ENV] === '1'
  if (!app.isPackaged && !devUpdateCheckEnabled)
    return { ok: false, reason: '开发模式下不检查更新' }
  // macOS 只能手动下载；dev 模式显式开启后同样走手动检查，便于本地验证 UI。
  if (process.platform === 'darwin' || devUpdateCheckEnabled)
    return { ok: true, mode: 'manual' }

  // 免安装包缺少 app-update.yml，提前拦截并说明。
  if (!existsSync(path.join(process.resourcesPath, 'app-update.yml')))
    return { ok: false, reason: '当前为免安装版，不支持自动更新（请使用安装包版本）', url: DOWNLOAD_PAGE_URL }

  return { ok: true, mode: 'auto' }
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
    setState({ phase: 'up-to-date' })
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

  // macOS 只能检查版本并引导手动下载，不能初始化 electron-updater 的下载/安装链路。
  if (support.mode === 'manual') {
    setTimeout(() => {
      void checkForUpdates({ silent: true })
    }, 5000)
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

  if (support.mode === 'manual')
    return checkManualRelease({ silent: Boolean(options.silent) })

  // 每次检查都从镜像开始：源在上一轮可能已经被切到 GitHub，不重置就再也回不到镜像。
  applyFeed('mirror')

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

        // 镜像上的清单缺失/损坏会被判成"确定性失败"，但那恰恰是最该换 GitHub 的情况，
        // 所以先无条件换源重试一次，再谈可重试与否。
        // 这一跳不占用重试次数：重试预算留给真正兜底的 GitHub，否则第一次退避会直接跳到 2400ms。
        if (activeFeed === 'mirror') {
          log('[updater] 镜像更新源不可用，改用 GitHub 重试:', err?.message || err)
          applyFeed('github')
          attempt -= 1
          continue
        }

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

/** macOS 的手动检查；只查询版本清单，不调用 electron-updater。 */
async function checkManualRelease(options: CheckOptions): Promise<UpdaterState> {
  // 失败时按静默语义还原；否则启动检查一失败，UI 会永久停在 checking。
  const baseline = currentState
  let lastError: any = null
  checkingInProgress = true
  setState({ phase: 'checking' })
  try {
    for (let attempt = 1; attempt <= CHECK_MAX_ATTEMPTS; attempt++) {
      try {
        const release = await fetchReleaseInfo()

        if (!isNewerVersion(release.version, app.getVersion())) {
          setState({ phase: 'up-to-date' })
          return currentState
        }

        const next: UpdaterState = {
          phase: 'available',
          version: release.version,
          releaseNotes: release.releaseNotes,
          manualUpdate: true,
          url: release.url,
        }
        setState(next)
        return next
      }
      catch (err: any) {
        lastError = err
        const retryable = isRetryableError(err)
        const isLast = attempt === CHECK_MAX_ATTEMPTS
        if (retryable && !isLast) {
          const wait = RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1)
          log(`[updater] macOS 手动检查失败（第 ${attempt}/${CHECK_MAX_ATTEMPTS} 次），${wait}ms 后重试:`, err?.message || err)
          await delay(wait)
          continue
        }

        log(`[updater] macOS 手动检查失败（第 ${attempt}/${CHECK_MAX_ATTEMPTS} 次）:`, err?.message || err)
        break
      }
    }
  }
  finally {
    checkingInProgress = false
  }

  if (options.silent) {
    setState(baseline)
    return currentState
  }

  setState({ phase: 'error', message: humanizeError(lastError) })
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
