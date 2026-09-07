/**
 * 直播播放相关 IPC 通道注册。
 *
 * 会话状态与 FFmpeg 转流进程的生命周期归 stream.ts 管理，这里只接线。
 * 注意：createLiveStream 只登记会话并返回本地播放地址，
 * 真正的 FFmpeg 拉流由 http-server.ts 在播放器发起 HTTP 请求时才触发。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import { handleCreateLiveStream, handleStopLiveStream } from '../stream'
import { handleTraced } from './trace'

export function registerStreamIPC(): void {
  handleTraced('createLiveStream', (_event, rtmpUrl: string, liveId: string) =>
    handleCreateLiveStream(rtmpUrl, liveId))
  handleTraced('stopLiveStream', (_event, liveId: string) =>
    handleStopLiveStream(liveId))
}
