/**
 * 独立播放窗口的 IPC 通道注册；窗口状态与生命周期归 main/window/float-window.ts 管理。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { FloatTopmost } from '@common/app-config'
import type { FloatPlayerKind, FloatPlayerPayload } from '@preload/ipc-contract'
import { activeWindow } from '../app'
import { ConfigStore } from '../config-store'
import { applyFloatTopmostPreference, fitFloatWindowAspect, getFloatWindowPayload, getFloatWindowTopmost, openFloatWindow, setFloatWindowPlaying, setFloatWindowTopmost } from '../window/float-window'
import { sendIpc } from './send'
import { handleTraced } from './trace'

export function registerFloatWindowIPC(): void {
  // 打开 / 聚焦独立播放窗：以主窗口所在显示器为锚点摆放
  handleTraced('openFloatWindow', (_event, kind: FloatPlayerKind, payload: FloatPlayerPayload) => {
    openFloatWindow(kind, payload, activeWindow())
  })
  // 播放窗渲染进程回取全量载荷（hash 只带短 key）
  handleTraced('floatPlayerGetPayload', (_event, kind: FloatPlayerKind, liveId: string) =>
    getFloatWindowPayload(kind, liveId))
  // 以下两个都以发起请求的窗口为准，而非主窗口
  handleTraced('floatWindowFitAspect', (event, aspect: number) => {
    fitFloatWindowAspect(event.sender, aspect)
  })
  // 置顶策略：播放中置顶、暂停取消（由播放器上报播放状态变化）
  handleTraced('floatWindowSetPlaying', (event, playing: boolean) => {
    setFloatWindowPlaying(event.sender, playing)
  })
  // 置顶：前两个作用于发起窗口（标题栏图钉），最后一个写全局偏好并波及所有窗（设置页）
  handleTraced('floatWindowGetTopmost', event => getFloatWindowTopmost(event.sender))
  handleTraced('floatWindowSetTopmost', (event, topmost: FloatTopmost) => {
    setFloatWindowTopmost(event.sender, topmost)
  })
  handleTraced('floatWindowSetTopmostPreference', (_event, topmost: FloatTopmost) => {
    ConfigStore.instance().setConfig('floatTopmost', topmost)
    applyFloatTopmostPreference(topmost)
  })
  // 播放窗 → 主进程 → 主窗口：跨渲染进程的 live-unavailable 中转
  handleTraced('notifyLiveUnavailable', (_event, liveId: string) => {
    const main = activeWindow()
    if (main)
      sendIpc(main.webContents, 'liveUnavailable', liveId)
  })
}
