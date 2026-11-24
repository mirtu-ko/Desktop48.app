/**
 * 应用配置的键 / 类型 / 默认值，唯一来源（主进程、preload 契约、渲染端共用）。
 * 「未设置」= 缺失 / 空串 / 非字符串，一律按默认值生效。
 */

/** 弹幕摆放：video = 画面内；left = 移到左侧黑边（黑边不够宽会自动回落 video） */
export type DanmakuPlacement = 'video' | 'left'

/** 关闭主窗口的行为（仅 Windows 托盘模式生效）：on = 最小化到托盘；off = 按原逻辑关闭退出 */
export type TrayOnClose = 'on' | 'off'

/** 独立播放窗置顶策略：always = 始终置顶；playing = 仅播放时置顶；never = 从不置顶 */
export type FloatTopmost = 'always' | 'playing' | 'never'

/**
 * 每个配置键的生效值类型。
 * 用映射类型而不是 `Record<ConfigKey, string>`：`getConfig('danmakuPlacement')` 直接拿到
 * `'video' | 'left'`，消费侧不必再到处做运行时收窄；路径类仍是 string（空串表示未配置）。
 */
export interface AppConfigTypes {
  downloadDirectory: string
  ffmpegDirectory: string
  danmakuPlacement: DanmakuPlacement
  trayOnClose: TrayOnClose
  floatTopmost: FloatTopmost
}

/** 配置生效值类型：init() 补齐默认值后读取不会缺键 */
export type AppConfig = AppConfigTypes

/** 配置的合法键（固定集合，IPC 侧以运行时校验防渲染端乱传） */
export type ConfigKey = keyof AppConfigTypes

/** 各键初始默认值：init() 缺项补齐并写盘（仅此一处写默认值） */
export const CONFIG_DEFAULTS: AppConfig = {
  /** 空串表示「未配置」：下载前由 use-download-guard 提示用户去设置页配置 */
  downloadDirectory: '',
  /** 空串表示「未配置」：首次启动由 Initialize 引导下载/选择 ffmpeg */
  ffmpegDirectory: '',
  /** 弹幕摆放偏好：竖屏直播是否移到左侧黑边，默认留在画面内 */
  danmakuPlacement: 'video',
  /** 关闭主窗口是否最小化到 Windows 系统托盘 */
  trayOnClose: 'on',
  /** 独立播放窗置顶策略：默认沿用「播放中置顶、暂停让出层级」 */
  floatTopmost: 'playing',
}

/** 枚举型配置的合法取值：载入与写入两侧共用，拦住脏值落盘 */
export const CONFIG_ENUMS: Partial<Record<ConfigKey, readonly string[]>> = {
  danmakuPlacement: ['video', 'left'],
  trayOnClose: ['on', 'off'],
  floatTopmost: ['always', 'playing', 'never'],
}

/** 取值收窄：跨 IPC 传来的裸字符串与旧配置都靠它兜住 */
export function isFloatTopmost(value: unknown): value is FloatTopmost {
  return value === 'always' || value === 'playing' || value === 'never'
}

/** 键校验。必须用 hasOwn：`in` 会沿原型链放行 `'toString'` 这类键 */
export function isConfigKey(value: unknown): value is ConfigKey {
  return typeof value === 'string' && Object.hasOwn(CONFIG_DEFAULTS, value)
}

/** 键校验的断言版：IPC 入口与读取侧共用，失败即抛 */
export function assertConfigKey(key: unknown): asserts key is ConfigKey {
  if (!isConfigKey(key))
    throw new Error(`Invalid config key: ${String(key)}`)
}

/** 枚举型配置的取值校验：未登记取值集合的键（路径类）不受限；空串仍算「未设置」由读取侧兜底 */
export function isConfigValueAllowed(key: ConfigKey, value: string): boolean {
  const allowed = CONFIG_ENUMS[key]
  return !allowed || allowed.includes(value)
}

/**
 * 运行时收窄：未知键 / 非字符串 / 未登记的枚举取值一律抛错，返回该键的生效值类型。
 *
 * 这是配置值的唯一收窄口：IPC 传来的裸字符串与旧库里的脏值都走这里，
 * 通过后即可安全赋值给 `AppConfig[K]`，调用方不需要再断言。
 */
export function parseConfigValue<K extends ConfigKey>(key: K, raw: unknown): AppConfig[K] {
  assertConfigKey(key)
  if (typeof raw !== 'string' || !isConfigValueAllowed(key, raw))
    throw new Error(`Invalid config value for ${key}: ${String(raw)}`)
  return raw as AppConfig[K]
}
