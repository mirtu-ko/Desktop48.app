/**
 * 口袋48登录态的共享实现（模块级单例，与 stores/member-flags.ts 同一模式）。
 *
 * 状态镜像自主进程 pocket48-auth.json：本 store 只负责拉取/登录/退出的接线与提示，
 * 不持有凭证本体——token 只留在主进程，渲染层拿到的永远是脱敏登录态。
 * 登录态一律经 applyAuthState 写入，账号身份变化时顺带作废小房间暗号的解锁态。
 */
import type { PocketAuthState, PocketVerifyResult } from '@preload/ipc-contract'
import { clearSmallRoomUnlocks } from '@renderer/utils/small-room-unlock'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

const LOGGED_OUT: PocketAuthState = {
  loggedIn: false,
  nickname: '',
  avatar: '',
  mobileMasked: '',
  plainFallback: false,
  savedAt: 0,
}

/** 登录态快照；启动后由调用方（设置页）refresh 一次 */
export const pocketAuthState = ref<PocketAuthState>({ ...LOGGED_OUT })

/** 是否已拉取过一次登录态（避免未初始化时直播页误判未登录） */
let initialized = false

/**
 * 账号身份指纹：登录态里没有 userId，用「脱敏手机号 + 昵称 + 凭证保存时刻」当身份。
 * 退出走 LOGGED_OUT（savedAt=0）、换号手机号必变、同账号重登 savedAt 必变，三种都判得出。
 */
function accountKey(state: PocketAuthState): string {
  return `${state.mobileMasked}|${state.nickname}|${state.savedAt}`
}

/**
 * 登录态唯一写入口。身份一变就作废小房间暗号的解锁态（utils/small-room-unlock.ts）：
 * channelId 跨账号稳定，不清等于把上一个账号解锁过的小房间直接交给新账号——
 * 消息列表接口不带暗号，渲染层这道锁是唯一防线。
 */
function applyAuthState(next: PocketAuthState): void {
  if (accountKey(next) !== accountKey(pocketAuthState.value))
    clearSmallRoomUnlocks()
  pocketAuthState.value = next
}

/** 拉取当前登录态（读主进程本地凭证，无网络请求） */
export async function refreshPocketAuthState(): Promise<PocketAuthState> {
  try {
    applyAuthState(await window.mainAPI.pocketGetAuthState())
    initialized = true
  }
  catch (error) {
    console.error('[pocket-auth] 读取登录态失败:', error)
  }
  return pocketAuthState.value
}

/** 启动后首个调用方同步初始化；已初始化则直接复用内存镜像（不发 IPC） */
export function ensurePocketAuthState(): PocketAuthState {
  if (!initialized)
    void refreshPocketAuthState()
  return pocketAuthState.value
}

/** 验证码登录；成功后更新登录态，失败抛错由调用方提示 */
export async function loginBySmsCode(mobile: string, code: string, area?: string): Promise<PocketAuthState> {
  const state = await window.mainAPI.pocketLoginByCode(mobile, code, area)
  applyAuthState(state)
  return state
}

/** Token 粘贴登录；成功后更新登录态，失败抛错由调用方提示 */
export async function loginByPastedToken(token: string, mobile = ''): Promise<PocketAuthState> {
  const state = await window.mainAPI.pocketLoginByToken(token, mobile)
  applyAuthState(state)
  return state
}

/** 退出登录：主进程删除凭证文件，本地状态复位 */
export async function logoutPocket(): Promise<void> {
  await window.mainAPI.pocketLogout()
  applyAuthState({ ...LOGGED_OUT })
}

/**
 * 验证登录是否有效：主进程真实请求 token 校验与 IM 凭据两个需登录接口，
 * 返回资料与 IM 链路可用性；valid=false 时 message 里带原因。
 */
export function verifyPocketLogin(): Promise<PocketVerifyResult> {
  return window.mainAPI.pocketVerifyLogin()
}

/** 统一错误提示（登录弹窗内用 ElMessage 即可，这里收口文案） */
export function pocketAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || '操作失败，请稍后重试'
}

/** 登录成功提示（nickname 可能缺失，兜底手机号/通用文案） */
export function notifyLoginSuccess(state: PocketAuthState): void {
  ElMessage.success(state.nickname ? `欢迎，${state.nickname}` : '口袋48账号登录成功')
}
