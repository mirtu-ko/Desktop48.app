import { describe, expect, it } from 'vitest'
import { isNewerVersion } from '../src/main/updater-version'

/**
 * macOS 手动检查的版本判定（main/updater-version.ts）。
 * 必须与 electron-updater 的 semver 同口径：否则同一台机器上
 * Windows 会提示升级、macOS 却显示「已是最新」。
 */
describe('isNewerVersion（更新版本比较）', () => {
  it('正式版大于同号 prerelease', () => {
    expect(isNewerVersion('0.2.11', '0.2.11-beta.0')).toBe(true)
    expect(isNewerVersion('0.2.11', '0.2.11-alpha.1')).toBe(true)
    expect(isNewerVersion('0.2.11', '0.2.11')).toBe(false)
  })

  it('prerelease 不会反向覆盖同号正式版', () => {
    expect(isNewerVersion('0.2.11-beta.0', '0.2.11')).toBe(false)
    expect(isNewerVersion('0.2.11-beta.0', '0.2.11-beta.0')).toBe(false)
  })

  it('prerelease 序号按数值比，不按字典序', () => {
    expect(isNewerVersion('0.2.11-beta.10', '0.2.11-beta.9')).toBe(true)
    expect(isNewerVersion('0.2.11-beta.2', '0.2.11-beta.10')).toBe(false)
  })

  it('prerelease 命名按字典序，数字段低于字母段', () => {
    expect(isNewerVersion('0.2.11-beta.0', '0.2.11-alpha.9')).toBe(true)
    expect(isNewerVersion('0.2.11-1', '0.2.11-alpha')).toBe(false)
  })

  it('标识符段少的一方更小', () => {
    expect(isNewerVersion('0.2.11-alpha.1', '0.2.11-alpha')).toBe(true)
    expect(isNewerVersion('0.2.11-alpha', '0.2.11-alpha.1')).toBe(false)
  })

  it('跨号升级按主版本数字判定', () => {
    expect(isNewerVersion('0.2.12-beta.0', '0.2.11')).toBe(true)
    expect(isNewerVersion('0.3', '0.2.11')).toBe(true)
    expect(isNewerVersion('0.2.10', '0.2.11-beta.0')).toBe(false)
  })

  it('忽略 v 前缀与构建元数据', () => {
    expect(isNewerVersion('v0.2.12', '0.2.11')).toBe(true)
    expect(isNewerVersion('0.2.11+build.5', '0.2.11')).toBe(false)
    expect(isNewerVersion('0.2.12+exp.sha.5114f85', 'v0.2.11')).toBe(true)
  })

  it('非法段按 0 处理，不抛错', () => {
    expect(() => isNewerVersion('0.2.x', '')).not.toThrow()
    expect(isNewerVersion('0.2.11', '0.2.x')).toBe(true)
  })
})
