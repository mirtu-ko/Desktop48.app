/**
 * 口袋48账号 IPC 通道注册：只接线，登录/凭证逻辑归 main/pocket48/pocket-auth.ts。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { PocketClientProfileId } from '@preload/ipc-contract'
import type { IpcMainInvokeEvent } from 'electron'
import * as pocketAuth from '../pocket48/pocket-auth'
import { handlePocketDanmakuStart, handlePocketDanmakuStop, resetPocketDanmakuSessions } from '../pocket48/pocket-danmaku'
import * as pocketUnread from '../pocket48/pocket-unread'
import { broadcastIpc } from './send'
import { handleTraced } from './trace'

export function registerPocketIPC(): void {
  // token 失效清凭证时广播各窗口：渲染层 pocket-auth 镜像同步复位，
  // 免得房间页已报「登录过期」而设置页仍显示已登录（对端：stores/pocket-auth.ts）
  pocketAuth.setAuthExpiredNotifier(() => broadcastIpc('pocketAuthExpired'))
  handleTraced('pocketSendSms', (
    _event: IpcMainInvokeEvent,
    mobile: string,
    area?: string,
    answer?: string,
    clientProfile?: PocketClientProfileId,
  ) => pocketAuth.sendSms(mobile, area, answer, clientProfile))
  handleTraced('pocketLoginByCode', (
    _event: IpcMainInvokeEvent,
    mobile: string,
    code: string,
    area?: string,
    clientProfile?: PocketClientProfileId,
  ) => pocketAuth.loginByCode(mobile, code, area, clientProfile))
  handleTraced('pocketLoginByToken', (
    _event: IpcMainInvokeEvent,
    token: string,
    mobile?: string,
    clientProfile?: PocketClientProfileId,
  ) => pocketAuth.loginByToken(token, mobile, clientProfile))
  handleTraced('pocketGetAuthState', () => pocketAuth.getAuthState())
  handleTraced('pocketLogout', () => {
    // 凭证既然要删，按该凭证建立的聊天室长连接（含进房身份）也一并断掉
    resetPocketDanmakuSessions()
    return pocketAuth.logout()
  })
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
  // 房间精华消息（顶部置顶条与精华列表）：与消息范围无关，只在进房时拉一次
  handleTraced('pocketGetRoomEssenceMessages', (
    _event: IpcMainInvokeEvent,
    channelId: string,
    serverId: string,
    nextTime?: number,
  ) => pocketAuth.getRoomEssenceMessages(channelId, serverId, nextTime))
  // 批量最新消息（左侧列表预览）
  handleTraced('pocketGetRoomLastMessages', (_event: IpcMainInvokeEvent, serverIds: string[]) =>
    pocketAuth.getRoomLastMessages(serverIds))
  // 频道名（seine 频道详情）：房间 / 小房间 tab 显示真实频道名
  handleTraced('pocketGetServerChannels', (_event: IpcMainInvokeEvent, serverId: string) =>
    pocketAuth.getServerChannels(serverId))
  handleTraced('pocketDanmakuStart', (event, chatroomId: string, liveId: string) =>
    handlePocketDanmakuStart(chatroomId, liveId, event.sender))
  handleTraced('pocketDanmakuStop', (event, chatroomId: string) =>
    handlePocketDanmakuStop(chatroomId, event.sender))
  // 房间未读（主进程 60s 轮询检测，见 main/pocket48/pocket-unread.ts）：
  // 快照回取 + 小房间频道查询 + 标记已读（target 区分大/小房间）
  handleTraced('pocketUnreadState', () => pocketUnread.getState())
  handleTraced('pocketGetSmallChannel', (_event: IpcMainInvokeEvent, userId: number) =>
    pocketUnread.getSmallChannel(userId))
  // 小房间暗号：问题拉取（room/info 拦截信封）+ 作答校验（万能密码客户端直通）
  handleTraced('pocketGetRoomQuestion', (_event: IpcMainInvokeEvent, channelId: string) =>
    pocketAuth.getRoomQuestion(channelId))
  handleTraced('pocketCheckRoomAnswer', (_event: IpcMainInvokeEvent, channelId: string, questionId: string, answer: string) =>
    pocketAuth.checkRoomAnswer(channelId, questionId, answer))
  handleTraced('pocketMarkRead', (_event: IpcMainInvokeEvent, userId: number, target?: 'room' | 'small') =>
    pocketUnread.markRead(userId, target))
}
