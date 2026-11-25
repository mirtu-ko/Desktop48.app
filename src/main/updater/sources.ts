import type { UpdateCandidate } from './types'
/**
 * 手动更新源：只查版本号，下载交给浏览器/系统（mac 未签名、免安装版无 app-update.yml）。
 * 镜像 latest.json 优先，失败回落 GitHub（API → Release 页面）；下载一律送官网。
 */
import { app } from 'electron'
import { log } from '../logger'
import { withRetry } from './errors'

/** 镜像站：安装包与 latest*.yml 同源，由发布脚本一并上传。 */
export const MIRROR_BASE = 'https://dl.v2ing.com'

/** 发布脚本写的版本清单（版本号、更新说明、各平台文件名），主页也在读它。 */
export const MIRROR_MANIFEST_URL = `${MIRROR_BASE}/latest.json`

/** 官网下载页：镜像缺当前架构包时的兜底，也是 GitHub 来源的唯一落地页。 */
export const DOWNLOAD_PAGE_URL = 'https://48.v2ing.com/'

/**
 * GitHub 仓库地址；只用于版本号探测，不产出下载地址。改仓库需同步 electron-builder 的 publish。
 */
export const GITHUB_OWNER = 'mirtu-ko'
export const GITHUB_REPO = 'Desktop48.app'
const GITHUB_RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** GitHub latest Release API；可带上更新说明原文。 */
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** 手动检查是用户点着按钮在等，不能久挂。 */
const MANUAL_CHECK_TIMEOUT_MS = 10 * 1000

/** 补取更新说明等不起：超时就当没有。 */
const RELEASE_NOTES_TIMEOUT_MS = 3 * 1000

interface MirrorManifest {
  version?: unknown
  notes?: unknown
  files?: Array<{ name?: unknown }>
}

interface GithubLatestRelease {
  tag_name?: unknown
  body?: unknown
}

/** 带 HTTP 状态码的错误，重试判断要看它。 */
function httpError(message: string, status: number): Error {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = status
  return error
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined
  const value = (error as { statusCode?: unknown }).statusCode
  return typeof value === 'number' ? value : undefined
}

/** 允许 `v0.2.5` 写法，空值视为清单损坏。 */
export function readVersion(raw: unknown, source: string): string {
  const version = typeof raw === 'string' ? raw.trim().replace(/^v/i, '') : ''
  if (!version)
    throw httpError(`${source} 缺少版本号`, 502)
  return version
}

/**
 * 挑当前架构的安装包直链，只处理 mac（Windows 走 electron-updater，免安装版给官网）。
 */
export function pickMirrorDownloadUrl(files: unknown): string {
  if (!Array.isArray(files))
    return DOWNLOAD_PAGE_URL
  const suffix = process.arch === 'arm64' ? '-arm64.dmg' : '-x64.dmg'
  const hit = files.find((file) => {
    const name = (file as { name?: unknown })?.name
    return typeof name === 'string' && name.endsWith(suffix)
  })
  const name = (hit as { name?: string } | undefined)?.name
  return name ? `${MIRROR_BASE}/${encodeURIComponent(name)}` : DOWNLOAD_PAGE_URL
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 一次请求拿到版本号、更新说明和当前架构的安装包地址。 */
async function fetchReleaseFromMirror(
  timeoutMs = MANUAL_CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Omit<UpdateCandidate, 'delivery'>> {
  const response = await fetch(MIRROR_MANIFEST_URL, {
    headers: { accept: 'application/json' },
    signal: requestSignal(timeoutMs, signal),
  })
  if (!response.ok)
    throw httpError(`镜像版本清单请求失败: HTTP ${response.status}`, response.status)

  const manifest = await response.json() as MirrorManifest
  return {
    version: readVersion(manifest.version, '镜像版本清单'),
    releaseNotes: typeof manifest.notes === 'string' ? manifest.notes : '',
    url: pickMirrorDownloadUrl(manifest.files),
    source: 'mirror',
  }
}

/** GitHub Release API：有限流，403/429 时上层会降级到页面解析。 */
async function fetchLatestReleaseFromApi(signal?: AbortSignal): Promise<GithubLatestRelease> {
  const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      'accept': 'application/vnd.github+json',
      'user-agent': `Desktop48/${app.getVersion()}`,
    },
    signal: requestSignal(MANUAL_CHECK_TIMEOUT_MS, signal),
  })
  if (!response.ok)
    throw httpError(`GitHub Release 请求失败: HTTP ${response.status}`, response.status)
  return await response.json() as GithubLatestRelease
}

/** Release 页面兜底：跟重定向走，从最终地址末段取 tag（不解析 HTML）。 */
async function fetchLatestReleaseFromPage(signal?: AbortSignal): Promise<GithubLatestRelease> {
  const response = await fetch(GITHUB_RELEASE_PAGE_URL, {
    redirect: 'follow',
    signal: requestSignal(MANUAL_CHECK_TIMEOUT_MS, signal),
  })
  if (!response.ok)
    throw httpError(`GitHub Release 页面请求失败: HTTP ${response.status}`, response.status)

  const segments = new URL(response.url).pathname.split('/').filter(Boolean)
  const tag = segments[segments.length - 1] ?? ''
  if (!/^v?\d/.test(tag))
    throw httpError(`无法从 GitHub Release 页面解析版本号: ${response.url}`, 502)
  return { tag_name: decodeURIComponent(tag) }
}

/** GitHub 来源：API 优先（有更新说明），限流时退到页面只拿版本号。 */
async function fetchReleaseFromGithub(signal?: AbortSignal): Promise<Omit<UpdateCandidate, 'delivery'>> {
  let release: GithubLatestRelease
  try {
    release = await fetchLatestReleaseFromApi(signal)
  }
  catch (error) {
    if (signal?.aborted)
      throw error
    const status = statusOf(error)
    if (status !== 403 && status !== 429)
      throw error
    log('[updater] GitHub API 限流，改用 Release 页面检查版本号')
    release = await fetchLatestReleaseFromPage(signal)
  }

  return {
    version: readVersion(release.tag_name, 'GitHub Release'),
    releaseNotes: typeof release.body === 'string' ? release.body : '',
    url: DOWNLOAD_PAGE_URL,
    source: 'github',
  }
}

/**
 * 补取更新说明：latest.yml 里没有 releaseNotes（打包未带 `release-notes.md`），
 * 借镜像 latest.json 把 Windows 的文案补齐，版本号必须一致，失败就当没有。
 */
export async function fetchMirrorReleaseNotes(version: string, signal?: AbortSignal): Promise<string> {
  try {
    const release = await fetchReleaseFromMirror(RELEASE_NOTES_TIMEOUT_MS, signal)
    const sameVersion = release.version.replace(/^v/i, '') === version.replace(/^v/i, '')
    return sameVersion ? release.releaseNotes.trim() : ''
  }
  catch (error) {
    log('[updater] 更新说明补取失败，忽略：', error instanceof Error ? error.message : error)
    return ''
  }
}

/** 查最新版本（镜像 → GitHub，带退避重试）；只负责拿版本号，新旧由 engine 判。 */
export async function fetchLatestManualRelease(signal?: AbortSignal): Promise<Omit<UpdateCandidate, 'delivery'>> {
  return withRetry(async () => {
    try {
      return await fetchReleaseFromMirror(MANUAL_CHECK_TIMEOUT_MS, signal)
    }
    catch (error) {
      if (signal?.aborted)
        throw error
      log('[updater] 镜像版本清单不可用，改用 GitHub 检查：', error instanceof Error ? error.message : error)
      return await fetchReleaseFromGithub(signal)
    }
  }, { label: '镜像/GitHub 版本检查', signal })
}
