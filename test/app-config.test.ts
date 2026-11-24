import { describe, expect, expectTypeOf, it } from 'vitest'
import { CONFIG_DEFAULTS, isConfigKey, isConfigValueAllowed, isFloatTopmost, parseConfigValue } from '../src/common/app-config'

/** 配置值的运行时收窄：IPC 裸字符串与旧库脏值都走 parseConfigValue */
describe('parseConfigValue（配置值运行时收窄）', () => {
  it('枚举型键：登记过的取值原样返回，并收窄成精确类型', () => {
    const placement = parseConfigValue('danmakuPlacement', 'left')
    expect(placement).toBe('left')
    // 收窄后不是宽泛的 string：调用方不需要再断言
    expectTypeOf(placement).toEqualTypeOf<'video' | 'left'>()
  })

  it('枚举型键：未登记的取值抛错，不落库', () => {
    expect(() => parseConfigValue('floatTopmost', 'sometimes')).toThrow('Invalid config value for floatTopmost')
    expect(() => parseConfigValue('trayOnClose', 'maybe')).toThrow('Invalid config value for trayOnClose')
  })

  it('路径类键：任意字符串通过（空串表示未配置，由读取侧兜底）', () => {
    expect(parseConfigValue('downloadDirectory', '/tmp/downloads')).toBe('/tmp/downloads')
    expect(parseConfigValue('ffmpegDirectory', '')).toBe('')
  })

  it('非字符串一律拒绝', () => {
    expect(() => parseConfigValue('downloadDirectory', 42)).toThrow('Invalid config value')
    expect(() => parseConfigValue('downloadDirectory', null)).toThrow('Invalid config value')
  })

  it('未知键拒绝，含原型链上的键名', () => {
    expect(() => parseConfigValue('toString' as never, 'x')).toThrow('Invalid config key')
    expect(() => parseConfigValue('constructor' as never, 'x')).toThrow('Invalid config key')
    expect(() => parseConfigValue('userAgent' as never, 'x')).toThrow('Invalid config key')
  })
})

/** 键 / 取值校验的纯函数：主进程 init 与 IPC 入口共用同一套判定 */
describe('配置校验辅助函数', () => {
  it('isConfigKey 只认固定集合内的自有键', () => {
    for (const key of Object.keys(CONFIG_DEFAULTS))
      expect(isConfigKey(key)).toBe(true)
    expect(isConfigKey('toString')).toBe(false)
    expect(isConfigKey('')).toBe(false)
    expect(isConfigKey(undefined)).toBe(false)
  })

  it('isConfigValueAllowed：未登记取值集合的键不受限，枚举键只认登记值', () => {
    expect(isConfigValueAllowed('downloadDirectory', '')).toBe(true)
    expect(isConfigValueAllowed('downloadDirectory', '/any/path')).toBe(true)
    expect(isConfigValueAllowed('danmakuPlacement', 'left')).toBe(true)
    expect(isConfigValueAllowed('danmakuPlacement', 'right')).toBe(false)
  })

  it('isFloatTopmost 收窄裸字符串', () => {
    expect(isFloatTopmost('playing')).toBe(true)
    expect(isFloatTopmost('legacy')).toBe(false)
    expect(isFloatTopmost(null)).toBe(false)
  })
})
