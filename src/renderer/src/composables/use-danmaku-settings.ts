import { reactive } from 'vue'

export interface DanmakuSettings {
  enabled: boolean
  opacity: number
  fontSize: number
  speed: number
  /** 弹幕可占用的高度比例，1 表示铺满 */
  area: number
}

// 弹幕显示设置持久化在 localStorage（主进程 config 只接受固定几个 key）
const DANMAKU_SETTINGS_KEY = 'playback-danmaku-settings'

/**
 * 每实例一份的弹幕设置：回放可同时存在多个实例（浮窗），
 * 各自启动时读同一个持久化 key，保存互不联动（与抽取前行为一致）。
 */
export function useDanmakuSettings() {
  const settings = reactive<DanmakuSettings>({
    enabled: true,
    opacity: 1,
    fontSize: 24,
    speed: 200,
    area: 1,
  })

  function load() {
    try {
      const raw = localStorage.getItem(DANMAKU_SETTINGS_KEY)
      if (!raw)
        return
      Object.assign(settings, JSON.parse(raw) as Partial<DanmakuSettings>)
    }
    catch (error) {
      console.error('[use-danmaku-settings] 弹幕设置读取失败:', error)
    }
  }

  function save() {
    localStorage.setItem(DANMAKU_SETTINGS_KEY, JSON.stringify({ ...settings }))
  }

  return { settings, load, save }
}
