import type { ConfigKey } from '../src/common/app-config'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS } from '../src/common/app-config'
import { Database } from '../src/main/database'

function tempDatabaseFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'desktop48-db-')), 'database.json')
}

/** 绕开编译期类型，模拟 IPC 传进来的裸字符串 */
function asRawIpc(instance: Database) {
  return instance as unknown as {
    getConfig: (key: string) => string
    setConfig: (key: string, value: string) => void
  }
}

function readConfigFile(dbPath: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(dbPath, 'utf-8')) as { config: Record<string, unknown> }
  return raw.config
}

/** 键校验 + 「未设置」（缺失 / 空串 / 非字符串）一律按默认值生效 */
describe('database 配置读写', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tempDatabaseFile()
  })

  it('init 后未设置的键全部补成默认值并落盘', () => {
    const instance = new Database(dbPath)
    instance.init()

    for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[])
      expect(instance.getConfig(key)).toBe(CONFIG_DEFAULTS[key])

    // 内存与落盘都要对
    expect(readConfigFile(dbPath)).toEqual(CONFIG_DEFAULTS)
  })

  it('init 保留用户设置的非空值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('downloadDirectory', '/tmp/downloads')
    instance.setConfig('userAgent', 'custom-ua')

    const reopened = new Database(dbPath) // 模拟重启
    reopened.init()

    expect(reopened.getConfig('downloadDirectory')).toBe('/tmp/downloads')
    expect(reopened.getConfig('userAgent')).toBe('custom-ua')
  })

  it('空串视为未设置：读时按默认值生效，重启后落盘成默认值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('userAgent', '')

    // 会话内即生效，不让空 UA 漏给 request.ts
    expect(instance.getConfig('userAgent')).toBe(CONFIG_DEFAULTS.userAgent)

    const reopened = new Database(dbPath)
    reopened.init()
    expect(reopened.getConfig('userAgent')).toBe(CONFIG_DEFAULTS.userAgent)
    expect(readConfigFile(dbPath).userAgent).toBe(CONFIG_DEFAULTS.userAgent)
  })

  it('init 把非字符串的脏值回填成默认值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('userAgent', 'custom-ua')

    // 手改库文件造脏值
    const raw = JSON.parse(readFileSync(dbPath, 'utf-8')) as { config: Record<string, unknown> }
    raw.config.userAgent = null
    raw.config.downloadDirectory = 42
    writeFileSync(dbPath, JSON.stringify(raw))

    const reopened = new Database(dbPath)
    reopened.init()

    expect(reopened.getConfig('userAgent')).toBe(CONFIG_DEFAULTS.userAgent)
    expect(reopened.getConfig('downloadDirectory')).toBe(CONFIG_DEFAULTS.downloadDirectory)
  })

  it('getConfig / setConfig 拒绝原型链上的键名', () => {
    const instance = new Database(dbPath)
    instance.init()
    const ipc = asRawIpc(instance)

    expect(() => ipc.getConfig('toString')).toThrow('Invalid config key')
    expect(() => ipc.getConfig('constructor')).toThrow('Invalid config key')
    expect(() => ipc.setConfig('toString', 'x')).toThrow('Invalid config key')
  })
})
