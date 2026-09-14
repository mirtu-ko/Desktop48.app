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

  it('save 写入后新实例 load 能读回（跨实例持久化）', () => {
    const first = useDanmakuSettings()
    first.settings.opacity = 0.5
    first.settings.fontSize = 32
    first.settings.enabled = false
    first.save()

    const second = useDanmakuSettings()
    second.load()

    expect({ ...second.settings }).toEqual({ ...DEFAULT_SETTINGS, opacity: 0.5, fontSize: 32, enabled: false })
  })

  it('save 写的是当时的快照，之后再改设置不会回写已存的值', () => {
    const { settings, save } = useDanmakuSettings()
    save()
    settings.opacity = 0.3

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).opacity).toBe(1)
  })

  it('没有存过任何设置时 load 保持默认值', () => {
    const { settings, load } = useDanmakuSettings()
    load()
    expect({ ...settings }).toEqual(DEFAULT_SETTINGS)
  })

  it('存量数据损坏（非 JSON）时 load 不抛错并保持默认值', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(STORAGE_KEY, '{not json')

    const { settings, load } = useDanmakuSettings()

    expect(() => load()).not.toThrow()
    expect({ ...settings }).toEqual(DEFAULT_SETTINGS)
  })

  it('存量数据只有部分字段时只覆盖这些字段（旧版本升级不重置其余项）', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ speed: 120 }))

    const { settings, load } = useDanmakuSettings()
    load()

    expect({ ...settings }).toEqual({ ...DEFAULT_SETTINGS, speed: 120 })
  })

  it('每个实例各自持有状态：改一个不影响另一个（回放浮窗与主画面并存）', () => {
    const main = useDanmakuSettings()
    const float = useDanmakuSettings()

    main.settings.fontSize = 40

    expect(float.settings.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  })
})
