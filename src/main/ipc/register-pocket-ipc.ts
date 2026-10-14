/**
 * 口袋48账号 IPC 通道注册：只接线，登录/凭证逻辑归 main/pocket48/pocket-auth.ts。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { IpcMainInvokeEvent } from 'electron'
import * as pocketAuth from '../pocket48/pocket-auth'
import { handlePocketDanmakuStart, handlePocketDanmakuStop } from '../pocket48/pocket-danmaku'
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
  handleTraced('pocketDanmakuStart', (event, chatroomId: string, liveId: string) =>
    handlePocketDanmakuStart(chatroomId, liveId, event.sender))
  handleTraced('pocketDanmakuStop', (event, chatroomId: string) =>
    handlePocketDanmakuStop(chatroomId, event.sender))
}
