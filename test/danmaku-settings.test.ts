import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDanmakuSettings } from '../src/renderer/src/composables/use-danmaku-settings'

/** 持久化 key 是对外契约：改掉它等于所有用户的弹幕设置被清空 */
const STORAGE_KEY = 'playback-danmaku-settings'

const DEFAULT_SETTINGS = {
  enabled: true,
  opacity: 1,
  fontSize: 24,
  speed: 200,
  area: 1,
}

/** 最小 Web Storage 替身：Node 环境没有 localStorage */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useDanmakuSettings', () => {
  it('初始为默认值', () => {
    expect({ ...useDanmakuSettings().settings }).toEqual(DEFAULT_SETTINGS)
  })

  it('改设置即落盘（不需要调用方显式 save），新实例能读回', () => {
    const first = useDanmakuSettings()
    first.settings.opacity = 0.5
    first.settings.fontSize = 32
    first.settings.enabled = false

    const second = useDanmakuSettings()

    expect({ ...second.settings }).toEqual({ ...DEFAULT_SETTINGS, opacity: 0.5, fontSize: 32, enabled: false })
  })

  it('没存过设置时不为了写默认值而落盘', () => {
    useDanmakuSettings()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('存量数据损坏（非 JSON）时不抛错并保持默认值', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(STORAGE_KEY, '{not json')

    expect(() => useDanmakuSettings()).not.toThrow()
    expect({ ...useDanmakuSettings().settings }).toEqual(DEFAULT_SETTINGS)
  })

  it('存量数据只有部分字段时只覆盖这些字段（旧版本升级不重置其余项）', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ speed: 120 }))

    expect({ ...useDanmakuSettings().settings }).toEqual({ ...DEFAULT_SETTINGS, speed: 120 })
  })

  it('每次调用都是一份独立默认值，改过一个实例后新实例仍拿到干净默认值', () => {
    const first = useDanmakuSettings()
    first.settings.fontSize = 40

    localStorage.removeItem(STORAGE_KEY)

    expect({ ...useDanmakuSettings().settings }).toEqual(DEFAULT_SETTINGS)
  })

  it('每个实例各自持有状态：改一个不影响另一个（回放浮窗与主画面并存）', () => {
    const main = useDanmakuSettings()
    const float = useDanmakuSettings()

    main.settings.fontSize = 40

    expect(float.settings.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    // 存储里已是新值，只是另一个实例不订阅 storage 事件（与抽取前行为一致）
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).fontSize).toBe(40)
  })
})
