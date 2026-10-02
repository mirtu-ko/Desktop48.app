/**
 * 本地路径白名单：openPath 只允许打开系统标准用户目录与用户配置的目录。
 *
 * 与 allowed-hosts.ts 同类 —— 主进程独立维护的安全策略，不信任渲染层传入的参数；
 * 根目录由调用方注入，本模块不依赖 Electron 与数据库，便于直接单测。
 */
import path from 'node:path'

/**
 * filePath 是否落在任一 allowedRoot 之内。
 * 先 resolve 掉相对路径与 `..`；比较必须到分隔符边界，否则 Downloads_backup 会被当作在 Downloads 内。
 */
export function isPathInAllowedRoots(
  filePath: string,
  allowedRoots: string[],
  caseInsensitive = process.platform === 'win32',
): boolean {
  const normalize = (p: string) => (caseInsensitive ? p.toLowerCase() : p)
  const target = normalize(path.resolve(filePath))
  return allowedRoots.some((root) => {
    // 空根目录会被 path.resolve 解析成当前工作目录，等于白送一个放行根，直接跳过
    if (!root)
      return false
    const rootPath = normalize(path.resolve(root))
    return target === rootPath
      || target.startsWith(rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep)
  })
}
