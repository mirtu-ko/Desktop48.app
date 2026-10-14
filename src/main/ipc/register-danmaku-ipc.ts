/**
 * B 站弹幕 IPC 通道注册：只接线，连接与订阅状态归 main/bilibili/danmaku-session.ts。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import { handleDanmakuStart, handleDanmakuStop } from '../bilibili/danmaku-session'
import { getBilibiliRoomInfos } from '../bilibili/room-info'
import { handleTraced } from './trace'

export function registerDanmakuIPC(): void {
  handleTraced('danmakuStart', (event, roomId: number) =>
    handleDanmakuStart(roomId, event.sender))
  handleTraced('danmakuStop', (event, roomId: number) =>
    handleDanmakuStop(roomId, event.sender))
  // 房间信息：公演缺团体信息时，渲染层以在播房间标题做公演名兜底匹配
  handleTraced('bilibiliRoomInfos', () => getBilibiliRoomInfos())
}
