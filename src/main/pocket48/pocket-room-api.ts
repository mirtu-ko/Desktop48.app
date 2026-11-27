import {
  ROOM_ANSWER_VERIFY_URL,
  ROOM_ESSENCE_MESSAGE_URL,
  ROOM_INFO_URL,
  ROOM_LAST_MESSAGE_URL,
  ROOM_MESSAGE_URLS,
  SEINE_SERVER_DETAIL_URL,
  SERVER_JUMP_URL,
} from '@common/pocket-api-urls'
/**
 * 口袋48「房间」频道接口：频道解析、发言权限、频道名、小房间暗号、消息流与末条消息。
 *
 * 与直播间弹幕是两套体系：弹幕走 NIM 聊天室（pocket-danmaku.ts），房间消息走本文件的 HTTP 接口。
 * 房间消息以 HTTP 轮询拉取：参考实现 yaya_msg 的实时消息走 QChat 长连接（另一套 NIM 协议），
 * 本版本以轮询替代实时推送，覆盖「查看房间消息」场景。
 *
 * 对外入口统一是 `./pocket-auth`（barrel），消费方不要直接引用本文件。
 */
import { toApiId, toMessageId } from '@common/pocket-ids'
import { ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'
import { debug, log } from '../logger'
import { getToken, onSessionReset, postPocket, throwAuthExpired, TOKEN_INVALID_STATUSES } from './pocket-auth-core'

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

// 换号后缓存必须失效：登出 / 失效时由 core 统一回调（见 pocket-auth-core 的 onSessionReset）
onSessionReset(() => {
  serverChannelCache.clear()
  roomPermissionCache.clear()
  roomPermissionInflight.clear()
})

// ===== 频道解析与归属 =====

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
  if (!envelope.success) {
    // 失败原因随错误带给消费方（ES2022 Error.cause）：归属自愈要据此区分「别的门禁」
    // 与「真的打不开」，渲染层要据此说清为什么进不去
    const gate = classifyChannelGate(envelope)
    // 成功只打 content，失败只打定性结果都会丢掉码值与原文：排查新门禁时最需要的就是这两样
    debug('[pocket-auth] room/info 业务失败（原始回包）：', channelId, JSON.stringify(envelope))
    throw new Error(gate.message || '获取房间归属失败', { cause: gate })
  }
  const content = envelope.content || {}
  const channelInfo = (content.channelInfo || {}) as Record<string, unknown>
  debug('[pocket-auth] room/info 原始回包：', JSON.stringify(content))
  return {
    channelId: String(channelInfo.channelId ?? channelId).trim(),
    serverId: String(channelInfo.serverId || '').trim(),
    ownerId: Number(channelInfo.ownerId) || 0,
  }
}

// ===== 发言权限 =====

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
 * - **房间关闭看 `channelInfo.hasMsgBoard`**（2026-11 实测「刘增艳」）：关闭后 jump 不退空、
 *   而是退到该 server 的直播频道（`channelName=直播`、`functionType=USER_LIVE`、`hasMsgBoard=0`），
 *   消息恒空页。`userFunction` 与 `channelStatus` 都判不出来（见上两条），故单取这个字段。
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
  /**
   * 该频道是否有房间留言板（`channelInfo.hasMsgBoard`）。
   * 房间关闭后 jump 会退到该 server 的直播频道，那里为 0、消息恒空；
   * 字段缺失时给 null，调用方不得据此推断
   */
  hasMsgBoard: boolean | null
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
  if (!envelope.success) {
    log('[pocket-auth] room/info 业务失败', channelId, envelope.status, envelope.message)
    throw new Error(envelope.message || '获取房间发言权限失败')
  }
  const content = (envelope.content || {}) as Record<string, unknown>
  const userFunction = (content.userFunction || {}) as Record<string, unknown>
  const channelInfo = (content.channelInfo || {}) as Record<string, unknown>
  // 房间关闭只能从这条回包读（channelStatus 语义不明，见 docs/room-message-pipeline.md 第 4 节），
  // 出问题时这行是唯一的现场
  debug('[pocket-auth] room/info 回包：', JSON.stringify(content))
  return {
    // 字段缺失（协议变动）时按可发言处理：宁可让服务端拒绝，也不要误判成禁言把人锁在外面
    sendText: typeof userFunction.sendText === 'boolean' ? userFunction.sendText : true,
    cdTime: Number(userFunction.cdTime) || 0,
    roomRole: String(content.roomRole ?? '0'),
    followFlag: content.followFlag === true,
    hasMsgBoard: typeof channelInfo.hasMsgBoard === 'number' ? channelInfo.hasMsgBoard > 0 : null,
  }
}

// ===== 频道名 =====

/** 频道名（seine 频道详情）：channelId + 服务端给的频道显示名 */
export interface PocketServerChannel {
  channelId: string
  channelName: string
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

// ===== 小房间门禁 =====

/**
 * 小房间门禁类型（room/info 拦下时的业务原因）：
 * - `question`：暗号题（2001），可本地作答；
 * - `chicken-leg`：赠送门槛（纯文本），不可作答；
 * - `contribution`：贡献 / 守护门槛（2002 / 2003），不可作答，界面不必区分。
 */
export type ChannelAccessGateKind = 'question' | 'chicken-leg' | 'contribution' | 'unknown'

/** 一道门禁的定性结果；`message` 是服务端原文，供界面如实转述（`question` 为空串） */
export interface ChannelAccessGate {
  kind: ChannelAccessGateKind
  /** 服务端业务码（`status`）；回包没给时 undefined */
  status?: number
  /** 服务端原文（已 trim）；`question` 类型为空串 */
  message: string
}

/** 赠送门槛的原文特征：服务端文案由 App 侧定义，可能存在改写，按关键字兜底 */
const CHICKEN_LEG_HINTS = ['鸡腿'] as const

/**
 * 把 room/info 的失败回包定性成门禁：暗号信封 → 鸡腿文案 → 业务码 → unknown。
 *
 * 文案必须先于码值：`room/info` 的 2002 不是贡献专属，鸡腿门槛也回 2002，
 * 先按码判会把赠送门槛误报成贡献。码值分不出贡献与守护，同归 `contribution`。
 */
export function classifyChannelGate(envelope: { status?: number, message?: string }): ChannelAccessGate {
  const raw = (envelope.message || '').trim()
  const status = envelope.status
  if (parseQuestionEnvelope(raw))
    return { kind: 'question', status, message: '' }
  if (CHICKEN_LEG_HINTS.some(hint => raw.includes(hint)))
    return { kind: 'chicken-leg', status, message: raw }
  if (status === 2002 || status === 2003)
    return { kind: 'contribution', status, message: raw }
  return { kind: 'unknown', status, message: raw }
}

/** 拉取小房间门禁（渲染层的锁态与提示文案都靠它）；正常回包 = null */
export async function getRoomGate(channelId: string): Promise<ChannelAccessGate | null> {
  const token = getToken()
  if (!token || !channelId)
    return null
  debug('[pocket-auth] 拉取房间门禁请求：', JSON.stringify({ channelId: String(channelId) }))
  const envelope = await postPocket<Record<string, unknown>>(
    ROOM_INFO_URL,
    { channelId: String(channelId) },
    token,
  )
  if (envelope.status !== undefined && TOKEN_INVALID_STATUSES.has(envelope.status))
    throwAuthExpired()
  if (envelope.success)
    return null
  const gate = classifyChannelGate(envelope)
  debug('[pocket-auth] 房间门禁回包：', channelId, gate.status, gate.kind, gate.message.slice(0, 80))
  return gate
}

// ===== 小房间暗号 =====

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
 * 被暗号拦下返回问题；其余业务拒绝抛错，原因挂在 `cause`（见 `classifyChannelGate`）——
 * 「最近30天内赠送过鸡腿礼物」这类非暗号门禁就是从这里区分出来的，不当作网络异常。
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
  const gate = classifyChannelGate(envelope)
  throw new Error(gate.message || '获取暗号问题失败', { cause: gate })
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

// ===== 消息流 =====

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
        msgIdServer: toMessageId(item.msgIdServer),
        msgIdClient: toMessageId(item.msgIdClient),
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
      msgKey: toMessageId(item.msgidClient)
        || toMessageId(item.msgIdClient)
        || toMessageId(item.msgIdServer)
        || toMessageId(item.msgId)
        || toMessageId(item.messageId)
        || `${msgTime}:${msgContent}`,
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
