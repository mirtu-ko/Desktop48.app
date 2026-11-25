/**
 * 跨会话记忆：userData/updater-memory.json。
 * 几个字段、几 KB，读写都走同步 IO；失败一律吞掉给默认值——丢记忆最坏只是再查一次更新。
 */
import type { UpdaterMemory } from './types'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { log } from '../logger'

const MEMORY_FILE = 'updater-memory.json'

/** 防重启环：同一版本装失败一次后，24h 内不再自动尝试。 */
export const INSTALL_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function defaultMemory(): UpdaterMemory {
  return {
    lastCheckAt: null,
    lastResult: null,
    downloadedVersion: null,
    dismissedVersion: null,
    dismissedAt: null,
    installAttempt: null,
  }
}

export interface MemoryStore {
  read: () => UpdaterMemory
  /** 合并写入，返回写入后的完整记忆 */
  write: (patch: Partial<UpdaterMemory>) => UpdaterMemory
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 逐字段校验：文件可能是手改的、旧版本写的，或写到一半被杀掉的。 */
export function parseMemory(raw: unknown): UpdaterMemory {
  const source = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {}
  const attempt = (typeof source.installAttempt === 'object' && source.installAttempt !== null)
    ? source.installAttempt as Record<string, unknown>
    : null
  const attemptVersion = asString(attempt?.version)
  const attemptAt = asTimestamp(attempt?.at)
  const lastResult = source.lastResult

  return {
    lastCheckAt: asTimestamp(source.lastCheckAt),
    lastResult: lastResult === 'ok' || lastResult === 'error' || lastResult === 'skipped' ? lastResult : null,
    downloadedVersion: asString(source.downloadedVersion),
    dismissedVersion: asString(source.dismissedVersion),
    dismissedAt: asTimestamp(source.dismissedAt),
    installAttempt: attemptVersion && attemptAt ? { version: attemptVersion, at: attemptAt } : null,
  }
}

export function createMemoryStore(filePath: string): MemoryStore {
  let cached: UpdaterMemory | null = null

  function read(): UpdaterMemory {
    if (cached)
      return cached
    if (!existsSync(filePath)) {
      cached = defaultMemory()
      return cached
    }
    try {
      cached = parseMemory(JSON.parse(readFileSync(filePath, 'utf8')))
    }
    catch (error) {
      log('[updater] 更新记忆读取失败，按空记忆处理：', error instanceof Error ? error.message : error)
      cached = defaultMemory()
    }
    return cached
  }

  function write(patch: Partial<UpdaterMemory>): UpdaterMemory {
    cached = { ...read(), ...patch }
    try {
      writeFileSync(filePath, JSON.stringify(cached), 'utf8')
    }
    catch (error) {
      // 写失败只影响下次启动是否自动安装
      log('[updater] 更新记忆写入失败：', error instanceof Error ? error.message : error)
    }
    return cached
  }

  return { read, write }
}

let store: MemoryStore | null = null

/** 路径在首次调用时解析（app.getPath 在 ready 前不可用）。 */
export function updaterMemoryStore(): MemoryStore {
  if (!store)
    store = createMemoryStore(join(app.getPath('userData'), MEMORY_FILE))
  return store
}
