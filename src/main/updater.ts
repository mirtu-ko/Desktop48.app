/**
 * 应用自动更新（electron-updater 封装）。
 *
 * 更新源：构建时由 electron-builder 依 `electron-builder.yml` 的 publish 配置写入
 * `resources/app-update.yml`（provider: github / owner: mirtu-ko / repo: Desktop48.app），
 * electron-updater 启动时自行读取，这里不需要再手写仓库地址。
 *
 * ⚠️ macOS 不启用：Electron 官方明确「自动更新要求应用已签名」，这是 Squirrel.Mac 的硬性前提。
 * 本项目 mac 侧用 `identity: '-'`（ad-hoc，无 Team ID），ShipIt 校验签名标识必然失败；
 * 且 mac 更新必须提供 zip 产物（当下 target 只有 dmg）。等接入 Developer ID 证书后再放开。
 *
 * ⚠️ 当前只在打包环境启用：`app.isPackaged` 为 false 时（dev / preview）没有 app-update.yml，
 * 且 electron-vite 的 dev 环境跑的是 dev server，更新检查没有意义。
 */
import type { ProgressInfo, UpdateCheckResult, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { broadcastIpc } from './ipc/send'
import { log } from './logger'

/**
 * electron-updater 是 CJS 包：ESM 下**必须**经 default 取（具名导入会 SyntaxError）。
 *
 * ⚠️ 且 `autoUpdater` 在 CJS 侧是 getter —— 一访问就 new NsisUpdater()，
 * 期间会读 `app.getVersion()`。因此在模块顶层解构会在 Electron 尚未就绪时炸掉，
 * 必须延迟到函数内首次使用时再取。这里用惰性取值函数封住。
 */
function getAutoUpdater() {
  return electronUpdater.autoUpdater
}

/**
 * 更新状态：主进程持真相，各窗口经 updaterState 事件拿镜像。
 *
 * 用可辨识联合而非多个布尔字段：状态之间互斥（不可能同时「正在下载」和「已就绪」），
 * 多个布尔会产生 2^n 种非法组合，渲染端只能靠约定断言。`phase` 即判别键，可安全收窄。
 *
 * - `idle`        未检查 / 当前版本已是最新
 * - `checking`    正在检查（首次检查可能数秒，渲染端需要 loading 反馈）
 * - `available`   发现新版本，等待用户确认是否下载
 * - `downloading` 正在下载
 * - `ready`       已下载完成，等待重启安装
 * - `error`       检查 / 下载失败（国内访问 GitHub 不稳定属常态，非致命）
 * - `unsupported` 当前环境不支持自动更新；`url` 非空时渲染端给出「去下载」手工出路
 */
export type UpdaterState
  = | { phase: 'idle' }
    | { phase: 'checking' }
    | { phase: 'available', version: string, releaseNotes: string }
    | { phase: 'downloading', version: string, percent: number, bytesPerSecond: number, transferred: number, total: number }
    | { phase: 'ready', version: string }
    | { phase: 'error', message: string }
    | { phase: 'unsupported', reason: string, url?: string }

/**
 * 手工下载页（GitHub Release 列表）。
 *
 * 与 `electron-builder.yml` 的 publish 配置同源，但**必须写死**：
 * 那份配置只在打包时被 electron-builder 读取并写进 `resources/app-update.yml`，
 * 主进程运行时拿不到（且 mac 走 unsupported 分支时那个文件也不存在）。
 * 改仓库地址时这里要一起改。
 */
const RELEASE_PAGE_URL = 'https://github.com/mirtu-ko/Desktop48.app/releases/latest'

let currentState: UpdaterState = { phase: 'idle' }

/** 是否具备自动更新条件；不满足时给出原因，渲染端据此禁用按钮并说明 */
export function resolveUpdaterSupport(): { ok: true } | { ok: false, reason: string, url?: string } {
  if (!app.isPackaged)
    return { ok: false, reason: '开发模式下不检查更新' }
  if (process.platform === 'darwin')
    return { ok: false, reason: 'macOS 版本暂不支持自动更新，请前往 GitHub 下载新版本', url: RELEASE_PAGE_URL }

  // app-update.yml 由 electron-builder 在 **打包目标（NSIS/dmg 等）** 阶段写入 resources/。
  // `--dir`（build:unpack）产物不含它，把 win-unpacked 当绿色版分发也会缺。
  // 缺了它 electron-updater 会抛裸 ENOENT，对用户没有可读性 —— 这里提前拦下并说明。
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

/**
 * 当前应用版本号（设置页展示）。
 *
 * 取 `app.getVersion()`：打包环境读 `package.json` 的 version；
 * dev 环境读 Electron 自身的版本 —— dev 下展示本无意义，但设置页仍需有值可渲染，
 * 故不做特判（README 里也提示「开发模式下不检查更新」，两者语义一致）。
 */
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

/**
 * 接线 electron-updater 事件。
 * 与 `initUpdater()` 分开：事件只在进程生命周期内接一次（幂等由 wired 保证），
 * 避免重复初始化时同一事件被处理多次。
 */
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
    // 更新失败不该弹错误打断使用：国内访问 GitHub 不稳定是常态，静默记录即可
    log('[updater] 更新出错:', err?.message || err)
    setState({ phase: 'error', message: err?.message || '更新失败' })
  })
}

/**
 * 初始化：接线事件并在启动后做一次静默检查。
 * 自动下载关闭 —— 由用户在设置页确认后再下载（安装包约 100MB，国内下载成本高）。
 */
export function initUpdater(): void {
  const support = resolveUpdaterSupport()
  if (!support.ok) {
    log('[updater] 未启用:', support.reason)
    currentState = { phase: 'unsupported', reason: support.reason, url: support.url }
    return
  }

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  // 退出时不自动安装：由渲染端明确调用 installUpdate，避免「更新完就重启」打断用户操作
  autoUpdater.autoInstallOnAppQuit = true

  wireEvents()

  // 延迟检查：启动瞬间网络/主进程都在忙，立即请求既慢又容易失败
  setTimeout(() => {
    void checkForUpdates()
  }, 5000)
}

/** 手动触发检查（设置页按钮）；失败只改状态不抛出，调用方无需 try/catch */
export async function checkForUpdates(): Promise<UpdaterState> {
  const support = resolveUpdaterSupport()
  if (!support.ok) {
    currentState = { phase: 'unsupported', reason: support.reason, url: support.url }
    return currentState
  }
  try {
    const result: UpdateCheckResult | null = await getAutoUpdater().checkForUpdates()
    // 未返回结果时（已在检查中）保留当前状态
    if (!result)
      return currentState
  }
  catch (err: any) {
    log('[updater] 检查更新失败:', err?.message || err)
    currentState = { phase: 'error', message: err?.message || '检查更新失败' }
  }
  return currentState
}

/** 用户确认后开始下载；更新状态由 download-progress 事件推送 */
export async function downloadUpdate(): Promise<void> {
  if (currentState.phase !== 'available')
    return
  try {
    // 先切到 downloading 占位，下载全程由 download-progress 覆盖
    setState({ phase: 'downloading', version: currentState.version, percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 })
    await getAutoUpdater().downloadUpdate()
  }
  catch (err: any) {
    log('[updater] 下载更新失败:', err?.message || err)
    setState({ phase: 'error', message: err?.message || '下载更新失败' })
  }
}

/** 退出并安装已下载的更新（设置页「立即重启」按钮调用的对端） */
export function installUpdate(): void {
  if (currentState.phase !== 'ready')
    return
  // isSilent=false 走安装向导、forceRunAfter=true 安装完自动拉起应用
  getAutoUpdater().quitAndInstall(false, true)
}
