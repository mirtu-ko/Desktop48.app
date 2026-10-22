/**
 * 独立播放窗的渲染端入口：把页面意图转成一次 IPC 调用。
 * 窗口的创建 / 去重 / 聚焦 / 关闭全部由主进程（main/float-window.ts）持有，
 * 本 store 不持有可变状态；页面 API（openLive / openPlayback）保持不变。
 *
 * 开播前在这里做一次 FFmpeg 校验（见 use-live-guard）：直播播放依赖主进程 FFmpeg 转流，
 * 环境不可用时开出来的窗口只会停在加载态，不如就地拦下并引导到设置页。
 * 四个开播入口（直播列表 / 公演页 / 房间资料卡 / 房间分享卡）都经 openLive，因此只需接一处。
 */
import type { FloatPlayerKind, FloatPlayerPayload } from '@preload/ipc-contract'
import { useLiveGuard } from '@renderer/composables/use-live-guard'
import EventBus from '@renderer/services/event-bus'

export function useFloatPlayersStore() {
  const { checkLiveReady } = useLiveGuard()

  /** 打开直播播放窗；同一路直播已打开时由主进程聚焦复用 */
  function openLive(payload: FloatPlayerPayload) {
    // 保持同步签名（调用方均为点击回调）：校验在内部完成，不通过则不开窗
    void guardThenOpen(payload)
  }

  async function guardThenOpen(payload: FloatPlayerPayload) {
    if (!await checkLiveReady())
      return
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
 * 主窗口侧桥接（显式安装、幂等）：播放窗与主窗口不共享 EventBus，
 * 播放窗上报的 live-unavailable 经主进程转发后在这里重新注入本地 EventBus。
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
