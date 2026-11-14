/**
 * 更新版本比较（语义化版本）。
 * 与 electron-updater 的 semver 同口径：prerelease 恒小于同号正式版，否则两平台判定会打架。
 */

/** 主版本数字段与 prerelease 标识符段；构建元数据（`+xxx`）不参与比较。 */
interface ParsedVersion {
  nums: number[]
  pre: string[]
}

/** 拆 `v1.2.3-beta.1+build`：非法主段按 0，prerelease 段保留原文参与比较。 */
function parseVersion(version: string): ParsedVersion {
  const normalized = version.trim().replace(/^v/i, '').split('+')[0] ?? ''
  const dashIndex = normalized.indexOf('-')
  const core = dashIndex === -1 ? normalized : normalized.slice(0, dashIndex)
  const pre = dashIndex === -1 ? '' : normalized.slice(dashIndex + 1)
  return {
    nums: core.split('.').map(part => Number.parseInt(part, 10) || 0),
    pre: pre ? pre.split('.') : [],
  }
}

/** 单个标识符：纯数字按数值比，数字段优先级低于字母段，其余按字典序。 */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric)
    return Number(a) - Number(b)
  if (aNumeric !== bNumeric)
    return aNumeric ? -1 : 1
  if (a === b)
    return 0
  return a < b ? -1 : 1
}

/** 逐段比较：先主版本数字，主段相同再比 prerelease。返回 >0 表示 a 更新。 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const width = Math.max(a.nums.length, b.nums.length)
  for (let i = 0; i < width; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (diff !== 0)
      return diff
  }

  // 主段相同：正式版大于任何 prerelease
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length)
      return 0
    return a.pre.length === 0 ? 1 : -1
  }

  // 标识符逐段比，段数少的一方更小（1.0.0-alpha < 1.0.0-alpha.1）
  const preWidth = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < preWidth; i++) {
    if (i >= a.pre.length)
      return -1
    if (i >= b.pre.length)
      return 1
    const diff = compareIdentifier(a.pre[i] ?? '', b.pre[i] ?? '')
    if (diff !== 0)
      return diff
  }
  return 0
}

/** next 比 current 新时返回 true；相同或更旧返回 false。 */
export function isNewerVersion(next: string, current: string): boolean {
  return compareParsed(parseVersion(next), parseVersion(current)) > 0
}
