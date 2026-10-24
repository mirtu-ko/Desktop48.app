/**
 * 口袋48账号登录与凭证存储。
 *
 * 登录链路（均为主进程直连 pocketapi.48.cn，不经渲染层 netRequest）：
 * 1. 短信验证码：v2 sms/send_sms 发送 → v2 login/app/app_login 换 token（实测成功）。
 *    服务端偶发返回 status 2001 反爬问答题（message 内嵌 JSON），需把题目透传给用户作答。
 * 2. Token 粘贴：user/info/reload 校验 token 并取回用户资料。
 *
 * 客户端档位：登录时用户选定模拟哪个官方客户端（口袋48 / 塞纳河48，见
 * `common/pocket-client-profile.ts`），档位随凭证落盘，此后本模块所有请求按该档发头
 * （特征表见 client-profile.ts 的 POCKET_CLIENT_PROFILES）。两个档协议等价、只有客户端
 * 特征不同，服务端因此把同一账号的多个客户端会话分开——手机端在用口袋48 时，桌面选
 * 塞纳河48 即可两端并存。档位即「当前登录身份」，切换档位需重新登录。
 *
 * 凭证保存：token 经 safeStorage 加密后落盘 userData/pocket48-auth.json；
 * 平台无加密能力（部分 Linux 无钥匙环）时降级明文并打 plainFallback 标记。
 * token 有效期由服务端掌控（被踢/长期未用会失效），使用时才暴露给调用方，
 * 调用方收到 401005 等失效状态码时引导用户重新登录，本模块不自动重登。
 */
import type { PocketClientProfileId } from '@common/pocket-client-profile'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHECKIN_URL,
  FRIEND_ADD_URL,
  FRIEND_REMOVE_URL,
  FRIENDS_IDS_URL,
  IM_USER_INFO_URL,
  LIVE_ONE_URL,
  LIVE_RESULT_URL,
  ROOM_ANSWER_VERIFY_URL,
  ROOM_ESSENCE_MESSAGE_URL,
  ROOM_INFO_URL,
  ROOM_LAST_MESSAGE_URL,
  ROOM_MESSAGE_URLS,
  ROOM_MSG_DELETE_URL,
  SEINE_SERVER_DETAIL_URL,
  SERVER_JUMP_URL,
  SMS_LOGIN_URL,
  SMS_SEND_URL,
  TOKEN_CHECK_URL,
  USER_MONEY_URL,
} from '@common/pocket-api-urls'
import { resolvePocketClientProfile } from '@common/pocket-client-profile'
import { toApiId } from '@common/pocket-ids'
import { ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'
import { app, net, safeStorage } from 'electron'
import { debug, log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import { clientHeaders, profileFor } from './client-profile'
import { currentPa, ensurePaWasm } from './pa-sign'

// ===== 接口常量：统一在 common/pocket-api-urls.ts（与渲染层同源），见文件头 import =====

const REQUEST_TIMEOUT_MS = 20 * 1000

/**
 * `pa` 请求头兜底静态值：正常由官方 Android APK 抽出的 wasm 现算（见 pa-sign.ts），
 * 仅 wasm 加载/生成失败时使用（2021 年签名，实测服务端不拦请求）。
 * 主 App HTTP 头也统一为 Android 档（与 pa 同源）；v2 登录端点已对齐 7.1.44 APK。
 */
const POCKET_PA = 'MTYzNjAxNzMxNTAwMCw3NjkyNzVkNTliZWU0MmQ0OGVjOWIyYTMwY2FkOWQzOSw3NzFhY2QwY2JiZDhkZDUzZDdjZGY3YTcxNGYzNmVlOCwyMDIxMDYwOTAx'

/** token 失效的服务端状态码（与 pocket48_api 社区实现一致） */
const TOKEN_INVALID_STATUSES = new Set([401003, 401004, 401005])

/**
 * 频道列表短缓存：渲染层取频道名与主进程枚举小房间用的是同一个 server/detail，
 * 选中成员时两边会各打一次。60s 足够覆盖这一次交互，又不会被房主新建频道挡住。
 */
const SERVER_CHANNEL_TTL = 60 * 1000
const serverChannelCache = new Map<string, { list: PocketServerChannel[], at: number }>()

/**
 * 房间发言权限短缓存：进房预热（主进程按 cdTime 限流）与渲染层输入框提示各要一次，
 * 同一次进房会把同一个 room/info 打两遍。30s 足够合并这一次，又不会让「刚被禁言」
 * 晚太久才反映到输入框上（真发出去服务端仍会拒绝兜底）。
 */
const ROOM_PERMISSION_TTL = 30 * 1000
const roomPermissionCache = new Map<string, { value: PocketRoomPermission | null, at: number }>()
const roomPermissionInflight = new Map<string, Promise<PocketRoomPermission | null>>()

/**
 * 凭证失效广播钩子：IPC 层注入广播函数（见 register-pocket-ipc.ts），默认空实现便于单测直跑。
 * 失效即广播，各窗口登录态镜像同步复位。
 */
let notifyAuthExpired: () => void = () => {}
export function setAuthExpiredNotifier(notify: () => void): void {
  notifyAuthExpired = notify
}

/** 反爬问答题状态码：message 字段为内嵌 JSON（{question, answer:[...]}) */
const CAPTCHA_STATUS = 2001

/**
 * v2 信封：v2 登录域的 HttpData 只有 status/message/content，不一定带 success。
 * status=200 即成功；保留 success 的旧接口也用同一判断（显式 false 才视为失败）。
 */
function isEnvelopeOk(envelope: PocketEnvelope<unknown>): boolean {
  return envelope.status === 200 && envelope.success !== false
}

// ===== 持久化结构 =====

interface StoredAuth {
  /** 记住手机号（下次打开弹窗预填；明文，手机号本身不算机密） */
  mobile: string
  /** 登录时使用的区号（如 '852'）；旧版本无此字段，读取时按 86 处理 */
  area?: string
  /** 登录时选定的客户端档位；旧版本无此字段，读取时按口袋48 处理 */
  clientProfile?: PocketClientProfileId
  /** safeStorage 加密后的 token（base64）；plainFallback 时为空 */
  tokenEnc: string
  /** safeStorage 不可用时的降级明文 token；有 tokenEnc 时恒为空 */
  tokenPlain: string
  nickname: string
  avatar: string
  userId: string
  savedAt: number
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

// ===== 底层请求 =====

interface PocketEnvelope<T = unknown> {
  status?: number
  success?: boolean
  message?: string
  content?: T
}

/** 日志用：接口地址只保留 pathname，避免把 query 里的参数带进日志 */
function logPath(url: string): string {
  try {
    return new URL(url).pathname
  }
  catch {
    return url
  }
}

/** 日志用：非 JSON 回包截断，防止日志被整页 HTML / 超长正文淹没 */
function clipForLog(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text
}

/** 日志用：信封摘要只保留状态、message 与 content 字段名，避免 token 等敏感值落日志 */
function summarizeEnvelope(envelope: PocketEnvelope<unknown> | null | undefined): string {
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

/**
 * 当前请求所用的客户端档位：读凭证（未登录 / 旧凭证回退默认档）。
 * 与 getToken 同口径——每次请求读一次凭证（读盘代价可忽略），故登录与退出都不需要
 * 额外的缓存失效逻辑。同一请求内多次取值也不会读到不一致的状态。
 *
 * 导出供聊天室取同档云信身份（`pocket-danmaku.ts`），保证 HTTP 与 TCP 报同一家客户端。
 */
export function currentClientProfile(): PocketClientProfileId {
  return resolvePocketClientProfile(readStoredAuth()?.clientProfile)
}

/**
 * 组装请求头：按「本次指定档位 或 当前档位」取客户端特征，只补 `pa` 与 `token`。
 * 登录链路在凭证写入前就用用户选定的档发请求，故显式传入 profileId；
 * 其余接口省略该参数，走凭证里的当前档位。
 */
function pocketHeaders(token?: string, pa?: string, profileId?: PocketClientProfileId): Record<string, string> {
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
 * 2. `main/net-diagnose.ts` 的身份对照行——同一出口下换身份重探，差异即判定维度。
 *
 * 读接口不带 token 即可（实测 App 身份 200），故默认不发登录凭证；
 * 这些头只用于发请求，不会随诊断结果或 IPC 回传渲染层。
 */
export async function pocketAppHeaders(withToken = false): Promise<Record<string, string>> {
  await ensurePaWasm()
  return pocketHeaders(withToken ? getToken() || undefined : undefined, currentPa(POCKET_PA))
}

/** 主进程直连 pocketapi：POST JSON 并解析信封。网络层异常抛 Error，业务错误原样返回信封 */
async function postPocket<T>(
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

// ===== 凭证文件 =====

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'pocket48-auth.json')
}

let store: SafeJSONFileSync<StoredAuth> | null = null

function authStore(): SafeJSONFileSync<StoredAuth> {
  if (!store)
    store = new SafeJSONFileSync<StoredAuth>(authFilePath())
  return store
}

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  }
  catch {
    return false
  }
}

function readStoredAuth(): StoredAuth | null {
  return authStore().read()
}

function saveStoredAuth(auth: StoredAuth): void {
  authStore().write(auth)
}

/** 解出可用 token；加密解密失败（如更换系统用户）视为未保存，返回空串 */
function extractToken(stored: StoredAuth | null): string {
  if (!stored)
    return ''
  let token: string
  if (stored.tokenEnc) {
    try {
      token = safeStorage.decryptString(Buffer.from(stored.tokenEnc, 'base64'))
    }
    catch (error) {
      log('[pocket-auth] token 解密失败，按未登录处理', error)
      return ''
    }
  }
  else {
    token = stored.tokenPlain || ''
  }
  // 仅开发环境打印 token，生产环境不落日志（token 本身是机密）
  debug('[pocket-auth] 解密后的 token：', token)
  return token
}

/**
 * 脱敏手机号（139****1234）。非 86 区号加 `+区号 ` 前缀——区号是归属地信息，
 * 无脱敏必要；海外号码 4-15 位不定长，头尾各留 2 位（短于 5 位时头尾重叠，脱敏无意义）。
 */
function maskMobile(mobile: string, area?: string): string {
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

function toAuthState(stored: StoredAuth | null): PocketAuthState {
  const token = extractToken(stored)
  return {
    loggedIn: !!token,
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

// ===== 对外能力 =====

/** 当前登录态（读本地凭证，不发起网络校验；token 是否真有效由调用方用时才知道） */
export function getAuthState(): PocketAuthState {
  return toAuthState(readStoredAuth())
}

/** 取 token 供 IM 凭据等已登录链路使用；未登录返回空串 */
export function getToken(): string {
  return extractToken(readStoredAuth())
}

/** 区号统一去掉可能的 + 前缀；缺省或空串（如误传单个 '+'）仍按中国大陆处理 */
function normalizeArea(area?: string): string {
  return (area || '86').replace(/^\+/, '') || '86'
}

/** 手机号本地校验：中国大陆仍固定 11 位，其他区号放宽到 4-15 位数字 */
function isValidMobile(mobile: string, area: string): boolean {
  return area === '86' ? /^\d{11}$/.test(mobile) : /^\d{4,15}$/.test(mobile)
}

/**
 * 发送登录验证码。
 * 正常返回 needCaptcha=false；命中反爬问答题（2001）时返回题目与选项，
 * 用户作答后把 answer 随下一次发送一并提交。
 * clientProfile 为本次登录选定的身份档位（凭证写入前就按它发请求）；省略时用当前档位。
 */
export async function sendSms(
  mobile: string,
  area?: string,
  answer?: string,
  clientProfile?: PocketClientProfileId,
): Promise<PocketSmsResult> {
  const normalizedArea = normalizeArea(area)
  const trimmed = mobile.trim()
  if (!isValidMobile(trimmed, normalizedArea))
    throw new Error(normalizedArea === '86' ? '请输入 11 位手机号' : '请输入有效的手机号')
  const profile = clientProfile ?? currentClientProfile()
  // 7.1.44 APK：无答题时带业务码（登录注册=1）与空风控 token；有答题时只带 answer。
  const payload: Record<string, unknown> = answer
    ? { mobile: trimmed, area: normalizedArea, answer }
    : {
        mobile: trimmed,
        area: normalizedArea,
        businessCode: 1,
        intelligenceToken: '',
      }
  debug('[pocket-auth] → 发送验证码：', JSON.stringify({
    profile,
    mobile: maskMobile(trimmed, normalizedArea) || '***',
    hasCaptchaAnswer: !!answer,
  }))
  const envelope = await postPocket(SMS_SEND_URL, payload, undefined, undefined, profile)
  debug('[pocket-auth] ← 发送验证码：', summarizeEnvelope(envelope))
  if (envelope.status === CAPTCHA_STATUS) {
    // message 内嵌 JSON：{question: string, answer: string[]}
    let question = ''
    let options: string[] = []
    try {
      const parsed = JSON.parse(envelope.message || '{}') as { question?: string, answer?: string[] }
      question = parsed.question || ''
      options = Array.isArray(parsed.answer) ? parsed.answer : []
    }
    catch {
      question = envelope.message || ''
    }
    debug('[pocket-auth] 发送验证码命中反爬问答题：', JSON.stringify({
      question,
      optionCount: options.length,
    }))
    return { needCaptcha: true, question, options, message: '需要完成验证' }
  }
  if (isEnvelopeOk(envelope))
    return { needCaptcha: false, question: '', options: [], message: '验证码已发送' }
  throw new Error(envelope.message || '验证码发送失败')
}

/** 从登录响应/资料接口中提取展示用信息（字段名服务端不同接口不统一，逐个兜底） */
function pickUserInfo(content: Record<string, unknown> | undefined | null): PocketUserInfo {
  const c = (content || {}) as Record<string, unknown>
  const user = (c.userInfo || c.user || c) as Record<string, unknown>
  return {
    nickname: String(user.nickname || user.nickName || user.userName || ''),
    avatar: String(user.avatar || user.userAvatar || ''),
    userId: String(user.userId || user.id || ''),
  }
}

/**
 * 验证码登录：成功后落盘凭证（含身份档位）并返回登录态。
 * clientProfile 为本轮登录选定的身份档位，随凭证保存并成为此后所有请求的档位。
 */
export async function loginByCode(
  mobile: string,
  code: string,
  area?: string,
  clientProfile?: PocketClientProfileId,
): Promise<PocketAuthState> {
  const normalizedArea = normalizeArea(area)
  const trimmedMobile = mobile.trim()
  const trimmedCode = code.trim()
  if (!isValidMobile(trimmedMobile, normalizedArea))
    throw new Error(normalizedArea === '86' ? '请输入 11 位手机号' : '请输入有效的手机号')
  if (!trimmedCode)
    throw new Error('请输入验证码')
  const profile = clientProfile ?? currentClientProfile()
  debug('[pocket-auth] → 验证码登录：', JSON.stringify({
    profile,
    mobile: maskMobile(trimmedMobile, normalizedArea) || '***',
    codeLength: trimmedCode.length,
  }))
  // 7.1.44 APK：mobileCodeLogin setter 还会补 loginType=MOBILE_SMS_CODE；deviceToken 允许空串。
  const envelope = await postPocket<{ token?: string }>(SMS_LOGIN_URL, {
    mobileCodeLogin: {
      mobile: trimmedMobile,
      code: trimmedCode,
      area: normalizedArea,
    },
    loginType: 'MOBILE_SMS_CODE',
    deviceToken: '',
  }, undefined, undefined, profile)
  const token = envelope.content?.token
  if (!isEnvelopeOk(envelope) || !token) {
    debug('[pocket-auth] ✕ 验证码登录失败：', JSON.stringify({
      status: envelope.status,
      success: envelope.success,
      message: envelope.message || null,
      hasToken: !!token,
      shownToUser: envelope.message || '验证码错误或已过期',
    }))
    throw new Error(envelope.message || '验证码错误或已过期')
  }
  // 登录响应的 content 里未必带资料，再校验一次顺手取昵称头像（失败不阻断，资料只是展示用）
  let info: PocketUserInfo = { nickname: '', avatar: '', userId: '' }
  try {
    const check = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token, undefined, profile)
    if (check.success)
      info = pickUserInfo(check.content)
  }
  catch (error) {
    log('[pocket-auth] 登录后拉取资料失败（不阻断登录）', error)
  }
  saveAuth(trimmedMobile, token, info, normalizedArea, profile)
  return getAuthState()
}

/** Token 粘贴登录：user/info/reload 校验有效后落盘（档位同验证码登录，随凭证保存） */
export async function loginByToken(
  token: string,
  mobile = '',
  clientProfile?: PocketClientProfileId,
): Promise<PocketAuthState> {
  const trimmed = token.trim()
  if (!trimmed)
    throw new Error('请输入 token')
  const profile = clientProfile ?? currentClientProfile()
  debug('[pocket-auth] → token 登录：', JSON.stringify({
    profile,
    mobile: maskMobile(mobile.trim()) || '***',
    tokenLength: trimmed.length,
  }))
  const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, trimmed, undefined, profile)
  if (!envelope.success) {
    const invalid = envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status)
    debug('[pocket-auth] ✕ token 登录失败：', JSON.stringify({
      status: envelope.status,
      success: envelope.success,
      message: envelope.message || null,
      invalid,
    }))
    throw new Error(invalid ? 'token 无效或已过期' : envelope.message || 'token 校验失败')
  }
  const info = pickUserInfo(envelope.content)
  // token 登录的手机号由用户手填、无区号语义（该链路不校验手机号），按 86 存档只为展示不带前缀
  saveAuth(mobile.trim(), trimmed, info, '86', profile)
  return getAuthState()
}

/** 落盘凭证：档位一并写入，此后所有请求按该档发头（档位随凭证读） */
function saveAuth(
  mobile: string,
  token: string,
  info: PocketUserInfo,
  area: string,
  clientProfile: PocketClientProfileId,
): void {
  const encrypted = safeStorageAvailable()
  saveStoredAuth({
    mobile,
    area,
    clientProfile,
    tokenEnc: encrypted ? safeStorage.encryptString(token).toString('base64') : '',
    tokenPlain: encrypted ? '' : token,
    nickname: info.nickname,
    avatar: info.avatar,
    userId: info.userId,
    savedAt: Date.now(),
  })
  log(`[pocket-auth] 凭证已保存（${encrypted ? '加密' : '明文降级'}，档位 ${clientProfile}），用户: ${info.nickname || '未知'}`)
}

/** 删除本地凭证文件；存在才删，失败不抛（删除只影响展示，调用方各有兵底） */
function deleteStoredCredentials(): void {
  const file = authFilePath()
  try {
    if (fs.existsSync(file))
      fs.unlinkSync(file)
  }
  catch (error) {
    log('[pocket-auth] 删除凭证失败', error)
  }
}

/** 退出登录：删除本地凭证文件（档位随凭证消失，请求头回到默认档；下次登录重新选） */
export function logout(): void {
  deleteStoredCredentials()
  serverChannelCache.clear()
  roomPermissionCache.clear()
  roomPermissionInflight.clear()
  resetRoomSenderProfile()
  log('[pocket-auth] 已退出登录')
}

/** token 判失效：删凭证文件（过期无恢复手段，重登必然覆盖）+ 广播各窗复位镜像 */
export function expireStoredAuth(): void {
  deleteStoredCredentials()
  serverChannelCache.clear()
  roomPermissionCache.clear()
  roomPermissionInflight.clear()
  resetRoomSenderProfile()
  log('[pocket-auth] token 已失效，本地凭证已清除')
  notifyAuthExpired()
}

/** 「登录已过期」唯一出口：先清凭证再抛 */
function throwAuthExpired(): never {
  expireStoredAuth()
  throw new Error('登录已过期，请重新登录口袋48账号')
}

/** 登录有效性验证结果：imOk 表示弹幕实际依赖的 IM 凭据链路是否可用 */
export interface PocketVerifyResult {
  valid: boolean
  nickname: string
  userId: string
  level: string
  imOk: boolean
  imAccid: string
  /** 鸡腿余额；moneyOk=false 时三个余额无意义（接口失败不影响登录态判定） */
  moneyOk: boolean
  moneyPay: number
  moneyFree: number
  moneyTotal: number
  /** 鸡翅数量（成长值）；user/info/reload 的 support 字段 */
  support: string
  /** 社交资料：服务端不返回的字段为空串，UI 据此隐藏对应条目 */
  fans: string
  likes: string
  signature: string
  message: string
}

/** 每日签到奖励；服务端字段缺失或非法时按 0 处理 */
export interface PocketCheckInResult {
  addExp: number
  addMoney: number
  addSupport: number
  days: number
}

/** 社交资料提取：服务端不同接口字段名不统一，逐个兜底；缺失返回空串 */
function pickSocialStats(user: Record<string, unknown>): { fans: string, likes: string, signature: string } {
  const num = (...keys: string[]): string => {
    for (const key of keys) {
      const value = user[key]
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value)
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
        return value.trim()
    }
    return ''
  }
  const text = (...keys: string[]): string => {
    for (const key of keys) {
      const value = user[key]
      if (typeof value === 'string' && value.trim())
        return value.trim()
    }
    return ''
  }
  return {
    fans: num('fansNum', 'fansTimes', 'fans', 'follower'),
    likes: num('likeCount', 'bePraisedTimes', 'praisedTimes', 'likesNum'),
    signature: text('signature', 'autograph', 'introduce', 'description'),
  }
}

/** 钱包余额（元）：字段缺失按 0 计；moneyTotal 缺失时用付费 + 免费兜底 */
function pickMoney(content: Record<string, unknown> | undefined | null): { moneyPay: number, moneyFree: number, moneyTotal: number } {
  const c = (content || {}) as Record<string, unknown>
  const num = (key: string): number => {
    const value = c[key]
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  const moneyPay = num('moneyPay')
  const moneyFree = num('moneyFree')
  return { moneyPay, moneyFree, moneyTotal: num('moneyTotal') || moneyPay + moneyFree }
}

/** 读取非负数字段；服务端可能以 number 或数字字符串返回 */
function pickNonNegativeNumber(content: Record<string, unknown>, key: string): number {
  const value = content[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * 验证登录是否有效：真实请求需要登录的接口——
 * 1. user/info/reload（token 校验 + 资料 + 社交数据）；2. im/userinfo（弹幕聊天室凭据链路）；
 * 3. user/money（口袋钱包，失败不影响登录态判定）。
 * 前者失败即登录失效；后两者失败只降级对应展示，登录态本身仍有效。
 */
export async function verifyLogin(): Promise<PocketVerifyResult> {
  const empty: PocketVerifyResult = {
    valid: false,
    nickname: '',
    userId: '',
    level: '',
    imOk: false,
    imAccid: '',
    moneyOk: false,
    moneyPay: 0,
    moneyFree: 0,
    moneyTotal: 0,
    support: '',
    fans: '',
    likes: '',
    signature: '',
    message: '',
  }
  const token = getToken()
  if (!token)
    return { ...empty, message: '未登录口袋48账号' }
  const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token)
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status)) {
    expireStoredAuth()
    return { ...empty, message: '登录已过期，请重新登录' }
  }
  if (!envelope.success)
    return { ...empty, message: envelope.message || 'token 校验失败' }
  const info = pickUserInfo(envelope.content)
  const c = (envelope.content || {}) as Record<string, unknown>
  const user = (c.userInfo || c.user || c) as Record<string, unknown>
  const social = pickSocialStats(user)
  const support = pickNonNegativeNumber(user, 'support')
  // 验证通过即用服务端最新资料回写本地（用户可能改过头像/昵称），token 不动
  refreshStoredProfile(info)
  let imOk = false
  let imAccid = ''
  let imMessage = ''
  try {
    const credentials = await getImCredentials()
    imOk = true
    imAccid = credentials.accid
  }
  catch (error) {
    imMessage = error instanceof Error ? error.message : String(error)
  }
  let moneyOk = false
  let money: ReturnType<typeof pickMoney> = { moneyPay: 0, moneyFree: 0, moneyTotal: 0 }
  try {
    const moneyEnvelope = await postPocket<Record<string, unknown>>(USER_MONEY_URL, { token }, token)
    if (moneyEnvelope.success) {
      money = pickMoney(moneyEnvelope.content)
      moneyOk = true
    }
  }
  catch {
    // 钱包接口失败不影响登录态判定，仅余额展示为「获取失败」
  }
  return {
    valid: true,
    nickname: info.nickname,
    userId: info.userId,
    level: String(user.level ?? ''),
    imOk,
    imAccid,
    moneyOk,
    ...money,
    support: String(support),
    fans: social.fans,
    likes: social.likes,
    signature: social.signature,
    message: imOk ? '登录有效' : `登录有效，但互动消息凭据获取失败：${imMessage}`,
  }
}

/** 每日签到：调用唯一的签到接口，奖励字段由服务端返回；重复签到的判定也在服务端 */
export async function checkIn(): Promise<PocketCheckInResult> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(CHECKIN_URL, {}, token)
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!isEnvelopeOk(envelope))
    throw new Error(envelope.message || '签到失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  return {
    addExp: pickNonNegativeNumber(content, 'addExp'),
    addMoney: pickNonNegativeNumber(content, 'addMoney'),
    addSupport: pickNonNegativeNumber(content, 'addSupport'),
    days: pickNonNegativeNumber(content, 'days'),
  }
}

/** 验证通过后把服务端最新资料回写本地凭证（头像/昵称变更后设置页即时刷新；无变化不写盘） */
function refreshStoredProfile(info: PocketUserInfo): void {
  const stored = readStoredAuth()
  if (!stored)
    return
  if (stored.nickname === info.nickname && stored.avatar === info.avatar && stored.userId === info.userId)
    return
  saveStoredAuth({ ...stored, nickname: info.nickname, avatar: info.avatar, userId: info.userId })
}

// ===== 关注列表（账号维度） =====

/** 关注对象类型：1=成员；0=队伍（本应用只同步成员，队伍维度无对应概念） */
const FOLLOW_TO_TYPE_MEMBER = 1

/**
 * 拉取当前账号关注的成员 ID 列表。
 * 接口只返回 ID 数组（无分页、无昵称头像），详情由本地成员树解析——
 * 与 yaya_msg 同款策略，未登录返回空数组，token 失效抛「登录已过期」。
 */
export async function getFollowedIds(): Promise<number[]> {
  const token = getToken()
  if (!token)
    return []
  const envelope = await postPocket<Record<string, unknown>>(FRIENDS_IDS_URL, {}, token)
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取关注列表失败')
  const data = (envelope.content as Record<string, unknown> | undefined)?.data
  const ids = (Array.isArray(data) ? data : [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0)
  debug('[pocket-auth] 获取关注成员列表回包：', JSON.stringify({ count: ids.length, userIds: ids }))
  return ids
}

/** 关注成员（桌面端 toggle 双写）：失败抛错，调用方静默降级 */
export async function followMember(userId: number): Promise<void> {
  await postFollow(FRIEND_ADD_URL, userId, '关注')
}

/** 取消关注成员（桌面端 toggle 双写）：失败抛错，调用方静默降级 */
export async function unfollowMember(userId: number): Promise<void> {
  await postFollow(FRIEND_REMOVE_URL, userId, '取消关注')
}

async function postFollow(url: string, userId: number, action: string): Promise<void> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    url,
    { toSourceId: userId, toType: FOLLOW_TO_TYPE_MEMBER },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || `${action}失败`)
}

/**
 * 取直播的网易云信聊天室 id。
 * 无 token 的 getLiveOne 不返回 chatroomId（roomId 恒 0），必须带登录 token 请求；
 * 未登录返回空串，token 失效抛「登录已过期」。
 */
export async function getChatroomId(liveId: string): Promise<string> {
  const token = getToken()
  if (!token)
    return ''
  const envelope = await postPocket<Record<string, unknown>>(
    LIVE_ONE_URL,
    { type: 1, userId: '0', liveId: String(liveId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取直播聊天室 ID 失败')
  const content = envelope.content || {}
  const chatroomId = String(content.chatroomId || '').trim()
  if (chatroomId)
    return chatroomId
  // 兜底 roomId（yaya 同款）：0 表示无聊天室，绝不能当真值——'0' 去连聊天室必然失败
  const roomId = Number(content.roomId)
  return Number.isFinite(roomId) && roomId > 0 ? String(roomId) : ''
}

/**
 * 拉直播结束复盘（live/result）：下播后浮窗展示的总观看 / 本场时长 / 礼物流水 / 榜单前三。
 * 必须带登录 token（实测无 token 服务端报 400「缺少请求参数」）；进行中也可查，下播即时可用。
 * 未登录抛错（调用方降级简版结束卡），token 失效抛「登录已过期」。
 * 字段类型以报文为准：liveTime / totalMoney / liveId 实测都是字符串，bean 声明的 long/int 不可信，
 * 故这里原样回传 content，宽松解析归渲染层 live-result.ts。
 */
export async function getLiveResult(liveId: string): Promise<Record<string, unknown>> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    LIVE_RESULT_URL,
    { liveId: String(liveId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取直播复盘失败')
  return envelope.content || {}
}

// ===== 成员房间（口袋 App「房间」频道的留言流，与直播间弹幕是两套体系） =====

/**
 * 房间消息以 HTTP 轮询拉取：参考实现 yaya_msg 的实时消息走 QChat 长连接（另一套 NIM 协议），
 * 本版本以轮询替代实时推送，覆盖「查看房间消息」场景。
 */

/** 消息范围：member = 只看房主发言，all = 全部用户发言 */
export type RoomMessageScope = keyof typeof ROOM_MESSAGE_URLS

export interface PocketRoomChannel {
  serverId: string
  channelId: string
}

/** 单条房间消息（CustomMessageV2）：正文 bodys 多为 JSON 字符串，发送者资料在 extInfo.user */
export interface PocketRoomMessage {
  msgIdServer: string
  msgIdClient: string
  msgType: string
  msgTime: number
  bodys: string
  extInfo: string
  /**
   * 发送者 userId（extInfo.user 解出，与渲染层归一化同源）。
   * 主进程未读计数要用它剔除官方系统账号，口径与渲染层的成员视图一致。
   */
  userId: string
}

export interface PocketRoomMessages {
  messages: PocketRoomMessage[]
  /** 更早历史的游标（接口返回；0 = 没有更多） */
  nextTime: number
}

/**
 * 解析成员的房间频道（serverId + channelId）。
 * 未登录返回空频道，token 失效抛「登录已过期」。
 */
export async function getRoomChannel(userId: number): Promise<PocketRoomChannel> {
  const token = getToken()
  if (!token)
    return { serverId: '', channelId: '' }
  debug('[pocket-auth] 获取频道详情请求：', JSON.stringify({ userId: Number(userId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    SERVER_JUMP_URL,
    { starId: Number(userId), targetType: 1 },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间频道失败')
  const content = envelope.content || {}
  const channel = {
    serverId: String(content.serverId || '').trim(),
    channelId: String(content.channelId || '').trim(),
  }
  return channel
}

/** 房间频道反查结果：channelId → 房主 userId（未归属频道自愈用） */
export interface PocketRoomOwnerInfo {
  channelId: string
  serverId: string
  ownerId: number
}

/**
 * 反查房间频道的归属（channelId → 房主 ownerId + 所属 server）。
 * lastMsgList 回包里会出现同 server 下未登记的频道（成员房间或互动频道），
 * 用它把「解析失败的关注成员房间」补进归属表；找不到/无房间返回 ownerId = 0。
 */
export async function getRoomChannelOwner(channelId: string): Promise<PocketRoomOwnerInfo> {
  const token = getToken()
  if (!token || !channelId)
    return { channelId, serverId: '', ownerId: 0 }
  debug('[pocket-auth] 反查频道详情请求：', JSON.stringify({ channelId: String(channelId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_INFO_URL,
    { channelId: String(channelId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间归属失败')
  const content = envelope.content || {}
  const channelInfo = (content.channelInfo || {}) as Record<string, unknown>
  debug('[pocket-auth] room/info 原始回包：', JSON.stringify(content))
  return {
    channelId: String(channelInfo.channelId ?? channelId).trim(),
    serverId: String(channelInfo.serverId || '').trim(),
    ownerId: Number(channelInfo.ownerId) || 0,
  }
}

/**
 * 房间发言权限（room/info 回包里的 `userFunction`，与反查归属同一个端点）。
 *
 * 实测结论（2026-10，账号「海市」对照 7 个房间）：
 * - 「增锅的房间🍳」1311973：房主开了**房间级禁言**，`sendText / sendGif / sendEmoticon /
 *   sendForward` 全为 false、`cdTime = 30`；同一账号在其余 6 个房间 `sendText = true`、
 *   `cdTime = 10`。可见该字段表达的是「这个房间当前让不让我说话」，不是账号被封。
 * - 判据只取 `sendText`：账号等级、身份组、房间设置、个人禁言都已被服务端合并进这个布尔值，
 *   客户端不要自行推导（`inTeamServer` 与 `roomRole` 在禁言房间和可发言房间取值完全相同，
 *   都不能作为判据）。
 * - `cdTime` 是**房间级**发言冷却（秒）：禁言房间 30、常规房间 10。它与渲染层
 *   `SEND_COOLDOWN_MS`（1.5s 的点击防抖）无关，是服务端真正的限流窗口。
 */
export interface PocketRoomPermission {
  /** 能否发文字；false = 该房间禁止发言（房间级全员禁言或个人禁言） */
  sendText: boolean
  /** 房间级发言冷却（秒）；0 = 服务端未给该字段 */
  cdTime: number
  /** 房间身份："0" = 普通成员（房主/管理另有取值） */
  roomRole: string
  /** 是否已关注当前房间所属成员（room/info 顶层字段） */
  followFlag: boolean
}

/**
 * 拉取当前账号在指定频道的发言权限。
 * 未登录/无频道号返回 null；小房间暗号未通过时服务端回 status 2001，按失败上抛，
 * 调用方一律按「未知」处理（不据此禁用输入，最终仍由服务端拒绝兜底）。
 *
 * 走 30s 缓存并合并并发请求（见 ROOM_PERMISSION_TTL）：发送路径与进房预热都会读它，
 * 没有缓存就变成每条消息多打一次 room/info。
 */
export async function getRoomPermissions(channelId: string): Promise<PocketRoomPermission | null> {
  const cached = roomPermissionCache.get(channelId)
  if (cached && Date.now() - cached.at < ROOM_PERMISSION_TTL)
    return cached.value
  const pending = roomPermissionInflight.get(channelId)
  if (pending)
    return pending

  const task = fetchRoomPermissions(channelId).then((value) => {
    roomPermissionCache.set(channelId, { value, at: Date.now() })
    return value
  })
  const guarded = task.finally(() => {
    if (roomPermissionInflight.get(channelId) === guarded)
      roomPermissionInflight.delete(channelId)
  })
  roomPermissionInflight.set(channelId, guarded)
  return guarded
}

async function fetchRoomPermissions(channelId: string): Promise<PocketRoomPermission | null> {
  const token = getToken()
  if (!token || !channelId)
    return null
  debug('[pocket-auth] 房间发言权限请求：', JSON.stringify({ channelId: String(channelId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_INFO_URL,
    { channelId: String(channelId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间发言权限失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  const userFunction = (content.userFunction || {}) as Record<string, unknown>
  return {
    // 字段缺失（协议变动）时按可发言处理：宁可让服务端拒绝，也不要误判成禁言把人锁在外面
    sendText: typeof userFunction.sendText === 'boolean' ? userFunction.sendText : true,
    cdTime: Number(userFunction.cdTime) || 0,
    roomRole: String(content.roomRole ?? '0'),
    followFlag: content.followFlag === true,
  }
}

/** 频道名（seine 频道详情）：channelId + 服务端给的频道显示名 */
export interface PocketServerChannel {
  channelId: string
  channelName: string
}

/**
 * seine 服务的伪装头覆盖项：seine48 有独立的客户端特征（appName、UA、appVersion 与
 * 主 App 不同，且带 `X-Custom-Device-Type: ANDROID`），全部来自 client-profile。
 * 返回完整公共头由 postPocket 覆盖合并；`pa` 仍由其统一现算，避免两处签名不一致。
 */
function seineHeaderOverrides(): Record<string, string> {
  return clientHeaders(profileFor('seine48'))
}

/**
 * 拉取某个 team server 下的全部频道（channelId + channelName）。
 * 房间页用它把「房间 / 小房间」两个 tab 显示成真实频道名；
 * 字段结构无官方文档，失败/缺字段由调用方静默回退通用名。
 */
export async function getServerChannels(serverId: string, force = false): Promise<PocketServerChannel[]> {
  const token = getToken()
  if (!token || !serverId)
    return []
  const cached = serverChannelCache.get(serverId)
  if (!force && cached && Date.now() - cached.at < SERVER_CHANNEL_TTL)
    return cached.list
  debug('[pocket-auth] 拉取频道列表请求：', JSON.stringify({ serverId: String(serverId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    SEINE_SERVER_DETAIL_URL,
    { serverId: toApiId(serverId) },
    token,
    seineHeaderOverrides(),
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取频道列表失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  const list = Array.isArray(content.channelInfoList) ? content.channelInfoList : []
  const result = list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      channelId: String(item.channelId ?? '').trim(),
      channelName: String(item.channelName ?? '').trim(),
    }))
    .filter(item => item.channelId)
  // 排查用：该接口字段结构未公开，回包里的频道名列表直接打印对照（verbose 级别）
  debug('[pocket-auth] 获取频道列表回包：', JSON.stringify(result))
  serverChannelCache.set(serverId, { list: result, at: Date.now() })
  return result
}

/** 小房间（暗号频道）的暗号问题：room/info 被暗号拦下时回包 message 内嵌 JSON 信封 */
export interface PocketRoomQuestion {
  questionId: string
  question: string
}

/** 解析 room/info 拦截信封：message 是内嵌 JSON（如 {"questionId":"596","question":"..."}） */
function parseQuestionEnvelope(message: string): PocketRoomQuestion | null {
  const trimmed = message.trim()
  if (!trimmed.startsWith('{'))
    return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const questionId = String(parsed.questionId ?? '').trim()
    if (!questionId)
      return null
    return { questionId, question: String(parsed.question ?? '').trim() }
  }
  catch {
    return null
  }
}

/**
 * 拉取小房间的暗号问题。
 * room/info 正常回包 = 无门禁（或该账号已通过暗号），返回 null；
 * 被暗号拦下返回问题；其余业务错误照常抛出。
 */
export async function getRoomQuestion(channelId: string): Promise<PocketRoomQuestion | null> {
  const token = getToken()
  if (!token || !channelId)
    return null
  debug('[pocket-auth] 拉取暗号问题请求：', JSON.stringify({ channelId: String(channelId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_INFO_URL,
    { channelId: String(channelId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (envelope.success)
    return null
  const question = parseQuestionEnvelope(envelope.message || '')
  if (question)
    return question
  throw new Error(envelope.message || '获取暗号问题失败')
}

/**
 * 万能暗号：客户端直通，不发起任何请求。
 * 自用通道——真实暗号由服务端校验（见 checkRoomAnswer），但并非每个房间的暗号都已知。
 * 界面不公开它的存在。导出只为单测引用（主进程模块，渲染层拿不到），改动此处不必再改测试。
 */
export const MASTER_PASSCODE = '18951002'

/** 暗号提交结果（结构对齐 ipc-contract 的 PocketRoomAnswerResult） */
export interface PocketRoomAnswerResult {
  ok: boolean
  /** ok 时：master = 万能密码客户端直通，server = 服务端校验通过 */
  via?: 'master' | 'server'
  /** !ok 时：wrong = 服务端明确判错（含未取到题面），unverified = 校验接口不可达 */
  reason?: 'wrong' | 'unverified'
  message?: string
}

/**
 * questionId 服务端声明为 long（参考实现里是 Kotlin 的 Long）：
 * 纯数字串转数字，其余原样透传——宁可让服务端报参数错误，也不在本地编造。
 */
function toQuestionId(raw: string): number | string {
  const trimmed = raw.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
}

/**
 * 提交小房间暗号：只有服务端校验通过才算解锁。
 * 失败一律不放行；仅万能密码为开发者自用通道（界面不公开）。
 *
 * 校验端点（2026-10-15 真机验证，改动前请先读）：
 * - 端点 `im/api/v1/team/channel/question/answer/verify`，body `{ answer, questionId }`。
 *   真实 questionId 配错答 → `{status:500, success:false, message:'回答错误'}`；
 *   不存在的 questionId（999999 / 0）或缺失 → `{status:500, success:false,
 *   message:'问题不存在'}`。即 questionId 逐题校验、答案由服务端比对，判错有明确结论。
 * - `room/info` 给出的 questionId 与该校验端点认得的是同一空间（986 / 596 均判
 *   「回答错误」而非「问题不存在」），因此题面取自 room/info、校验走本端点即可。
 * - questionId 传数字或数字串服务端都能收（Jackson 自动转换），按官方客户端声明传数字。
 * - 官方进房动作是 `seine/server/channel/change`，业务码 2001 需答题
 *   （同族 2002 需贡献、2003 需守护）；本应用只读消息、不执行进房动作。
 * - 本函数只认服务端 `success`，其余情况一律视为未通过。
 *
 * 接口不可达 / 断网时返回 unverified，**不冒充「回答错误」**。
 */
export async function checkRoomAnswer(
  channelId: string,
  questionId: string,
  answer: string,
): Promise<PocketRoomAnswerResult> {
  const trimmed = answer.trim()
  if (!trimmed)
    return { ok: false, reason: 'wrong', message: '请输入暗号' }
  if (trimmed === MASTER_PASSCODE)
    return { ok: true, via: 'master' }
  if (!questionId.trim())
    return { ok: false, reason: 'wrong', message: '未取到暗号问题，请稍后重试' }
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  try {
    const envelope = await postPocket<Record<string, unknown>>(
      ROOM_ANSWER_VERIFY_URL,
      { answer: trimmed, questionId: toQuestionId(questionId) },
      token,
    )
    if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
      throwAuthExpired()
    if (envelope.success)
      return { ok: true, via: 'server' }
    debug('[pocket-auth] 暗号校验未通过：', channelId, JSON.stringify(envelope))
    return { ok: false, reason: 'wrong', message: envelope.message || '回答错误' }
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('登录已过期'))
      throw error
    debug('[pocket-auth] 暗号校验请求失败：', channelId, error)
    return { ok: false, reason: 'unverified', message: '暗号校验接口不可用，请稍后重试' }
  }
}

/**
 * 从 extInfo 里解出发送者 userId。
 * 归一层（renderer/utils/pocket-room-message.ts）走的是同一条路径，
 * 主进程未读计数按它剔除官方系统账号，两边口径必须一致。
 */
function senderUserId(rawExtInfo: unknown): string {
  let ext: Record<string, unknown> = {}
  if (typeof rawExtInfo === 'string') {
    try {
      ext = JSON.parse(rawExtInfo) as Record<string, unknown>
    }
    catch {
      // extInfo 不是 JSON（纯文本占位）：当作没有发送者资料
      ext = {}
    }
  }
  else if (rawExtInfo && typeof rawExtInfo === 'object') {
    ext = rawExtInfo as Record<string, unknown>
  }
  const user = (ext.user && typeof ext.user === 'object' ? ext.user : {}) as Record<string, unknown>
  const id = user.userId ?? user.id
  return id === undefined || id === null ? '' : String(id)
}

/**
 * 接口消息数组 → 归一前的原始消息（保留 bodys / extInfo 原文字符串）。
 * 普通消息与精华消息同构，两处共用：字段名与兜底顺序改动只需改这一处。
 */
function toRoomMessages(list: unknown): PocketRoomMessage[] {
  return (Array.isArray(list) ? list : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const extInfo = typeof item.extInfo === 'string' ? item.extInfo : JSON.stringify(item.extInfo ?? {})
      return {
        msgIdServer: String(item.msgIdServer ?? ''),
        msgIdClient: String(item.msgIdClient ?? ''),
        msgType: String(item.msgType ?? ''),
        msgTime: Number(item.msgTime) || 0,
        bodys: typeof item.bodys === 'string' ? item.bodys : JSON.stringify(item.bodys ?? ''),
        extInfo,
        userId: senderUserId(extInfo) || String(item.senderUserId ?? item.senderId ?? ''),
      }
    })
}

/**
 * 拉取房间频道消息（按 msgTime 倒序，最新在前；nextTime 为更早历史的游标）。
 * nextTime 传 0 拉最近一页——轮询新消息同样传 0，由调用方按 msgTime 增量过滤。
 */
export async function getRoomMessages(
  channelId: string,
  serverId: string,
  nextTime = 0,
  scope: RoomMessageScope = 'member',
): Promise<PocketRoomMessages> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const request = {
    channelId: toApiId(channelId),
    serverId: toApiId(serverId),
    nextTime: Number(nextTime) || 0,
    limit: ROOM_MESSAGE_LIMIT,
  }
  // debug('[pocket-auth] 获取频道消息请求：', JSON.stringify({ ...request, scope }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_MESSAGE_URLS[scope],
    request,
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间消息失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  const list = content.message ?? content.messageList
  const messages = toRoomMessages(list)
  const result = { messages, nextTime: Number(content.nextTime) || 0 }
  return result
}

/**
 * 拉取房间精华消息（房间页顶部置顶条 + 精华列表）。
 * 回包 `content.essenceMessageList` 与普通消息同构，故原始消息映射与归一化全部复用；
 * nextTime 同为分页游标（0 = 没有更多）。
 * 与消息列表不同，精华是房主 / 管理员挑选的**房间级**内容，与「只看房主 / 全部消息」无关。
 */
export async function getRoomEssenceMessages(
  channelId: string,
  serverId: string,
  nextTime = 0,
): Promise<PocketRoomMessages> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const request = {
    channelId: toApiId(channelId),
    serverId: toApiId(serverId),
    nextTime: Number(nextTime) || 0,
    limit: ROOM_MESSAGE_LIMIT,
  }
  debug('[pocket-auth] 获取房间精华消息请求：', JSON.stringify(request))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_ESSENCE_MESSAGE_URL,
    request,
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取精华消息失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  // 字段名两候选兜底：`essenceMessageList` 已由 APK 字符串池确认，message/list 防服务端换壳
  const list = content.essenceMessageList ?? content.message ?? content.messageList
  return { messages: toRoomMessages(list), nextTime: Number(content.nextTime) || 0 }
}

/** 频道最后一条消息（左侧房间列表预览；msgContent 与房间消息 bodys 同构） */
export interface PocketRoomLastMessage {
  channelId: string
  /** 所属 server（回包自带，归属未知频道时可直接入库，不必再跳转解析） */
  serverId: string
  /** 房间所属成员名（服务端给的 starName，注意是「最后发言人」不是房主） */
  starName: string
  /** 最后一条消息的正文（JSON 字符串或纯文本） */
  msgContent: string
  /**
   * 消息身份键（msgidClient 优先，msgid 系列兜底，最后退到 msgTime:msgContent）。
   * ⚠️ 该接口实测只回 4 个字段，msgidClient 系列与 msgTime 都拿不到，
   * 键实际恒退到 `0:正文`——同一频道连发两条相同文本会漏判一次（接口信息上限）。
   * 未读检测只用它判断「该频道是否来了新消息」（触发），不参与计数。
   */
  msgKey: string
  msgTime: number
  /**
   * 服务端记录的该频道真实未读数（官方客户端角标同源）。
   * ⚠️ 实测恒为 null：该字段要求服务端回完整档，而 15 组 A/B 探测（pa 三态 ×
   * 平台特征头 × 参考实现的真实客户端 profile）全部只回 4 个字段。
   * 保留解析只为排查（回包结构若变化，日志里能看见），未读计数改走消息列表逐条数，
   * 见 pocket-unread.ts 顶部。
   */
  unreadCount: number | null
}

/**
 * 批量拉取各 server 下频道的最后一条消息（一次请求覆盖整个关注列表）。
 * serverId 即 im/server/jump 解析出的 serverId；失败抛错，调用方静默降级（无预览）。
 */
export async function getRoomLastMessages(serverIds: string[]): Promise<PocketRoomLastMessage[]> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const ids = serverIds
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0)
  if (!ids.length)
    return []
  debug('[pocket-auth] 获取频道预览列表请求：', JSON.stringify({ serverIds: ids }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_LAST_MESSAGE_URL,
    { serverIdList: ids },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间最新消息失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  const list = content.lastMsgList ?? content.messageList ?? content.list
  const items = (Array.isArray(list) ? list : []).filter(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object',
  )

  const result = items.map((item) => {
    const msgTime = Number(item.msgTime) || 0
    const msgContent = typeof item.msgContent === 'string'
      ? item.msgContent
      : JSON.stringify(item.msgContent ?? '')
    return {
      channelId: String(item.channelId ?? '').trim(),
      serverId: String(item.serverId ?? '').trim(),
      starName: String(item.starName ?? '').trim(),
      msgContent,
      msgKey: String(
        item.msgidClient || item.msgIdClient || item.msgIdServer || item.msgId || item.messageId || '',
      ).trim() || `${msgTime}:${msgContent}`,
      msgTime,
      // 只认字段真实存在的情况：该接口不回该字段，0 与「未读 0 条」必须可区分
      unreadCount: typeof item.unreadCount === 'number' && Number.isFinite(item.unreadCount)
        ? item.unreadCount
        : null,
    }
  })
  debug('[pocket-auth] 获取频道预览列表回包：', JSON.stringify({
    count: result.length,
    channels: result.map(({ channelId: id, serverId: sid, starName, unreadCount, msgTime, msgContent }) => ({
      channelId: id,
      serverId: sid,
      starName,
      unreadCount,
      // msgContent 就是左列房间条展示的那条最新消息：正文截断，够对照即可
      msgTime,
      msgContent: msgContent.length > 120 ? `${msgContent.slice(0, 120)}…` : msgContent,
    })),
  }))
  return result
}

// ===== 网易云信 IM 凭据（直播聊天室） =====

export interface PocketImCredentials {
  accid: string
  token: string
}

/**
 * 云信 appKey：两个官方 APK 都硬编码同一个值（pocket 在 `NIMStrategy.getOptions()`，
 * seine 在 `e4/p.configIM()`），`im/userinfo` 不下发，故此值即真实值。
 * `PhoneConfig.imKey` 不是 appKey——它是消息防伪盐 `md5(uuid + fromAccount + imKey)`。
 */
export const IM_APP_KEY = '632feff1f4c838541ab75195d1ceb3fa'

/** 脱敏：只留头尾，够区分两个值即可 */
function maskCredential(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 4)}***${value.slice(-4)}`
}

/** 同一（档位, 账号）只报一次：换账号或换档位后会再次触发，便于对比两个身份 */
const credentialReports = new Set<string>()

/**
 * 打印 IM 凭据来源特征，便于排查「凭据是谁签发的」：
 * `accid` 由后端按账号签发，`userId` 是口袋账号 ID，二者一起看即可确定当前连的是哪个账号。
 * userId 不打码（它是房间消息里公开的数字 ID），否则无法逐位比对。
 */
function reportImCredentials(accid: string, content: Record<string, unknown>): void {
  const profile = currentClientProfile()
  const userId = String(content.userId ?? content.userid ?? '')
  const key = `${profile}:${userId}:${accid}`
  if (credentialReports.has(key))
    return
  credentialReports.add(key)
  debug('[pocket-auth] IM 凭据诊断：', JSON.stringify({
    档位: profile,
    回包字段: Object.keys(content).sort().join(','),
    accid: maskCredential(accid),
    userId: userId || '(无)',
  }))
}

/**
 * 取网易云信登录凭据（accid + imToken）。
 * token 失效（401005 等）抛「登录已过期」——渲染层据此引导重新登录。
 */
export async function getImCredentials(): Promise<PocketImCredentials> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const envelope = await postPocket<Record<string, unknown>>(
    IM_USER_INFO_URL,
    {},
    token,
    { 'P-Sign-Type': 'V0' },
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  const content = envelope.content || {}
  const accid = String(content.accid || content.accId || content.imUserId || '')
  const imToken = String(content.pwd || content.token || content.imPwd || '')
  if (!envelope.success || !accid || !imToken)
    throw new Error(envelope.message || '获取直播聊天室凭据失败')
  reportImCredentials(accid, content)
  return { accid, token: imToken }
}

// ===== 房间发言（QChat 圈组） =====

/**
 * 房间发言者资料快照：QChat 发送报文 ext.user 用（口袋客户端自己拼的那份）。
 * level / roleId / vip / pfUrl / teamLogo / badge 只有 user/info/reload 给，
 * 登录态基础字段（昵称 / 头像 / userId）登录时已落盘。
 */
export interface PocketRoomSenderProfile {
  userId: string
  nickname: string
  avatar: string
  level: number
  roleId: number
  vip: boolean
  pfUrl: string
  teamLogo: string
  badge: string[]
}

/** 资料快照缓存：reload 一次保整个会话（等级 / 身份组短期内不会变） */
let roomSenderProfile: PocketRoomSenderProfile | null = null

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 取房间发言者资料：优先内存缓存；缺失时打一次 user/info/reload 补全字段
 * （verifyLogin 只在设置页手动触发，不能依赖它预热），失败时用登录态基础字段兜底——
 * 等级 / 徽章显示为默认值，不影响发言本身。
 */
export async function getRoomSenderProfile(): Promise<PocketRoomSenderProfile> {
  if (roomSenderProfile)
    return roomSenderProfile
  const stored = readStoredAuth()
  const base: PocketRoomSenderProfile = {
    userId: stored?.userId ?? '',
    nickname: stored?.nickname ?? '',
    avatar: stored?.avatar ?? '',
    level: 0,
    roleId: 0,
    vip: false,
    pfUrl: '',
    teamLogo: '',
    badge: [],
  }
  const token = getToken()
  if (token) {
    try {
      const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token)
      if (envelope.success) {
        const content = (envelope.content || {}) as Record<string, unknown>
        const user = (content.userInfo || content.user || content) as Record<string, unknown>
        roomSenderProfile = {
          ...base,
          userId: base.userId || String(user.userId || user.id || ''),
          nickname: base.nickname || String(user.nickname || user.nickName || ''),
          avatar: base.avatar || String(user.avatar || user.userAvatar || ''),
          level: num(user.level),
          roleId: num(user.roleId),
          vip: user.vip === true,
          pfUrl: String(user.pfUrl || ''),
          teamLogo: String(user.teamLogo || ''),
          badge: Array.isArray(user.badge) ? user.badge.map(item => String(item)) : [],
        }
        return roomSenderProfile
      }
    }
    catch (error) {
      // 资料补全失败不阻断发言：用基础字段继续（ext.user 里等级等为默认值）
      debug('[pocket-auth] 房间发言资料补全失败，使用基础字段', error)
    }
  }
  // 补全失败不写缓存：瞬时失败若缓存了 base，等级 / 徽章 / vip 会整个登录会话都是降级值；
  // 不缓存则下一次发言重新补全（base 的四个字段本就来自本地凭证，重试无副作用）
  return base
}

/** 登录态变更（登出 / 失效）时作废资料缓存：换号后不能沿用上一个账号的资料 */
export function resetRoomSenderProfile(): void {
  roomSenderProfile = null
}

/**
 * 删除自己发的房间消息（房间发言走 QChat，删除是唯一的 HTTP 写操作）。
 * 服务端按 accId 校验只能删自己的，故 accId 现取 IM 凭据（与发送同源）。
 */
export async function deleteRoomMessage(channelId: string, msgIdClient: string, msgTime: number): Promise<void> {
  const token = getToken()
  if (!token)
    throw new Error('未登录口袋48账号')
  const credentials = await getImCredentials()
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_MSG_DELETE_URL,
    { accId: credentials.accid, msgIdClient, channelId, msgTime },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (!envelope.success)
    throw new Error(envelope.message || '删除房间消息失败')
}
