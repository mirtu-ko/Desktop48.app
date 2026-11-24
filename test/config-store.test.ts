import type { AppConfig, ConfigKey } from '../src/common/app-config'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS } from '../src/common/app-config'
import { ConfigStore } from '../src/main/config-store'
import { Database } from '../src/main/database'

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'desktop48-config-')), name)
}

/** 绕开编译期类型，模拟 IPC 传进来的裸字符串 */
function asRawIpc(store: ConfigStore) {
  return store as unknown as {
    getConfig: (key: string) => string
    setConfig: (key: string, value: string) => void
  }
}

function readConfigFile(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
}

/** 键校验 + 「未设置」（缺失 / 空串 / 非字符串）一律按默认值生效 */
describe('configStore 配置读写', () => {
  let configPath: string

  beforeEach(() => {
    configPath = tempFile('app-config.json')
  })

  it('init 后未设置的键全部补成默认值并落盘', () => {
    const store = new ConfigStore(configPath)
    store.init()

    for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[])
      expect(store.getConfig(key)).toBe(CONFIG_DEFAULTS[key])

    // 内存与落盘都要对
    expect(readConfigFile(configPath)).toEqual(CONFIG_DEFAULTS)
  })

  it('init 注入的平台默认值会作为未设置配置的初值', () => {
    const store = new ConfigStore(configPath)
    store.init({ downloadDirectory: '/System/Downloads' })

    expect(store.getConfig('downloadDirectory')).toBe('/System/Downloads')
    expect(readConfigFile(configPath).downloadDirectory).toBe('/System/Downloads')
  })

  it('重启时用户设置的下载目录优先于平台默认值', () => {
    const store = new ConfigStore(configPath)
    store.init({ downloadDirectory: '/System/Downloads' })
    store.setConfig('downloadDirectory', '/tmp/downloads')

    const reopened = new ConfigStore(configPath)
    reopened.init({ downloadDirectory: '/System/Downloads' })

    expect(reopened.getConfig('downloadDirectory')).toBe('/tmp/downloads')
  })

  it('init 保留用户设置的非空值', () => {
    const store = new ConfigStore(configPath)
    store.init()
    store.setConfig('downloadDirectory', '/tmp/downloads')
    store.setConfig('ffmpegDirectory', '/tmp/ffmpeg')
    store.setConfig('danmakuPlacement', 'left')

    const reopened = new ConfigStore(configPath) // 模拟重启
    reopened.init()

    expect(reopened.getConfig('downloadDirectory')).toBe('/tmp/downloads')
    expect(reopened.getConfig('ffmpegDirectory')).toBe('/tmp/ffmpeg')
    expect(reopened.getConfig('danmakuPlacement')).toBe('left')
  })

  it('空串视为未设置：读时按默认值生效，重启后落盘成默认值', () => {
    const store = new ConfigStore(configPath)
    store.init()
    store.setConfig('ffmpegDirectory', '')

    // 会话内即生效，不让空值漏给 use-app-config
    expect(store.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)

    const reopened = new ConfigStore(configPath)
    reopened.init()
    expect(reopened.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
    expect(readConfigFile(configPath).ffmpegDirectory).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
  })

  it('init 把非字符串的脏值回填成默认值', () => {
    const store = new ConfigStore(configPath)
    store.init()
    store.setConfig('ffmpegDirectory', '/tmp/ffmpeg')

    // 手改配置文件造脏值
    writeFileSync(configPath, JSON.stringify({
      ...readConfigFile(configPath),
      ffmpegDirectory: null,
      downloadDirectory: 42,
    }))

    const reopened = new ConfigStore(configPath)
    reopened.init()

    expect(reopened.getConfig('ffmpegDirectory')).toBe(CONFIG_DEFAULTS.ffmpegDirectory)
    expect(reopened.getConfig('downloadDirectory')).toBe(CONFIG_DEFAULTS.downloadDirectory)
  })

  it('getConfig / setConfig 拒绝原型链上的键名', () => {
    const store = new ConfigStore(configPath)
    store.init()
    const ipc = asRawIpc(store)

    expect(() => ipc.getConfig('toString')).toThrow('Invalid config key')
    expect(() => ipc.getConfig('constructor')).toThrow('Invalid config key')
    expect(() => ipc.setConfig('toString', 'x')).toThrow('Invalid config key')
  })

  it('枚举型配置拒绝非法取值，文件里的废弃取值回落默认值', () => {
    const store = new ConfigStore(configPath)
    store.init()

    expect(() => asRawIpc(store).setConfig('floatTopmost', 'sometimes')).toThrow('Invalid config value')
    expect(store.getConfig('floatTopmost')).toBe(CONFIG_DEFAULTS.floatTopmost)

    // 手改配置文件造一个已不存在的枚举值
    writeFileSync(configPath, JSON.stringify({
      ...readConfigFile(configPath),
      floatTopmost: 'legacy',
    }))

    const reopened = new ConfigStore(configPath)
    reopened.init()
    expect(reopened.getConfig('floatTopmost')).toBe(CONFIG_DEFAULTS.floatTopmost)
  })

  it('配置写盘不触碰成员库：database.json 一个字节都不动', () => {
    const dbPath = tempFile('database.json')
    // 模拟升级前的旧库：成员数据 + 内嵌配置
    writeFileSync(dbPath, JSON.stringify({ starInfo: [], config: { downloadDirectory: '/tmp/old' } }))

    const db = new Database(dbPath)
    db.init()
    const store = new ConfigStore(configPath)
    store.init({}, db.takeLegacyConfig())
    db.dropLegacyConfig()

    const dbBytesAfterMigration = readFileSync(dbPath, 'utf-8')
    store.setConfig('danmakuPlacement', 'left')

    // 改设置只写 app-config.json
    expect(readFileSync(dbPath, 'utf-8')).toBe(dbBytesAfterMigration)
    expect(readConfigFile(configPath).danmakuPlacement).toBe('left')
  })
})

/** 升级迁移：旧版本把配置存在 database.json 的 config 字段里 */
describe('configStore 从 database.json 迁移', () => {
  let configPath: string

  beforeEach(() => {
    configPath = tempFile('app-config.json')
  })

  it('新文件缺失时用旧库配置，并补齐默认值', () => {
    const store = new ConfigStore(configPath)
    store.init({ downloadDirectory: '/System/Downloads' }, {
      downloadDirectory: '/tmp/legacy',
      danmakuPlacement: 'left',
      trayOnClose: 'off',
    })

    expect(store.getConfig('downloadDirectory')).toBe('/tmp/legacy') // 旧值优先于平台默认值
    expect(store.getConfig('danmakuPlacement')).toBe('left')
    expect(store.getConfig('trayOnClose')).toBe('off')
    // 旧库没有的键补默认值
    expect(store.getConfig('floatTopmost')).toBe(CONFIG_DEFAULTS.floatTopmost)
    // 落盘内容是完整配置
    expect(readConfigFile(configPath)).toEqual({
      ...CONFIG_DEFAULTS,
      downloadDirectory: '/tmp/legacy',
      danmakuPlacement: 'left',
      trayOnClose: 'off',
    })
  })

  it('新文件已存在时完全忽略旧库配置，避免旧值覆盖升级后的修改', () => {
    writeFileSync(configPath, JSON.stringify({ danmakuPlacement: 'video' }))

    const store = new ConfigStore(configPath)
    store.init({}, { danmakuPlacement: 'left', trayOnClose: 'off' })

    expect(store.getConfig('danmakuPlacement')).toBe('video')
    expect(store.getConfig('trayOnClose')).toBe(CONFIG_DEFAULTS.trayOnClose)
  })

  it('旧库的废弃枚举值、未知键与非字符串脏值都不迁移', () => {
    const store = new ConfigStore(configPath)
    store.init({}, {
      floatTopmost: 'legacy', // 已废弃取值
      trayOnClose: 42, // 非字符串
      userAgent: 'legacy-ua', // 已移除的配置项
      downloadDirectory: '/tmp/legacy',
    } as unknown as Partial<AppConfig>)

    expect(store.getConfig('floatTopmost')).toBe(CONFIG_DEFAULTS.floatTopmost)
    expect(store.getConfig('trayOnClose')).toBe(CONFIG_DEFAULTS.trayOnClose)
    expect(store.getConfig('downloadDirectory')).toBe('/tmp/legacy')
    expect('userAgent' in readConfigFile(configPath)).toBe(false)
  })

  it('旧库配置为空对象时按未设置处理', () => {
    const store = new ConfigStore(configPath)
    store.init({}, {})

    for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[])
      expect(store.getConfig(key)).toBe(CONFIG_DEFAULTS[key])
  })
})
