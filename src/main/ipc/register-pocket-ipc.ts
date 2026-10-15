/**
 * 口袋48账号 IPC 通道注册：只接线，登录/凭证逻辑归 main/pocket48/pocket-auth.ts。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { IpcMainInvokeEvent } from 'electron'
import * as pocketAuth from '../pocket48/pocket-auth'
import { handlePocketDanmakuStart, handlePocketDanmakuStop } from '../pocket48/pocket-danmaku'
import * as pocketUnread from '../pocket48/pocket-unread'
import { handleTraced } from './trace'

export function registerPocketIPC(): void {
  handleTraced('pocketSendSms', (_event: IpcMainInvokeEvent, mobile: string, answer?: string) =>
    pocketAuth.sendSms(mobile, answer))
  handleTraced('pocketLoginByCode', (_event: IpcMainInvokeEvent, mobile: string, code: string) =>
    pocketAuth.loginByCode(mobile, code))
  handleTraced('pocketLoginByToken', (_event: IpcMainInvokeEvent, token: string, mobile?: string) =>
    pocketAuth.loginByToken(token, mobile))
  handleTraced('pocketGetAuthState', () => pocketAuth.getAuthState())
  handleTraced('pocketLogout', () => pocketAuth.logout())
  // IM 凭据（accid + imToken）不设 IPC 通道：渲染层零调用方，token 不应出主进程
  // （pocket-danmaku 与 verifyLogin 均在主进程内部直取 getImCredentials）
  handleTraced('pocketGetChatroomId', (_event: IpcMainInvokeEvent, liveId: string) =>
    pocketAuth.getChatroomId(liveId))
  handleTraced('pocketVerifyLogin', () => pocketAuth.verifyLogin())
  // 关注列表（账号维度）：拉取 + 桌面端 toggle 双写；失败以 reject 报错，调用方静默降级
  handleTraced('pocketGetFollowedIds', () => pocketAuth.getFollowedIds())
  handleTraced('pocketFollowMember', (_event: IpcMainInvokeEvent, userId: number) =>
    pocketAuth.followMember(userId))
  handleTraced('pocketUnfollowMember', (_event: IpcMainInvokeEvent, userId: number) =>
    pocketAuth.unfollowMember(userId))
  // 成员房间（口袋 App「房间」频道留言流，非直播间弹幕）：频道解析 + 历史消息拉取
  handleTraced('pocketGetRoomChannel', (_event: IpcMainInvokeEvent, userId: number) =>
    pocketAuth.getRoomChannel(userId))
  handleTraced('pocketGetRoomMessages', (
    _event: IpcMainInvokeEvent,
    channelId: string,
    serverId: string,
    nextTime?: number,
    scope?: 'member' | 'all',
  ) => pocketAuth.getRoomMessages(channelId, serverId, nextTime, scope))
  // 批量最新消息（左侧列表预览）
  handleTraced('pocketGetRoomLastMessages', (_event: IpcMainInvokeEvent, serverIds: string[]) =>
    pocketAuth.getRoomLastMessages(serverIds))
  handleTraced('pocketDanmakuStart', (event, chatroomId: string, liveId: string) =>
    handlePocketDanmakuStart(chatroomId, liveId, event.sender))
  handleTraced('pocketDanmakuStop', (event, chatroomId: string) =>
    handlePocketDanmakuStop(chatroomId, event.sender))
  // 房间未读（主进程 60s 轮询检测，见 main/pocket48/pocket-unread.ts）：快照回取 + 标记已读
  handleTraced('pocketUnreadState', () => pocketUnread.getState())
  handleTraced('pocketMarkRead', (_event: IpcMainInvokeEvent, userId: number) =>
    pocketUnread.markRead(userId))
}
