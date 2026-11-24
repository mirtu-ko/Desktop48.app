/**
 * 口袋48登录会话：短信验证码 / Token 粘贴两条登录链路、退出与失效、登录有效性校验。
 *
 * 登录链路（均为主进程直连 pocketapi.48.cn）：
 * 1. 短信验证码：v2 sms/send_sms 发送 → v2 login/app/app_login 换 token（实测成功）。
 *    服务端偶发返回 status 2001 反爬问答题（message 内嵌 JSON），需把题目透传给用户作答。
 * 2. Token 粘贴：user/info/reload 校验 token 并取回用户资料。
 *
 * 凭证读写与请求收窄全部在 pocket-auth-core.ts；本模块只负责登录流程编排。
 * 对外入口统一是 `./pocket-auth`（barrel），消费方不要直接引用本文件。
 */
import type { PocketClientProfileId } from '@common/pocket-client-profile'
import type { PocketAuthState, PocketSmsResult, PocketUserInfo } from './pocket-auth-core'
import {
  CHECKIN_URL,
  SMS_LOGIN_URL,
  SMS_SEND_URL,
  TOKEN_CHECK_URL,
  USER_MONEY_URL,
} from '@common/pocket-api-urls'
import { debug, log } from '../logger'
import {
  credentials,
  currentClientProfile,
  expireStoredAuth,
  getAuthState,
  getToken,
  isEnvelopeOk,
  maskMobile,
  normalizeArea,
  postPocket,
  saveAuth,
  summarizeEnvelope,
  throwAuthExpired,
  TOKEN_INVALID_STATUSES,
} from './pocket-auth-core'
import { getImCredentials } from './pocket-im'

// ===== 登录与退出 =====

/** 反爬问答题状态码：message 字段为内嵌 JSON（{question, answer:[...]}) */
const CAPTCHA_STATUS = 2001

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
  await saveAuth(trimmedMobile, token, info, normalizedArea, profile)
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
  await saveAuth(mobile.trim(), trimmed, info, '86', profile)
  return getAuthState()
}

// ===== 登录有效性 =====

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
    const im = await getImCredentials()
    imOk = true
    imAccid = im.accid
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
  credentials.update({ nickname: info.nickname, avatar: info.avatar, userId: info.userId })
}
