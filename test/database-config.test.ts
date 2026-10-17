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

  it('init 注入的平台默认值会作为未设置配置的初值', () => {
    const instance = new Database(dbPath)
    instance.init({ downloadDirectory: '/System/Downloads' })

    expect(instance.getConfig('downloadDirectory')).toBe('/System/Downloads')
    expect(readConfigFile(dbPath).downloadDirectory).toBe('/System/Downloads')
  })

  it('重启时用户设置的下载目录优先于平台默认值', () => {
    const instance = new Database(dbPath)
    instance.init({ downloadDirectory: '/System/Downloads' })
    instance.setConfig('downloadDirectory', '/tmp/downloads')

    const reopened = new Database(dbPath)
    reopened.init({ downloadDirectory: '/System/Downloads' })

    expect(reopened.getConfig('downloadDirectory')).toBe('/tmp/downloads')
  })

  it('init 保留用户设置的非空值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('downloadDirectory', '/tmp/downloads')
    instance.setConfig('ffmpegDirectory', '/tmp/ffmpeg')

    const reopened = new Database(dbPath) // 模拟重启
    reopened.init()

    expect(reopened.getConfig('downloadDirectory')).toBe('/tmp/downloads')
    expect(reopened.getConfig('ffmpegDirectory')).toBe('/tmp/ffmpeg')
  })

  it('空串视为未设置：读时按默认值生效，重启后落盘成默认值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('ffmpegDirectory', '')

    // 会话内即生效，不让空值漏给 use-app-config
    expect(instance.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)

    const reopened = new Database(dbPath)
    reopened.init()
    expect(reopened.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
    expect(readConfigFile(dbPath).ffmpegDirectory).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
  })

  it('init 把非字符串的脏值回填成默认值', () => {
    const instance = new Database(dbPath)
    instance.init()
    instance.setConfig('ffmpegDirectory', '/tmp/ffmpeg')

    // 手改库文件造脏值
    const raw = JSON.parse(readFileSync(dbPath, 'utf-8')) as { config: Record<string, unknown> }
    raw.config.ffmpegDirectory = null
    raw.config.downloadDirectory = 42
    writeFileSync(dbPath, JSON.stringify(raw))

    const reopened = new Database(dbPath)
    reopened.init()

    expect(reopened.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
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

    const raw = JSON.parse(readFileSync(dbPath, 'utf-8')) as Record<string, unknown>
    expect('allmembersSimple' in raw).toBe(false)
    expect(raw.allmembers).toEqual([{ sid: '10337', sname: '曹可甜' }])
  })

  it('init 丢弃已废弃的 config.userAgent（该配置项与设置页入口已移除）', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({
      config: { downloadDirectory: '/tmp/downloads', ffmpegDirectory: '', userAgent: 'legacy-ua' },
    }))

    const instance = new Database(dbPath)
    instance.init()

    const config = readConfigFile(dbPath)
    expect('userAgent' in config).toBe(false)
    // 其余配置项照常保留
    expect(config.downloadDirectory).toBe('/tmp/downloads')
  })
})
