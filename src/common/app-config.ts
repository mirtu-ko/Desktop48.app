/**
 * 应用配置的键 / 类型 / 默认值，唯一来源（主进程、preload 契约、渲染端共用）。
 * 「未设置」= 缺失 / 空串 / 非字符串，一律按默认值生效。
 */

/** 配置的合法键（固定集合，IPC 侧以运行时校验防渲染端乱传） */
export type ConfigKey = 'downloadDirectory' | 'ffmpegDirectory' | 'danmakuPlacement' | 'trayOnClose'

/** 弹幕摆放：video = 画面内；left = 移到左侧黑边（黑边不够宽会自动回落 video） */
export type DanmakuPlacement = 'video' | 'left'

/** 关闭主窗口的行为（仅 Windows 托盘模式生效）：on = 最小化到托盘；off = 按原逻辑关闭退出 */
export type TrayOnClose = 'on' | 'off'

/** 枚举型配置的合法取值：载入与写入两侧共用，拦住脏值落盘 */
export const CONFIG_ENUMS: Partial<Record<ConfigKey, readonly string[]>> = {
  danmakuPlacement: ['video', 'left'],
  trayOnClose: ['on', 'off'],
}

/** 配置生效值类型：init() 补齐默认值后读取不会缺键 */
export type AppConfig = Record<ConfigKey, string>

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
}
