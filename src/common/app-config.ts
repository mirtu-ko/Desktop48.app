/**
 * 应用配置的键 / 类型 / 默认值，唯一来源（主进程、preload 契约、渲染端共用）。
 * 「未设置」= 缺失 / 空串 / 非字符串，一律按默认值生效。
 */

/** 配置的合法键（固定集合，IPC 侧以运行时校验防渲染端乱传） */
export type ConfigKey = 'downloadDirectory' | 'ffmpegDirectory' | 'userAgent'

/** 配置生效值类型：init() 补齐默认值后读取不会缺键 */
export type AppConfig = Record<ConfigKey, string>

/** 各键初始默认值：init() 缺项补齐并写盘（仅此一处写默认值） */
export const CONFIG_DEFAULTS: AppConfig = {
  /** 空串表示「未配置」：下载前由 use-download-guard 提示用户去设置页配置 */
  downloadDirectory: '',
  /** 空串表示「未配置」：首次启动由 Initialize 引导下载/选择 ffmpeg */
  ffmpegDirectory: '',
  /** 站点请求 UA（原 renderer constants 的 DEFAULT_USER_AGENT，收拢到此） */
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
}
