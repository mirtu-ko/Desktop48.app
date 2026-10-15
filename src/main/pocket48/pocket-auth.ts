/**
 * 口袋48账号登录与凭证存储。
 *
 * 登录链路（均为主进程直连 pocketapi.48.cn，不经渲染层 netRequest）：
 * 1. 短信验证码：sms/send2 发送 → login/app/mobile/code 换 token。
 *    服务端偶发返回 status 2001 反爬问答题（message 内嵌 JSON），需把题目透传给用户作答。
 * 2. Token 粘贴：user/info/reload 校验 token 并取回用户资料。
 *
 * 凭证保存：token 经 safeStorage 加密后落盘 userData/pocket48-auth.json；
 * 平台无加密能力（部分 Linux 无钥匙环）时降级明文并打 plainFallback 标记。
 * token 有效期由服务端掌控（被踢/长期未用会失效），使用时才暴露给调用方，
 * 调用方收到 401005 等失效状态码时引导用户重新登录，本模块不自动重登。
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, net, safeStorage } from 'electron'
import { ROOM_MESSAGE_LIMIT } from '../../common/pocket-rooms'
import { debug, log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'
import { currentPa, ensurePaWasm } from './pa-sign'

// ===== 接口常量（与渲染层 services/api-urls.ts 保持同源；此域暂无渲染层调用，独立维护） =====

const SMS_SEND_URL = 'https://pocketapi.48.cn/user/api/v1/sms/send2'
const SMS_LOGIN_URL = 'https://pocketapi.48.cn/user/api/v1/login/app/mobile/code'
const TOKEN_CHECK_URL = 'https://pocketapi.48.cn/user/api/v1/user/info/reload'
/** 网易云信 IM 凭据（直播聊天室连接用）：需登录 token，额外带 P-Sign-Type 头 */
const IM_USER_INFO_URL = 'https://pocketapi.48.cn/im/api/v1/im/userinfo'
/** 口袋钱包余额：验证登录态时顺带展示，接口失败不影响登录态判定 */
const USER_MONEY_URL = 'https://pocketapi.48.cn/user/api/v1/user/money'
/** 关注成员 ID 列表（账号维度，一次性返回无分页；只给 ID，详情由本地成员树解析） */
const FRIENDS_IDS_URL = 'https://pocketapi.48.cn/user/api/v1/friendships/friends/id'
/** 关注 / 取消关注成员（桌面端 toggle 双写用） */
const FRIEND_ADD_URL = 'https://pocketapi.48.cn/user/api/v2/friendships/friends/add'
const FRIEND_REMOVE_URL = 'https://pocketapi.48.cn/user/api/v2/friendships/friends/remove'
/** 直播详情：仅带 token 的请求才返回 chatroomId（实测无 token 时 roomId 恒 0 且无 chatroomId 字段） */
const LIVE_ONE_URL = 'https://pocketapi.48.cn/live/api/v1/live/getLiveOne'

const REQUEST_TIMEOUT_MS = 20 * 1000

/**
 * 口袋 App 伪装头。对齐 yaya_msg 的真实设备模拟（全程 iOS 客户端特征）：
 * - UA / appInfo 声称 iPhone XR / iOS 16.3.1 / 7.0.41(24011601)；
 * - appInfo.deviceId 每安装随机生成（UUID，对齐 yaya 的 getDeviceId 行为），持久化复用；
 * - pa 为设备签名字段，见 POCKET_PA 与 pa-sign.ts——wasm 动态生成（内嵌当下时间戳），
 *   wasm 不可用时退回该静态值（2021 年签名，服务端可能降级回包，但不拦截请求）。
 * 实测服务端对请求特征分级：特征对不齐时部分接口（如 lastMsgList）只回降级字段，
 * 缺 unreadCount / msgTime / msgidClient。
 */
const POCKET_USER_AGENT = 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)'
const POCKET_PA = 'MTYzNjAxNzMxNTAwMCw3NjkyNzVkNTliZWU0MmQ0OGVjOWIyYTMwY2FkOWQzOSw3NzFhY2QwY2JiZDhkZDUzZDdjZGY3YTcxNGYzNmVlOCwyMDIxMDYwOTAx'

/** token 失效的服务端状态码（与 pocket48_api 社区实现一致） */
const TOKEN_INVALID_STATUSES = new Set([401003, 401004, 401005])

/** 反爬问答题状态码：message 字段为内嵌 JSON（{question, answer:[...]}) */
const CAPTCHA_STATUS = 2001

// ===== 持久化结构 =====

interface StoredAuth {
  /** 记住手机号（下次打开弹窗预填；明文，手机号本身不算机密） */
  mobile: string
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
  /** 脱敏手机号（139****1234）；空串表示未记住 */
  mobileMasked: string
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

/**
 * 伪装设备 UUID：进程内生成一次、本次会话内复用（对齐 yaya 的 getDeviceId 原行为）。
 * 不落盘——存档与登录凭证强耦合，混写会污染 verifyLogin 的「无变化不写盘」语义（踩过）；
 * 每次启动换新设备 ID 对服务端而言等价于重装 App，yaya 同样如此且链路正常。
 */
let pocketDeviceId = ''

function deviceUuid(): string {
  if (!pocketDeviceId)
    pocketDeviceId = randomUUID().toUpperCase()
  return pocketDeviceId
}

function pocketHeaders(token?: string, pa?: string): Record<string, string> {
  const appInfo = JSON.stringify({
    vendor: 'apple',
    deviceId: deviceUuid(),
    appVersion: '7.0.41',
    appBuild: '24011601',
    osVersion: '16.3.1',
    osType: 'ios',
    deviceName: 'iPhone XR',
    os: 'ios',
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': POCKET_USER_AGENT,
    'appInfo': appInfo,
    'Accept-Language': 'zh-Hans-CN;q=1',
    'pa': pa ?? POCKET_PA,
  }
  if (token)
    headers.token = token
  return headers
}

/** 主进程直连 pocketapi：POST JSON 并解析信封。网络层异常抛 Error，业务错误原样返回信封 */
async function postPocket<T>(
  url: string,
  data: object,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<PocketEnvelope<T>> {
  // pa 每次请求现算（内嵌当下时间戳）；wasm 加载失败时退回静态值，不影响请求发出
  await ensurePaWasm()
  const pa = currentPa(POCKET_PA)
  return new Promise<PocketEnvelope<T>>((resolve, reject) => {
    const request = net.request({ url, method: 'POST' })
    const headers = { ...pocketHeaders(token, pa), ...extraHeaders }
    for (const [key, value] of Object.entries(headers))
      request.setHeader(key, value)

    let settled = false
    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      request.abort()
      reject(new Error('请求超时，请检查网络'))
    }, REQUEST_TIMEOUT_MS)

    const fail = (err: Error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
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
        if (status < 200 || status >= 300) {
          reject(new Error(`接口异常（HTTP ${status}）`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as PocketEnvelope<T>)
        }
        catch {
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
  return token
}

function maskMobile(mobile: string): string {
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
    mobileMasked: maskMobile(stored?.mobile || ''),
    plainFallback: !!stored && !!stored.tokenPlain && !safeStorageAvailable(),
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

/**
 * 发送登录验证码。
 * 正常返回 needCaptcha=false；命中反爬问答题（2001）时返回题目与选项，
 * 用户作答后把 answer 随下一次发送一并提交。
 */
export async function sendSms(mobile: string, answer?: string): Promise<PocketSmsResult> {
  const trimmed = mobile.trim()
  if (!/^\d{11}$/.test(trimmed))
    throw new Error('请输入 11 位手机号')
  const payload: Record<string, string> = { mobile: trimmed, area: '86' }
  if (answer)
    payload.answer = answer
  const envelope = await postPocket(SMS_SEND_URL, payload)
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
    return { needCaptcha: true, question, options, message: '需要完成验证' }
  }
  if (envelope.success)
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

/** 验证码登录：成功后落盘凭证并返回登录态 */
export async function loginByCode(mobile: string, code: string): Promise<PocketAuthState> {
  const trimmedMobile = mobile.trim()
  const trimmedCode = code.trim()
  if (!/^\d{11}$/.test(trimmedMobile))
    throw new Error('请输入 11 位手机号')
  if (!trimmedCode)
    throw new Error('请输入验证码')
  const envelope = await postPocket<{ token?: string }>(SMS_LOGIN_URL, {
    mobile: trimmedMobile,
    code: trimmedCode,
  })
  const token = envelope.content?.token
  if (!envelope.success || !token)
    throw new Error(envelope.message || '验证码错误或已过期')
  // 登录响应的 content 里未必带资料，再校验一次顺手取昵称头像（失败不阻断，资料只是展示用）
  let info: PocketUserInfo = { nickname: '', avatar: '', userId: '' }
  try {
    const check = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token)
    if (check.success)
      info = pickUserInfo(check.content)
  }
  catch (error) {
    log('[pocket-auth] 登录后拉取资料失败（不阻断登录）', error)
  }
  saveAuth(trimmedMobile, token, info)
  return getAuthState()
}

/** Token 粘贴登录：user/info/reload 校验有效后落盘 */
export async function loginByToken(token: string, mobile = ''): Promise<PocketAuthState> {
  const trimmed = token.trim()
  if (!trimmed)
    throw new Error('请输入 token')
  const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, trimmed)
  if (!envelope.success) {
    const invalid = envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status)
    throw new Error(invalid ? 'token 无效或已过期' : envelope.message || 'token 校验失败')
  }
  const info = pickUserInfo(envelope.content)
  saveAuth(mobile.trim(), trimmed, info)
  return getAuthState()
}

function saveAuth(mobile: string, token: string, info: PocketUserInfo): void {
  const encrypted = safeStorageAvailable()
  saveStoredAuth({
    mobile,
    tokenEnc: encrypted ? safeStorage.encryptString(token).toString('base64') : '',
    tokenPlain: encrypted ? '' : token,
    nickname: info.nickname,
    avatar: info.avatar,
    userId: info.userId,
    savedAt: Date.now(),
  })
  log(`[pocket-auth] 凭证已保存（${encrypted ? '加密' : '明文降级'}），用户: ${info.nickname || '未知'}`)
}

/** 退出登录：删除本地凭证文件 */
export function logout(): void {
  const file = authFilePath()
  try {
    if (fs.existsSync(file))
      fs.unlinkSync(file)
    log('[pocket-auth] 已退出登录')
  }
  catch (error) {
    log('[pocket-auth] 删除凭证失败', error)
  }
}

/** 登录有效性验证结果：imOk 表示弹幕实际依赖的 IM 凭据链路是否可用 */
export interface PocketVerifyResult {
  valid: boolean
  nickname: string
  userId: string
  level: string
  imOk: boolean
  imAccid: string
  /** 口袋钱包（元）；moneyOk=false 时三个余额无意义（接口失败不影响登录态判定） */
  moneyOk: boolean
  moneyPay: number
  moneyFree: number
  moneyTotal: number
  /** 社交资料：服务端不返回的字段为空串，UI 据此隐藏对应条目 */
  fans: string
  likes: string
  signature: string
  message: string
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
    fans: '',
    likes: '',
    signature: '',
    message: '',
  }
  const token = getToken()
  if (!token)
    return { ...empty, message: '未登录口袋48账号' }
  const envelope = await postPocket<Record<string, unknown>>(TOKEN_CHECK_URL, { from: 'appstart' }, token)
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    return { ...empty, message: '登录已过期，请重新登录' }
  if (!envelope.success)
    return { ...empty, message: envelope.message || 'token 校验失败' }
  const info = pickUserInfo(envelope.content)
  const c = (envelope.content || {}) as Record<string, unknown>
  const user = (c.userInfo || c.user || c) as Record<string, unknown>
  const social = pickSocialStats(user)
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
    fans: social.fans,
    likes: social.likes,
    signature: social.signature,
    message: imOk ? '登录有效' : `登录有效，但互动消息凭据获取失败：${imMessage}`,
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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

// ===== 成员房间（口袋 App「房间」频道的留言流，与直播间弹幕是两套体系） =====

/** 成员 userId → 房间频道（team server + channel）解析：starId 即成员 userId */
const SERVER_JUMP_URL = 'https://pocketapi.48.cn/im/api/v1/im/server/jump'
const ROOM_INFO_URL = 'https://pocketapi.48.cn/im/api/v1/im/team/room/info'
/**
 * 答案校验端点：小房间暗号唯一的真实校验入口，见 checkRoomAnswer 的实测记录。
 * 来源：塞纳河48 客户端（com.seine48.app）jadx 反编译——Retrofit 接口
 * `com.meta.module_base.network.api.ApiIM#questionAnswer`
 * `@POST("im/api/v1/team/channel/question/answer/verify")`，
 * 请求体由 `ChannelSwitchViewModel.submitQuestionAnswer` 构造：`{ answer, questionId }`。
 */
const ROOM_ANSWER_VERIFY_URL = 'https://pocketapi.48.cn/im/api/v1/team/channel/question/answer/verify'
/**
 * 频道详情（seine 服务）：给定 team server 返回其下全部频道，含服务端给的 channelName。
 * 房间页「房间 / 小房间」切换要显示真实频道名，而 jump 与 lastMsgList 都不带频道名，
 * 被暗号拦下的 room/info 也拿不到 channelInfo——名称只能从这里取。
 * 参考实现 yaya_msg 同款；seine 有独立的客户端特征，见 seineHeaderOverrides。
 */
const SEINE_SERVER_DETAIL_URL = 'https://pocketapi.48.cn/im/api/seine/server/detail'
/**
 * 房间频道历史消息（HTTP 拉取）。
 * 参考实现 yaya_msg 的实时消息走 QChat 长连接（另一套 NIM 协议），
 * 本版本以轮询替代实时推送，覆盖「查看房间消息」场景。
 */
/**
 * 房间消息列表接口：同一频道两档口径（参考实现 yaya_msg 同款切换）。
 * homeowner 仅房主（成员）发言（会混入官方系统账号 121569667，由渲染层过滤）；
 * all 全员发言。
 */
const ROOM_MESSAGE_URLS = {
  member: 'https://pocketapi.48.cn/im/api/v1/team/message/list/homeowner',
  all: 'https://pocketapi.48.cn/im/api/v1/team/message/list/all',
} as const

/** 消息范围：member = 只看房主发言，all = 全部用户发言 */
export type RoomMessageScope = keyof typeof ROOM_MESSAGE_URLS
/** 批量取各 server 下每个频道的最后一条消息（左侧列表预览用；参考实现 yaya_msg 同款） */
const ROOM_LAST_MESSAGE_URL = 'https://pocketapi.48.cn/im/api/v1/team/classic/last/message/get'

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
    throw new Error('登录已过期，请重新登录口袋48账号')
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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

/** 频道名（seine 频道详情）：channelId + 服务端给的频道显示名 */
export interface PocketServerChannel {
  channelId: string
  channelName: string
}

/**
 * seine 服务的伪装头覆盖项：客户端特征与主 App 不同（appName = seine48、Alamofire UA、
 * appVersion 1.2.0），其余字段（token / pa / Accept-Language）沿用 pocketHeaders。
 * 只返回需要覆盖的键，pa 仍由 postPocket 统一现算，避免两处签名不一致。
 */
function seineHeaderOverrides(): Record<string, string> {
  return {
    'appInfo': JSON.stringify({
      vendor: 'apple',
      deviceId: deviceUuid(),
      appVersion: '1.2.0',
      appBuild: '26072902',
      osVersion: '27.0',
      osType: 'ios',
      deviceName: 'iPhone 16 Pro',
      appName: 'seine48',
    }),
    'User-Agent': 'Seina/1.2.0 (com.seine48.app; build:26072902; iOS 27.0.0) Alamofire/5.8.0',
  }
}

/**
 * 拉取某个 team server 下的全部频道（channelId + channelName）。
 * 房间页用它把「房间 / 小房间」两个 tab 显示成真实频道名；
 * 字段结构无官方文档，失败/缺字段由调用方静默回退通用名。
 */
export async function getServerChannels(serverId: string): Promise<PocketServerChannel[]> {
  const token = getToken()
  if (!token || !serverId)
    return []
  debug('[pocket-auth] 拉取频道列表请求：', JSON.stringify({ serverId: String(serverId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    SEINE_SERVER_DETAIL_URL,
    { serverId: Number(serverId) },
    token,
    seineHeaderOverrides(),
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throw new Error('登录已过期，请重新登录口袋48账号')
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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
      throw new Error('登录已过期，请重新登录口袋48账号')
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
    channelId: Number(channelId),
    serverId: Number(serverId),
    nextTime: Number(nextTime) || 0,
    limit: ROOM_MESSAGE_LIMIT,
  }
  debug('[pocket-auth] 获取频道消息请求：', JSON.stringify({ ...request, scope }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_MESSAGE_URLS[scope],
    request,
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throw new Error('登录已过期，请重新登录口袋48账号')
  if (!envelope.success)
    throw new Error(envelope.message || '获取房间消息失败')
  const content = (envelope.content || {}) as Record<string, unknown>
  const list = content.message ?? content.messageList
  const messages: PocketRoomMessage[] = (Array.isArray(list) ? list : [])
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
  const result = { messages, nextTime: Number(content.nextTime) || 0 }
  return result
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
   * 降级回包无 msgidClient 系列字段，键退到 msgTime:msgContent。
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
    throw new Error('登录已过期，请重新登录口袋48账号')
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
      // 只认字段真实存在的情况：降级回包没有该字段，0 与「未读 0 条」必须可区分
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
 * 取网易云信聊天室登录凭据（accid + imToken）。
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
    throw new Error('登录已过期，请重新登录口袋48账号')
  const content = envelope.content || {}
  const accid = String(content.accid || content.accId || content.imUserId || '')
  const imToken = String(content.pwd || content.token || content.imPwd || '')
  if (!envelope.success || !accid || !imToken)
    throw new Error(envelope.message || '获取直播聊天室凭据失败')
  return { accid, token: imToken }
}
