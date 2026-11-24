/**
 * 应用配置的唯一存储：userData/app-config.json。
 *
 * 与成员库（database.json，见 main/database.ts）分开的原因：
 * - 写频率与生命周期不同：配置每次改设置就写，成员数据只在同步时写；
 * - 体积差三个数量级：配置约 200 B，成员库 1 MB+。混在一个文件里，改一次设置
 *   就要重写整库并 fsync（备份 copy + write + fsync + rename），主进程同步阻塞；
 * - 职责单一：Database 只管成员域，配置读写可脱离 Electron 直接测。
 *
 * 迁移：旧版本把配置存在 database.json 的 `config` 字段里。init() 在 app-config.json
 * 缺失时接受调用方传入的 legacy（Database.takeLegacyConfig()），逐键校验后写新文件；
 * 调用方写完再 Database.dropLegacyConfig() 清掉旧字段。
 *
 * 模块导入无副作用：单例懒创建（首次 instance() 时构造），init() 由 app.ts 显式调用。
 * configPath 支持注入，便于脱离 Electron 做测试。
 */
import type { AppConfig, ConfigKey } from '@common/app-config'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertConfigKey, CONFIG_DEFAULTS, isConfigKey, isConfigValueAllowed, parseConfigValue } from '@common/app-config'
import { app } from 'electron'
import { log } from './logger'
import { SafeJSONFileSync } from './safe-json-file-sync'

class ConfigStore {
  private static store: ConfigStore | null = null

  private readonly storage: SafeJSONFileSync<AppConfig>
  private readonly configPath: string
  private config!: AppConfig

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(app.getPath('userData'), 'app-config.json')
    this.storage = new SafeJSONFileSync(this.configPath)
  }

  public static instance() {
    this.store ??= new ConfigStore()
    return this.store
  }

  /**
   * 读取配置并补齐默认值；只在文件缺失或内容有变化时落盘（启动不做无谓 fsync）。
   *
   * @param runtimeDefaults 平台相关的默认值（如系统下载目录）。不能放进共享 CONFIG_DEFAULTS：
   *   纯 Node 测试无法提供 app.getPath。
   * @param legacy 旧 database.json 里的配置。仅当 app-config.json 不存在时作为初值；
   *   已有新文件时完全忽略，避免旧值覆盖用户升级后的修改。
   */
  public init(runtimeDefaults: Partial<AppConfig> = {}, legacy?: unknown): void {
    if (!existsSync(dirname(this.configPath)))
      mkdirSync(dirname(this.configPath), { recursive: true })

    const stored = this.storage.read()
    // 装配期用宽类型承接动态键：联合键无法让 TS 证明「键-值」配对，
    // 取值已在下面逐键校验，装配完再一次性收窄回 AppConfig
    const config: Record<ConfigKey, string> = { ...CONFIG_DEFAULTS }
    for (const [key, value] of Object.entries(runtimeDefaults)) {
      if (isConfigKey(key) && typeof value === 'string' && value)
        config[key] = value
    }

    // 新文件存在时以它为准；否则用旧库配置（迁移），缺失/脏值一律回落默认值
    const source = stored ?? (legacy as Partial<Record<ConfigKey, unknown>> | undefined)
    if (source) {
      for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[]) {
        const value = source[key]
        // 枚举型键的旧值可能是已废弃的取值：一并当作未设置
        if (typeof value === 'string' && value !== '' && isConfigValueAllowed(key, value))
          config[key] = value
      }
    }
    this.config = config as AppConfig

    if (!stored || JSON.stringify(stored) !== JSON.stringify(this.config))
      this.storage.write(this.config)
    log('[config-store]配置文件路径', this.configPath)
  }

  /**
   * 读取配置：纯读操作，不写盘。init() 已补齐未设置的键，故恒返回生效值。
   * 末尾回退只作防御（空串同样算未设置）。
   */
  public getConfig<K extends ConfigKey>(key: K): AppConfig[K] {
    assertConfigKey(key)
    return this.config[key] || CONFIG_DEFAULTS[key]
  }

  /**
   * 写入配置：运行时校验 + 收窄一次（IPC 传来的裸字符串由 parseConfigValue 兜住），
   * 校验通过后才落盘，避免脏值进库。
   */
  public setConfig<K extends ConfigKey>(key: K, value: AppConfig[K]) {
    const normalized = parseConfigValue(key, value)
    this.config[key] = normalized
    this.storage.write(this.config)
  }

  /** 配置文件路径（日志与诊断用） */
  public get filePath(): string {
    return this.configPath
  }
}

export { ConfigStore }
