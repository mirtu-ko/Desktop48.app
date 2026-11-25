/**
 * 更新策略：何时静默装、何时提示、何时忘掉记录。
 * 全写成纯函数（状态 + 记忆 + 时间 → 结论），engine 只执行副作用。
 */
import type { UpdateNotice, UpdaterMemory, UpdaterState } from './types'
import { isNewerVersion } from '../updater-version'
import { INSTALL_RETRY_COOLDOWN_MS } from './memory'

/** 启动后多久做那次静默检查：先让窗口画出来再联网。 */
export const STARTUP_CHECK_DELAY_MS = 3000
/** 抖动区间：别让同时开机的一批用户一起打到镜像上。 */
export const STARTUP_CHECK_JITTER_MS = 7000

/** 「稍后」的冷却期：过了还没升级就再提示，不做永久忽略。 */
export const NOTICE_SNOOZE_MS = 24 * 60 * 60 * 1000

/**
 * 本次启动是否该先装掉上次已下好的包：有比当前版本新的包，且 24h 内没为它试过安装
 * （安装器失败时应用照常启动，不能每次开机都重试一遍）。
 */
export function shouldInstallOnLaunch(
  memory: UpdaterMemory,
  currentVersion: string,
  now: number,
): boolean {
  const downloaded = memory.downloadedVersion
  if (!downloaded || !isNewerVersion(downloaded, currentVersion))
    return false

  const attempt = memory.installAttempt
  if (attempt && attempt.version === downloaded && now - attempt.at < INSTALL_RETRY_COOLDOWN_MS)
    return false

  return true
}

/**
 * 只有「已下好待安装」和「只能手动下载」值得打扰。
 * 点过「稍后」的版本在 `NOTICE_SNOOZE_MS` 内不再提示，过期后会重新出现。
 */
export function resolveNotice(state: UpdaterState, memory: UpdaterMemory, now = Date.now()): UpdateNotice | null {
  const version = state.candidate?.version ?? memory.downloadedVersion
  if (!version)
    return null

  // 老文件里可能只有 dismissedVersion 没有时间点，按「已过期」处理
  if (memory.dismissedVersion === version && now - (memory.dismissedAt ?? 0) < NOTICE_SNOOZE_MS)
    return null

  if (state.phase === 'ready')
    return { version, kind: 'ready' }
  if (state.phase === 'available')
    return { version, kind: 'available' }
  return null
}

/** 版本对账：已跑到记录里那个版本（或更新）就清掉旧记录，否则下次启动会重装一遍。 */
export function reconcileMemory(memory: UpdaterMemory, currentVersion: string): UpdaterMemory {
  let next = memory

  if (next.downloadedVersion && !isNewerVersion(next.downloadedVersion, currentVersion))
    next = { ...next, downloadedVersion: null, installAttempt: null }

  if (next.installAttempt && !isNewerVersion(next.installAttempt.version, currentVersion))
    next = { ...next, installAttempt: null }

  if (next.dismissedVersion && !isNewerVersion(next.dismissedVersion, currentVersion))
    next = { ...next, dismissedVersion: null, dismissedAt: null }

  return next
}

/** 3s 打底 + 0~7s 抖动；抽成函数是为让测试能固定随机数。 */
export function startupCheckDelay(random: () => number = Math.random): number {
  return STARTUP_CHECK_DELAY_MS + Math.floor(random() * STARTUP_CHECK_JITTER_MS)
}
