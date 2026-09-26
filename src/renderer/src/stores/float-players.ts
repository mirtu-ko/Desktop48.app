/**
 * 独立播放窗的渲染端入口。
 *
 * 早期这里是「全局单例浮窗列表」（DOM 浮层），现已改为真正的 Electron 独立窗口：
 * 窗口的创建 / 去重 / 聚焦 / 关闭全部由主进程（main/float-window.ts）持有，
 * 本 store 只负责把页面意图转成一次 IPC 调用，因此不再持有任何可变状态。
 *
 * 页面 API（openLive / openPlayback）保持不变：直播 / 回放 / 公演三个列表页无需改动。
 */
import type { FloatPlayerKind, FloatPlayerPayload } from '../../../preload/ipc-contract'
import EventBus from '@renderer/services/event-bus'

export type { FloatPlayerKind, FloatPlayerPayload } from '../../../preload/ipc-contract'

export function useFloatPlayersStore() {
  /** 打开直播播放窗；同一路直播已打开时由主进程聚焦复用 */
  function openLive(payload: FloatPlayerPayload) {
    openPlayer('live', payload)
  }

  /** 打开回放播放窗；同一路回放已打开时由主进程聚焦复用 */
  function openPlayback(payload: FloatPlayerPayload) {
    openPlayer('playback', payload)
  }

  function openPlayer(kind: FloatPlayerKind, payload: FloatPlayerPayload) {
    void window.mainAPI.openFloatWindow(kind, payload).catch((error: unknown) => {
      console.error('[float-players] 打开独立播放窗失败:', error)
    })
  }

  return { openLive, openPlayback }
}

/**
 * 主窗口侧的独立播放窗桥接（仿 installTasks：显式安装、幂等）。
 *
 * 独立播放窗是另一个渲染进程，它发出的 EventBus 事件到不了主窗口。
 * 播放窗把 live-unavailable 上报主进程，主进程再转发给主窗口，这里把它重新注入本地 EventBus，
 * 列表页（Lives.vue）的自动刷新因此不受影响。
 */
let installed = false

export function installFloatPlayers(): void {
  if (installed)
    return
  installed = true
  window.mainAPI.liveUnavailable((liveId) => {
    EventBus.emit('live-unavailable', liveId)
  })
}

export default useFloatPlayersStore
