/* eslint-disable no-console -- 本文件是日志核心，console 是唯一输出通道 */

/**
 * 跨进程共用日志核心（渲染层/主进程同构，只依赖 console，不落盘）。
 *
 * - verbose 级别记「决策点与状态流转」，不记高频心跳（如任务 progress，
 *   逐帧输出会淹没真正有用的片段）；门控由各进程在模块加载时注入：
 *   - 渲染层 src/renderer/src/utils/debug.ts → import.meta.env.DEV（生产构建后恒为 false）
 *   - 主进程 src/main/logger.ts → @electron-toolkit/utils 的 is.dev
 * - 主动用 console.log 而非 console.debug：后者默认被 DevTools 的 Verbose 过滤器隐藏，
 *   排查时会「以为没日志」；[DBG] 前缀保证默认面板即可见、可一键过滤
 * - 通用级别 log/warn/error/debug 供主进程沿用（消息内自带模块前缀，如 [stream.ts]）
 */

let verboseEnabled = false

/** 各进程模块加载时注入 verbose 门控，运行期不切换——避免日志级别抖动导致排查时缺片段 */
export function setVerboseEnabled(v: boolean): void {
  verboseEnabled = v
}

export function isVerboseEnabled(): boolean {
  return verboseEnabled
}

/** verbose 级别（scope 化）：scope 取值见 src/renderer/src/utils/debug.ts 的对照表 */
export function debugLog(scope: string, ...args: unknown[]): void {
  if (verboseEnabled)
    console.log(`[DBG][${scope}]`, ...args)
}

// ── 通用级别（主进程沿用，不带 scope 前缀） ──

export function log(...args: unknown[]): void {
  console.log(...args)
}

export function warn(...args: unknown[]): void {
  console.warn(...args)
}

export function error(...args: unknown[]): void {
  console.error(...args)
}

export function debug(...args: unknown[]): void {
  if (verboseEnabled)
    console.log('[DBG]', ...args)
}
