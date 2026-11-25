/**
 * 两套更新后端：in-app（包装 electron-updater）与 manual（只查版本号）。
 * 这层只把事件式 API 压成 check/download/install 三个方法，状态机在 engine.ts。
 */
import type { ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import type { DownloadProgress, UpdateCandidate, UpdaterBackend } from './types'
import { app } from 'electron'
import electronUpdater, { CancellationToken } from 'electron-updater'
import { log } from '../logger'
import { isNewerVersion } from '../updater-version'
import { withRetry, withTimeout } from './errors'
import { fetchLatestManualRelease, fetchMirrorReleaseNotes, GITHUB_OWNER, GITHUB_REPO, MIRROR_BASE } from './sources'

/** 镜像单次检查超时：避免镜像挂起耗尽整体 20s 预算，留足时间给 GitHub 兜底。 */
export const MIRROR_CHECK_TIMEOUT_MS = 5_000

/** electron-updater 是 CJS 包，autoUpdater 延迟到运行时取。 */
function getAutoUpdater() {
  return electronUpdater.autoUpdater
}

type Feed = Parameters<ReturnType<typeof getAutoUpdater>['setFeedURL']>[0]

/** 镜像源：安装包与 latest*.yml 同源。 */
const FEED_MIRROR: Feed = { provider: 'generic', url: MIRROR_BASE } as Feed

/** GitHub 兜底：只在镜像整体不可用时用。 */
const FEED_GITHUB: Feed = { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO } as Feed

/** electron-updater 的 releaseNotes 可能是字符串，也可能是按版本分段的数组。 */
function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes)
    return ''
  if (typeof notes === 'string')
    return notes
  return notes
    .map(note => (note.version ? `${note.version}\n${note.note ?? ''}` : note.note ?? ''))
    .join('\n')
    .trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 检查：镜像一次（独立超时）→ 失败整体切 GitHub 并退避重试。
 * 镜像挂了基本是持续性的，原地重试只是白等，重试预算全留给 GitHub。
 */
async function checkInApp(signal?: AbortSignal): Promise<UpdateCandidate | null> {
  if (signal?.aborted)
    throw new Error('更新检查已取消')

  const updater = getAutoUpdater()
  let source: UpdateCandidate['source'] = 'mirror'
  let result: UpdateCheckResult | null

  updater.setFeedURL(FEED_MIRROR)
  try {
    result = await withTimeout(updater.checkForUpdates(), MIRROR_CHECK_TIMEOUT_MS, '镜像更新检查超时')
  }
  catch (error) {
    if (signal?.aborted)
      throw error
    log('[updater] 镜像检查失败，改用 GitHub：', errorText(error))
    source = 'github'
    updater.setFeedURL(FEED_GITHUB)
    result = await withRetry(() => updater.checkForUpdates(), { label: 'GitHub 更新检查', signal })
  }

  const version = result?.updateInfo?.version
  // 拿不到结果或版本不比当前新，都按「已是最新」处理
  if (!version || !isNewerVersion(version, app.getVersion()))
    return null

  // latest.yml 通常没有更新说明，用镜像清单补齐，与 mac 一致
  const releaseNotes = normalizeReleaseNotes(result?.updateInfo?.releaseNotes)
    || (signal?.aborted ? '' : await fetchMirrorReleaseNotes(version, signal))

  return {
    version,
    releaseNotes,
    delivery: 'in-app',
    source,
  }
}

/** 进度事件转成 onProgress，取消靠 AbortSignal 驱动 CancellationToken。 */
async function downloadInApp(
  candidate: UpdateCandidate,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const updater = getAutoUpdater()
  const cancellationToken = new CancellationToken()

  if (signal.aborted)
    throw new Error('下载已取消')

  const cancel = () => cancellationToken.cancel()
  signal.addEventListener('abort', cancel, { once: true })

  const listener = (info: ProgressInfo) => {
    onProgress({
      percent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
      transferred: info.transferred,
      total: info.total,
    })
  }
  updater.on('download-progress', listener)

  try {
    log(`[updater] 开始下载 v${candidate.version}（来源 ${candidate.source}）`)
    await updater.downloadUpdate(cancellationToken)
  }
  finally {
    updater.off('download-progress', listener)
    signal.removeEventListener('abort', cancel)
  }
}

/** 应用内更新后端（Windows 安装包版）。 */
export function createInAppBackend(): UpdaterBackend {
  const updater = getAutoUpdater()
  // 下载与退出时安装都交给 engine，避免出现两条安装路径
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  return {
    mode: 'in-app',
    check: checkInApp,
    download: downloadInApp,
    install: () => {
      // isSilent：Windows 静默安装；isForceRunAfter：装完自动拉起新版
      updater.quitAndInstall(true, true)
    },
  }
}

/** 只判断版本号，下载与安装交给用户。 */
export function createManualBackend(): UpdaterBackend {
  return {
    mode: 'manual',
    async check(signal?: AbortSignal) {
      const release = await fetchLatestManualRelease(signal)
      if (!isNewerVersion(release.version, app.getVersion()))
        return null
      return { ...release, delivery: 'manual' }
    },
  }
}
