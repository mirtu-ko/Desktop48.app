import type { PocketClientProfileId } from '@common/pocket-client-profile'
/**
 * 口袋48请求底座：凭证状态、客户端身份头、HTTP 请求与登录态读接口。
 *
 * 这是 pocket48 主进程请求链路的公共底座，业务模块（登录会话 / 房间 / 关注 / IM 凭据）
 * 都建立在它之上，它不反向依赖任何业务模块：
 *
 * - 凭证：token 经 safeStorage 异步加密后落盘 userData/pocket48-auth.json；平台无加密能力
 *   （部分 Linux 无钥匙环）时降级明文并打 plainFallback 标记。由 auth-credentials.ts 收敛为
 *   单一内存状态源：启动解密一次，之后业务侧同步读取。token 有效期由服务端掌控
 *   （被踢 / 长期未用会失效），本模块不自动重登。
 * - 请求：主进程直连 pocketapi.48.cn（不经渲染层 netRequest），按客户端档位补头、pa 每次现算；
 *   失效状态码统一经 throwAuthExpired 清凭证并广播。
 * - 客户端档位：口袋48 / 塞纳河48（见 common/pocket-client-profile.ts 与 client-profile.ts）。
 *   两档协议等价、只有客户端特征不同，服务端因此把同一账号的多个客户端会话分开——
 *   手机端在用口袋48 时，桌面选塞纳河48 即可两端并存。档位随凭证落盘，切换档位需重新登录。
 *
 * 对外入口统一是 `./pocket-auth`（barrel），消费方不要直接引用本文件。
 */
import type { StoredAuth } from './auth-credentials'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePocketClientProfile } from '@common/pocket-client-profile'
import { app, net, safeStorage } from 'electron'
import { debug, log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import { AuthCredentialStore, TokenTemporarilyUnavailableError } from './auth-credentials'
import { clientHeaders, profileFor } from './client-profile'
import { currentPa, ensurePaWasm } from './pa-sign'

// ===== 凭证状态：唯一状态源，业务侧只读内存快照 =====

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'pocket48-auth.json')
}

let authFile: SafeJSONFileSync<StoredAuth> | null = null

function authStore(): SafeJSONFileSync<StoredAuth> {
  authFile ??= new SafeJSONFileSync<StoredAuth>(authFilePath())
  return authFile
}

/**
 * 凭证内存状态源：单例，全 pocket48 请求链共用（session / im 模块复用它，不要再 new 第二个）。
 *
 * safeStorage 只走异步 API（同步版在 Electron 46 已移除）。旧版同步 API 加密的
 * tokenEnc 可由 decryptStringAsync 解开，升级后无需重新登录；反向不保证兼容。
 */
export const credentials = new AuthCredentialStore(
  {
    async isEncryptionAvailable() {
      return safeStorage.isAsyncEncryptionAvailable()
    },
    async encrypt(token) {
      return (await safeStorage.encryptStringAsync(token)).toString('base64')
    },
    async decrypt(encoded) {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'))
        return { token: result, shouldReEncrypt }
      }
      catch (error) {
        if (error instanceof Error && /temporarily unavailable/i.test(error.message))
          throw new TokenTemporarilyUnavailableError(error.message)
        throw error
      }
    },
  },
  {
    read: () => authStore().read(),
    write: auth => authStore().write(auth),
    remove: () => {
      const file = authFilePath()
      try {
        if (fs.existsSync(file))
          fs.unlinkSync(file)
      }
      catch (error) {
        log('[pocket-auth] 删除凭证失败', error)
      }
    },
  },
  (message, error) => {
    if (error === undefined)
      log(message)
    else
      log(message, error)
  },
  token => debug('[pocket-auth] 解密后的 token：', token),
)

/** app.whenReady 之后预热：异步加密器就绪后才能解密，业务侧在此之前的读取一律视为未登录 */
export function ensureAuthLoaded(): Promise<void> {
  return credentials.load()
}

// ===== 接口常量：统一在 common/pocket-api-urls.ts（与渲染层同源），见文件头 import =====

export const REQUEST_TIMEOUT_MS = 20 * 1000

/**
 * `pa` 请求头兜底静态值：正常由官方 Android APK 抽出的 wasm 现算（见 pa-sign.ts），
 * 仅 wasm 加载/生成失败时使用（2021 年签名，实测服务端不拦请求）。
 * 主 App HTTP 头也统一为 Android 档（与 pa 同源）；v2 登录端点已对齐 7.1.44 APK。
 */
export const POCKET_PA = 'MTYzNjAxNzMxNTAwMCw3NjkyNzVkNTliZWU0MmQ0OGVjOWIyYTMwY2FkOWQzOSw3NzFhY2QwY2JiZDhkZDUzZDdjZGY3YTcxNGYzNmVlOCwyMDIxMDYwOTAx'

/** token 失效的服务端状态码（与 pocket48_api 社区实现一致） */
export const TOKEN_INVALID_STATUSES = new Set([401003, 401004, 401005])

/**
 * 登录态变更（登出 / 失效）时要清掉的模块级缓存登记表。
 *
 * 频道名缓存、发言权限缓存、发言者资料快照都按登录会话存在，换号后必须失效；
 * 但它们的实现分属 pocket-room-api / pocket-im，core 不认识这些模块。
 * 各业务模块在加载时把自己的清理函数登记进来，core 在登出/失效时统一执行，避免反向依赖。
 */
const sessionResetHooks: Array<() => void> = []

/** 登记一个「登录态变更时清空本模块缓存」的回调（由业务模块在模块顶层调用一次） */
export function onSessionReset(reset: () => void): void {
  sessionResetHooks.push(reset)
}

/** 执行全部会话缓存清理：登出与 token 失效共用 */
function resetSessionCaches(): void {
  for (const reset of sessionResetHooks) {
    try {
      reset()
    }
    catch (error) {
      // 单个模块清理失败不能阻断其余清理，更不能阻断凭证作废
      log('[pocket-auth] 会话缓存清理失败', error)
    }
  }
}

/**
 * 凭证失效广播钩子：IPC 层注入广播函数（见 register-pocket-ipc.ts），默认空实现便于单测直跑。
 * 失效即广播，各窗口登录态镜像同步复位。
 */
let notifyAuthExpired: () => void = () => {}
export function setAuthExpiredNotifier(notify: () => void): void {
  notifyAuthExpired = notify
}

/**
 * v2 信封：v2 登录域的 HttpData 只有 status/message/content，不一定带 success。
 * status=200 即成功；保留 success 的旧接口也用同一判断（显式 false 才视为失败）。
 */
export function isEnvelopeOk(envelope: PocketEnvelope<unknown>): boolean {
  return envelope.status === 200 && envelope.success !== false
}

/** 对渲染层暴露的登录态（不含 token 本体） */
export interface PocketAuthState {
  loggedIn: boolean
  nickname: string
  avatar: string
  /** 口袋 userId（登录时落盘）；房间页据此判定「自己发的消息」 */
  userId: string
  /** 脱敏手机号（139****1234）；非中国大陆区号登录时带 `+区号 ` 前缀；空串表示未记住 */
  mobileMasked: string
  /** 当前登录身份档位（模拟的官方客户端）；未登录 / 旧凭证时为默认档口袋48 */
  clientProfile: PocketClientProfileId
  /** true = 平台无 safeStorage，token 以明文落盘（仅提示用） */
  plainFallback: boolean
  /** 凭证保存时间（ms 时间戳）；0 = 无记录，供设置页展示「已保存 N 天」 */
  savedAt: number
}

/** 发送验证码结果：needCaptcha=true 时携带问答题 */
export interface PocketSmsResult {
  needCaptcha: boolean
  question: string
  options: string[]
  message: string
}

export interface PocketUserInfo {
  nickname: string
  avatar: string
  userId: string
}

export interface PocketEnvelope<T = unknown> {
  status?: number
  success?: boolean
  message?: string
  content?: T
}

/** 日志用：接口地址只保留 pathname，避免把 query 里的参数带进日志 */
export function logPath(url: string): string {
  try {
    return new URL(url).pathname
  }
  catch {
    return url
  }
}

/** 日志用：非 JSON 回包截断，防止日志被整页 HTML / 超长正文淹没 */
export function clipForLog(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text
}

/** 日志用：信封摘要只保留状态、message 与 content 字段名，避免 token 等敏感值落日志 */
export function summarizeEnvelope(envelope: PocketEnvelope<unknown> | null | undefined): string {
  const content = envelope?.content
  const contentSummary = content && typeof content === 'object' && !Array.isArray(content)
    ? Object.keys(content as Record<string, unknown>)
    : typeof content
  return JSON.stringify({
    status: envelope?.status,
    success: envelope?.success,
    message: typeof envelope?.message === 'string' ? clipForLog(envelope.message) : envelope?.message,
    content: contentSummary,
  })
}

// ===== 客户端身份 =====

/**
 * 当前请求所用的客户端档位：读凭证内存快照（未登录 / 旧凭证回退默认档）。
 * 与 getToken 同用一个状态源，登录与退出都不需要额外的缓存失效逻辑。
 *
 * 导出供聊天室取同档云信身份（`pocket-danmaku.ts`），保证 HTTP 与 TCP 报同一家客户端。
 */
export function currentClientProfile(): PocketClientProfileId {
  return resolvePocketClientProfile(credentials.getStored()?.clientProfile)
}

/**
 * 组装请求头：按「本次指定档位 或 当前档位」取客户端特征，只补 `pa` 与 `token`。
 * 登录链路在凭证写入前就用用户选定的档发请求，故显式传入 profileId；
 * 其余接口省略该参数，走凭证里的当前档位。
 */
export function pocketHeaders(token?: string, pa?: string, profileId?: PocketClientProfileId): Record<string, string> {
  const headers = clientHeaders(profileFor(profileId ?? currentClientProfile()))
  headers.pa = pa ?? POCKET_PA
  if (token)
    headers.token = token
  return headers
}

/**
 * 按当前档位生成 App 身份头（含 pa；withToken 时再带登录 token），与业务请求同一口径
 * （UA / appInfo / pa / token 全部同源）。
 *
 * 两个调用方：
 * 1. `main/ipc/register-system-ipc.ts` 的 `netRequest`——渲染层打 pocketapi 的读接口
 *    （直播 / 回放列表、直播详情）由它补头。服务端按客户端身份判定，站点身份（浏览器 UA、
 *    无 appInfo/pa）在境外线路直接 403（2026-10-17 实测），故必须换成 App 身份。
 * 2. `main/net/net-diagnose.ts` 的身份对照行——同一出口下换身份重探，差异即判定维度。
 *
 * 读接口不带 token 即可（实测 App 身份 200），故默认不发登录凭证；
 * 这些头只用于发请求，不会随诊断结果或 IPC 回传渲染层。
 */
export async function pocketAppHeaders(withToken = false): Promise<Record<string, string>> {
  await ensurePaWasm()
  return pocketHeaders(withToken ? getToken() || undefined : undefined, currentPa(POCKET_PA))
}

/** 主进程直连 pocketapi：POST JSON 并解析信封。网络层异常抛 Error，业务错误原样返回信封 */
export async function postPocket<T>(
  url: string,
  data: object,
  token?: string,
  extraHeaders?: Record<string, string>,
  profileId?: PocketClientProfileId,
): Promise<PocketEnvelope<T>> {
  // pa 每次请求现算（内嵌当下时间戳）；wasm 加载失败时退回静态值，不影响请求发出
  await ensurePaWasm()
  const pa = currentPa(POCKET_PA)
  const startedAt = performance.now()
  const apiPath = logPath(url)
  return new Promise<PocketEnvelope<T>>((resolve, reject) => {
    const request = net.request({ url, method: 'POST' })
    const headers = { ...pocketHeaders(token, pa, profileId), ...extraHeaders }
    for (const [key, value] of Object.entries(headers))
      request.setHeader(key, value)

    let settled = false
    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      request.abort()
      debug(`[pocket-auth] ✕ POST ${apiPath} 超时 ${REQUEST_TIMEOUT_MS}ms`)
      reject(new Error('请求超时，请检查网络'))
    }, REQUEST_TIMEOUT_MS)

    const fail = (err: Error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      debug(`[pocket-auth] ✕ POST ${apiPath} 网络错误 ${(performance.now() - startedAt).toFixed(1)}ms:`, err)
      reject(err)
    }

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        const status = response.statusCode
        const body = Buffer.concat(chunks).toString('utf8')
        if (status < 200 || status >= 300) {
          debug(`[pocket-auth] ✕ POST ${apiPath} HTTP ${status} ${(performance.now() - startedAt).toFixed(1)}ms:`, clipForLog(body))
          reject(new Error(`接口异常（HTTP ${status}）`))
          return
        }
        try {
          const envelope = JSON.parse(body) as PocketEnvelope<T>
          // debug(`[pocket-auth] ← POST ${apiPath} HTTP ${status} ${(performance.now() - startedAt).toFixed(1)}ms`, summarizeEnvelope(envelope))
          resolve(envelope)
        }
        catch {
          debug(`[pocket-auth] ✕ POST ${apiPath} HTTP ${status} 返回非 JSON ${(performance.now() - startedAt).toFixed(1)}ms:`, clipForLog(body))
          reject(new Error('接口返回数据异常'))
        }
      })
      response.on('error', fail)
    })
    request.on('error', fail)
    request.write(JSON.stringify(data))
    request.end()
  })
}

/** 区号统一去掉可能的 + 前缀；缺省或空串（如误传单个 '+'）仍按中国大陆处理 */
export function normalizeArea(area?: string): string {
  return (area || '86').replace(/^\+/, '') || '86'
}

/**
 * 脱敏手机号（139****1234）。非 86 区号加 `+区号 ` 前缀——区号是归属地信息，
 * 无脱敏必要；海外号码 4-15 位不定长，头尾各留 2 位（短于 5 位时头尾重叠，脱敏无意义）。
 */
export function maskMobile(mobile: string, area?: string): string {
  const normalized = normalizeArea(area)
  if (normalized !== '86') {
    if (mobile.length < 5)
      return ''
    return `+${normalized} ${mobile.slice(0, 2)}****${mobile.slice(-2)}`
  }
  if (mobile.length < 7)
    return ''
  return `${mobile.slice(0, 3)}****${mobile.slice(-4)}`
}

/** 凭证快照 → 对渲染层暴露的登录态（不含 token 本体） */
export function toAuthState(stored: StoredAuth | null): PocketAuthState {
  return {
    loggedIn: !!credentials.getToken(),
    nickname: stored?.nickname || '',
    avatar: stored?.avatar || '',
    userId: stored?.userId || '',
    mobileMasked: maskMobile(stored?.mobile || '', stored?.area),
    clientProfile: resolvePocketClientProfile(stored?.clientProfile),
    // 只看凭证本体：明文 token 一旦落盘就是明文，与「此刻系统有没有加密能力」无关
    plainFallback: !!stored?.tokenPlain,
    savedAt: stored?.savedAt || 0,
  }
}

// ===== 对外：登录态 =====

/** 当前登录态（读内存凭证，不发起网络校验；token 是否真有效由调用方用时才知道） */
export function getAuthState(): PocketAuthState {
  return toAuthState(credentials.getStored())
}

/** 取 token 供 IM 凭据等已登录链路使用；未登录返回空串 */
export function getToken(): string {
  return credentials.getToken()
}

/** 落盘凭证：档位一并写入，此后所有请求按该档发头（档位随凭证读） */
export async function saveAuth(
  mobile: string,
  token: string,
  info: PocketUserInfo,
  area: string,
  clientProfile: PocketClientProfileId,
): Promise<void> {
  const encrypted = await credentials.save({
    mobile,
    area,
    clientProfile,
    nickname: info.nickname,
    avatar: info.avatar,
    userId: info.userId,
    savedAt: Date.now(),
  }, token)
  log(`[pocket-auth] 凭证已保存（${encrypted ? '加密' : '明文降级'}，档位 ${clientProfile}），用户: ${info.nickname || '未知'}`)
}

/** 退出登录：删除本地凭证文件（档位随凭证消失，请求头回到默认档；下次登录重新选） */
export function logout(): void {
  credentials.clear()
  resetSessionCaches()
  log('[pocket-auth] 已退出登录')
}

/** 「登录已过期」唯一出口：先清凭证再抛（各业务模块共用） */
export function throwAuthExpired(): never {
  expireStoredAuth()
  throw new Error('登录已过期，请重新登录口袋48账号')
}

/** token 判失效：删凭证文件（过期无恢复手段，重登必然覆盖）+ 广播各窗复位镜像 */
export function expireStoredAuth(): void {
  credentials.clear()
  resetSessionCaches()
  log('[pocket-auth] token 已失效，本地凭证已清除')
  notifyAuthExpired()
}
