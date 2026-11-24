import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../src/main/database'

function tempDatabaseFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'desktop48-db-')), 'database.json')
}

function readRaw(dbPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(dbPath, 'utf-8')) as Record<string, unknown>
}

/**
 * 配置已迁到 app-config.json（config-store.ts）。database.json 里的旧 config 字段
 * 只作为升级迁移的来源：init 不动它，迁移成功后才由 dropLegacyConfig 清除。
 */
describe('database 旧库配置的迁移交接', () => {
  it('init 保留旧 config 字段，原样交给 ConfigStore', () => {
    const dbPath = tempDatabaseFile()
    const legacy = { downloadDirectory: '/tmp/downloads', danmakuPlacement: 'left' }
    writeFileSync(dbPath, JSON.stringify({ starInfo: [], config: legacy }))

    const instance = new Database(dbPath)
    instance.init()

    expect(instance.takeLegacyConfig()).toEqual(legacy)
    // 还没迁移完就不能丢：落盘文件里仍在
    expect(readRaw(dbPath).config).toEqual(legacy)
  })

  it('dropLegacyConfig 清除旧字段并落盘，内存也随之消失', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({ starInfo: [], config: { downloadDirectory: '/tmp/downloads' } }))

    const instance = new Database(dbPath)
    instance.init()
    instance.dropLegacyConfig()

    expect(instance.takeLegacyConfig()).toBeUndefined()
    expect('config' in readRaw(dbPath)).toBe(false)
  })

  it('新库没有旧 config 时 dropLegacyConfig 不写盘', () => {
    const dbPath = tempDatabaseFile()
    const instance = new Database(dbPath)
    instance.init()

    const before = readFileSync(dbPath, 'utf-8')
    instance.dropLegacyConfig()

    // 不存在的字段不该触发 1 MB 级的整库 fsync
    expect(readFileSync(dbPath, 'utf-8')).toBe(before)
  })

  it('未知键随旧字段一起清掉，不会迁进新配置', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({ starInfo: [], config: { userAgent: 'legacy-ua', downloadDirectory: '/tmp/downloads' } }))

    const instance = new Database(dbPath)
    instance.init()
    instance.dropLegacyConfig()

    expect('config' in readRaw(dbPath)).toBe(false)
  })
})

/** allmembersSimple 已停止拉取（它是 allmembers 的字段子集），旧库残留要在 init() 清掉，否则会一直占着文件 */
describe('database 旧库残留字段清理', () => {
  it('init 删除旧库残留的 allmembersSimple，内存与落盘都不留', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({
      allmembers: [{ sid: '10337', sname: '曹可甜' }],
      allmembersSimple: [{ sid: '10337', sname: '曹可甜', ranking: '3' }],
    }))

    const instance = new Database(dbPath)
    instance.init()

    expect('allmembersSimple' in instance.db).toBe(false)
    // 兼职成员档案（兼任卡片）与官方账号（官方频道取名/头像）随名单一起下发，旧库里没有这两个字段时为 []
    expect(instance.getAllMembers()).toEqual({ allmembers: [{ sid: '10337', sname: '曹可甜' }], adjuncts: [], officials: [] })

    const raw = readRaw(dbPath)
    expect('allmembersSimple' in raw).toBe(false)
    expect(raw.allmembers).toEqual([{ sid: '10337', sname: '曹可甜' }])
  })
})
