import { useStorage } from '@vueuse/core'

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

const DEFAULT_SETTINGS: DanmakuSettings = {
  enabled: true,
  opacity: 1,
  fontSize: 24,
  speed: 200,
  area: 1,
}

/**
 * 每实例一份的弹幕设置：回放可同时存在多个实例（浮窗），
 * 各自启动时读同一个持久化 key，保存互不联动（与抽取前行为一致）。
 *
 * 落盘交给 useStorage 的深度监听：改 settings 即写入，调用方不再需要显式 save()。
 */
export function useDanmakuSettings() {
  const stored = useStorage<DanmakuSettings>(
    DANMAKU_SETTINGS_KEY,
    // 传工厂而非常量对象：ref() 不克隆，常量直接被实例改脏会让下个实例读到脏默认值
    () => ({ ...DEFAULT_SETTINGS }),
    localStorage,
    {
      // 各实例互不联动：不订阅 storage 事件（同一窗口的两个实例也会被它串起来）
      listenToStorageChanges: false,
      // 存量数据只有部分字段时只覆盖这些字段，其余补默认值（旧版本升级不重置其余项）
      mergeDefaults: true,
      // 没存过设置时不为了写默认值而落盘
      writeDefaults: false,
      // 改即落盘：原来是显式 save()，同步 flush 保持同样的写入时机
      flush: 'sync',
      onError: (error: unknown) => console.error('[use-danmaku-settings] 弹幕设置读写失败:', error),
    },
  )

  // 交出内部那个响应式对象本身：调用方继续 settings.xxx 读写，写入由深度监听落盘
  return { settings: stored.value }
}
