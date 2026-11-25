/**
 * 更新策略的纯函数：何时静默装、何时提示、何时忘掉记录。
 *
 * 这些判断错了的代价是「用户装不上新版本」或「每次开机都重试安装」，
 * 所以每条规则单独钉住。
 */
import type { UpdaterMemory, UpdaterState } from '../src/main/updater/types'
import { describe, expect, it } from 'vitest'

const { INSTALL_RETRY_COOLDOWN_MS } = await import('../src/main/updater/memory')
const { reconcileMemory, resolveNotice, shouldInstallOnLaunch, startupCheckDelay, STARTUP_CHECK_DELAY_MS, STARTUP_CHECK_JITTER_MS, NOTICE_SNOOZE_MS } = await import('../src/main/updater/policy')

function memory(overrides: Partial<UpdaterMemory> = {}): UpdaterMemory {
  return {
    lastCheckAt: null,
    lastResult: null,
    downloadedVersion: null,
    dismissedVersion: null,
    dismissedAt: null,
    installAttempt: null,
    ...overrides,
  }
}

function state(overrides: Partial<UpdaterState> = {}): UpdaterState {
  return {
    phase: 'idle',
    currentVersion: '1.0.0',
    checkedAt: null,
    candidate: null,
    download: null,
    error: null,
    unsupported: null,
    notice: null,
    ...overrides,
  }
}

describe('shouldInstallOnLaunch', () => {
  it('没有已下好的包就不装', () => {
    expect(shouldInstallOnLaunch(memory(), '1.0.0', Date.now())).toBe(false)
  })

  it('已下好的版本比当前新就装', () => {
    expect(shouldInstallOnLaunch(memory({ downloadedVersion: '1.1.0' }), '1.0.0', Date.now())).toBe(true)
  })

  it('已下好的版本不再新于当前版本时不装（对账没清掉时的兜底）', () => {
    expect(shouldInstallOnLaunch(memory({ downloadedVersion: '1.0.0' }), '1.0.0', Date.now())).toBe(false)
  })

  it('24h 内为同一版本试过安装就不重试，防止重启环', () => {
    const now = Date.now()
    const recent = memory({
      downloadedVersion: '1.1.0',
      installAttempt: { version: '1.1.0', at: now - 60_000 },
    })
    expect(shouldInstallOnLaunch(recent, '1.0.0', now)).toBe(false)
  })

  it('过了冷却期可以再试一次', () => {
    const now = Date.now()
    const stale = memory({
      downloadedVersion: '1.1.0',
      installAttempt: { version: '1.1.0', at: now - INSTALL_RETRY_COOLDOWN_MS - 1 },
    })
    expect(shouldInstallOnLaunch(stale, '1.0.0', now)).toBe(true)
  })

  it('试装记录属于别的版本时不影响当前版本', () => {
    const now = Date.now()
    const other = memory({
      downloadedVersion: '1.1.0',
      installAttempt: { version: '1.0.9', at: now - 60_000 },
    })
    expect(shouldInstallOnLaunch(other, '1.0.0', now)).toBe(true)
  })
})

describe('resolveNotice', () => {
  it('只有 ready 与 available 值得提示', () => {
    expect(resolveNotice(state({ phase: 'checking' }), memory())).toBeNull()
    expect(resolveNotice(state({ phase: 'ready', candidate: { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' } }), memory()))
      .toEqual({ version: '1.1.0', kind: 'ready' })
    expect(resolveNotice(state({ phase: 'available', candidate: { version: '1.1.0', releaseNotes: '', delivery: 'manual', url: 'x', source: 'mirror' } }), memory()))
      .toEqual({ version: '1.1.0', kind: 'available' })
  })

  it('点过「稍后」的版本在冷却期内不提示', () => {
    const now = Date.now()
    const dismissed = memory({ dismissedVersion: '1.1.0', dismissedAt: now })
    const ready = state({ phase: 'ready', candidate: { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' } })
    expect(resolveNotice(ready, dismissed, now)).toBeNull()
  })

  it('冷却期一过就重新提示，不做永久忽略', () => {
    const now = Date.now()
    const dismissed = memory({ dismissedVersion: '1.1.0', dismissedAt: now - NOTICE_SNOOZE_MS - 1 })
    const ready = state({ phase: 'ready', candidate: { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' } })
    expect(resolveNotice(ready, dismissed, now)).toEqual({ version: '1.1.0', kind: 'ready' })
  })

  it('老文件只有 dismissedVersion 没有时间点时按已过期处理', () => {
    const dismissed = memory({ dismissedVersion: '1.1.0' })
    const ready = state({ phase: 'ready', candidate: { version: '1.1.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' } })
    expect(resolveNotice(ready, dismissed, Date.now())).toEqual({ version: '1.1.0', kind: 'ready' })
  })

  it('下一版本仍然提示', () => {
    const dismissed = memory({ dismissedVersion: '1.1.0', dismissedAt: Date.now() })
    const ready = state({ phase: 'ready', candidate: { version: '1.2.0', releaseNotes: '', delivery: 'in-app', source: 'mirror' } })
    expect(resolveNotice(ready, dismissed)).toEqual({ version: '1.2.0', kind: 'ready' })
  })
})

describe('reconcileMemory', () => {
  it('跑到了记录里的版本就清掉下载与试装记录', () => {
    const next = reconcileMemory(memory({
      downloadedVersion: '1.1.0',
      installAttempt: { version: '1.1.0', at: 1 },
    }), '1.1.0')

    expect(next.downloadedVersion).toBeNull()
    expect(next.installAttempt).toBeNull()
  })

  it('比当前版本新的记录保留', () => {
    const next = reconcileMemory(memory({ downloadedVersion: '1.2.0' }), '1.1.0')
    expect(next.downloadedVersion).toBe('1.2.0')
  })

  it('没有变化时返回同一个对象（避免无谓落盘）', () => {
    const original = memory()
    expect(reconcileMemory(original, '1.0.0')).toBe(original)
  })
})

describe('startupCheckDelay', () => {
  it('固定打底 3s，抖动不超过 7s', () => {
    expect(startupCheckDelay(() => 0)).toBe(STARTUP_CHECK_DELAY_MS)
    expect(startupCheckDelay(() => 0.999_999)).toBe(STARTUP_CHECK_DELAY_MS + STARTUP_CHECK_JITTER_MS - 1)
  })
})
