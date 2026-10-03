/**
 * logger 的测试替身：真实 logger 在模块求值期调 electron 的 app.getPath，纯 Node 环境加载不了。
 * 导出面必须与 src/main/logger.ts 一致，否则被测模块调 debug 时会炸在日志语句上。
 */
export function debug(..._args: unknown[]): void {}
export function log(..._args: unknown[]): void {}
export function error(..._args: unknown[]): void {}
export function warn(..._args: unknown[]): void {}
export function isVerboseEnabled(): boolean {
  return false
}
