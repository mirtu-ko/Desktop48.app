/**
 * 口袋48直播聊天室消息归一化（纯函数，node 环境可单测）。
 *
 * 聊天室消息经网易云信到达，字段是「多层 JSON 套字符串」：
 * 类型标识在 attach/custom 承载的业务扩展里（messageType），发送者资料在扩展的 user 字段里，
 * 且不同消息类型的扩展结构不一致 —— 参考社区实现（yk1z/yaya_msg 的解析规则）用 TS 重写，
 * 逐字段兜底后归一成四类：弹幕 / 礼物 / 系统 / 榜单。
 * 榜单（LIVEUPDATE）不进气泡层，由调用方路由到独立的榜单面板。
 *
 * 归一失败（无法识别类型且无文本）返回 null，调用方直接丢弃。
 */

/** 归一后的聊天室消息 */
export interface PocketChatMessage {
  kind: 'barrage' | 'gift' | 'system' | 'rank'
  /** 展示文本：弹幕为消息内容，礼物为「赠送 N × 「礼物名」🎁」；昵称一律放 nick */
  text: string
  /** 发送者昵称；系统消息为空串 */
  nick: string
  /** 发送者 userId（可空） */
  userId: string
  /** 发送者等级（扩展 user.level）；服务端未给或为 0 时不携带 */
  level?: number
  /** 发送者头像 URL（扩展 user.avatar）；服务端未给时不携带 */
  avatar?: string
  /** kind='rank' 时的互动榜单用户（按名次升序）；其余 kind 不携带 */
  rankUsers?: PocketRankUser[]
}

/** 互动榜单条目（LIVEUPDATE 消息的 topList） */
export interface PocketRankUser {
  userId: string
  userName: string
  /** 头像 URL（相对/完整路径，Tools.sourceUrl 归一）；服务端未给时为空串 */
  avatar: string
  /** 用户等级（条目 user.level）；服务端未给或为 0 时不携带 */
  level?: number
  /** 贡献值（条目顶层 money）；服务端未给或为 0 时不携带 */
  money?: number
}

const BARRAGE_PREFIX = 'BARRAGE_'
const GIFT_PREFIXES = ['PRESENT_', 'GIFT_']
const IGNORED_TYPES = new Set(['DISABLE_SPEAK'])

/** 解析 LIVEUPDATE 消息的互动榜单：liveUpdateInfo.topList[].user */
export function extractRankUsers(extension: Record<string, unknown>): PocketRankUser[] {
  const updateInfo = parseJson(extension.liveUpdateInfo) || parseJson(extension.liveUpdate) || {}
  const topList = (Array.isArray(updateInfo.topList) ? updateInfo.topList : []) as unknown[]
  const users: PocketRankUser[] = []
  for (const entry of topList) {
    if (!entry || typeof entry !== 'object')
      continue
    const user = (entry as Record<string, unknown>).user
    const profile = parseJson(user) || (user && typeof user === 'object' ? user as Record<string, unknown> : null) || {}
    // userId 等 ID 字段服务端时而是数字，str() 只收字符串会丢值，必须宽松转换
    const userId = strLoose(profile.userId) || strLoose((entry as Record<string, unknown>).userId)
    const userName = strLoose(profile.userName) || strLoose(profile.nickName) || strLoose(profile.nickname)
    // 头像字段候选：榜单条目实测为 userAvatar（2026-10-14 报文），其余为历史兜底
    const avatar = str(profile.userAvatar) || str(profile.avatar) || str(profile.headerUrl)
      || str(profile.uImg) || str(profile.userImg) || str(profile.imgUrl)
      || str(profile.headImg) || str(profile.avatarUrl)
    // level 在条目的 user 里，money 在条目顶层（2026-10 报文：{"user":{...,"level":13},"money":20}）
    const level = Number(profile.level ?? 0) || 0
    const money = Number((entry as Record<string, unknown>).money ?? 0) || 0
    if (userName || userId)
      users.push({ userId, userName, avatar, level: level || undefined, money: money || undefined })
  }
  return users
}

/** 深度解析 JSON 字符串；非字符串或解析失败返回 null */
function parseJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim())
    return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  }
  catch {
    return null
  }
}

/**
 * 合并解析消息的业务扩展字段：SDK 不同消息类型把扩展放在不同属性
 * （attach / custom / remoteExtension / msg_attach_ …），逐候选合并、再展开一层嵌套。
 */
export function parseMessageExtension(msg: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    msg.msg_attach_,
    msg.msgAttach,
    msg.attachment,
    typeof msg.attach === 'string' ? msg.attach : null,
    msg.custom,
    msg.remoteExtension,
    msg.ext,
    parseJson(msg.attach)?.custom,
  ]
  let extension: Record<string, unknown> = {}
  for (const candidate of candidates) {
    const parsed = parseJson(candidate)
    if (parsed)
      extension = { ...extension, ...parsed }
  }
  const nested = parseJson(extension.data) || parseJson(extension.ext) || parseJson(extension.custom)
  if (nested)
    extension = { ...extension, ...nested }
  return extension
}

/** 取字符串字段；对象/null 兜底空串 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 宽松取字符串：数字等标量也转字符串。
 * 服务端 ID 类字段（userId 等）在 JSON 里时而是数字时而是字符串，
 * str() 只收字符串会把数字丢成空串，ID 字段一律走这里。
 */
function strLoose(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'string')
    return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return ''
}

/**
 * 提取发送者资料：扩展的 user 字段优先，SDK 自带的 fromNick 兜底。
 * 口袋的消息用户字段是 userName（如进场/LIVEUPDATE），弹幕扩展是 nickName，逐级兜底；
 * level 为用户等级（官方 App 发消息时自带），取不到为 0；avatar 为头像相对/完整路径
 */
function extractUser(msg: Record<string, unknown>, extension: Record<string, unknown>): { nick: string, userId: string, level: number, avatar: string } {
  const user = parseJson(extension.user) || (extension.user as Record<string, unknown> | null) || {}
  return {
    nick: str(user.nickName) || str(user.nickname) || str(user.nick) || str(user.userName) || str(user.name)
      || str(extension.nickName) || str(extension.nickname) || str(extension.userName)
      || str(msg.fromNick) || str(msg.nick),
    userId: strLoose(user.userId) || strLoose(extension.userId),
    level: Number(user.level ?? user.userLevel ?? 0) || 0,
    // 头像字段候选：榜单/进场消息实测为 userAvatar（2026-10-14 报文），其余为历史兜底
    avatar: str(user.userAvatar) || str(user.avatar) || str(user.headerUrl) || str(user.uImg) || str(user.userImg)
      || str(user.imgUrl) || str(user.headImg) || str(user.avatarUrl) || str(msg.fromAvatar),
  }
}

/** 礼物信息（名称与数量），逐字段兜底 */
function extractGift(extension: Record<string, unknown>): { name: string, num: number } {
  const giftInfo = parseJson(extension.giftInfo) || parseJson(extension.presentInfo)
    || parseJson(extension.present) || parseJson(extension.gift) || {}
  const gift = parseJson(giftInfo.gift) || {}
  const name = str(giftInfo.giftName) || str(giftInfo.presentName) || str(giftInfo.name)
    || str(gift.name) || str(extension.giftName) || str(extension.presentName) || '礼物'
  const num = Number(
    giftInfo.giftNum ?? giftInfo.presentNum ?? giftInfo.num ?? giftInfo.count
    ?? extension.giftNum ?? extension.num ?? extension.count ?? 1,
  ) || 1
  return { name, num }
}

/** 弹幕正文：扩展 text 优先，礼物附言（attachData.text）与 SDK 的 msg.text 兜底 */
function extractBarrageText(msg: Record<string, unknown>, extension: Record<string, unknown>): string {
  const giftInfo = parseJson(extension.giftInfo) || {}
  const attachData = parseJson(extension.attachData) || parseJson(giftInfo.attachData) || {}
  return str(extension.text) || str(attachData.text) || str(giftInfo.attachData ? (parseJson(giftInfo.attachData) as Record<string, unknown> | null)?.text : '')
    || str(msg.text)
}

/**
 * 归一一条聊天室消息。
 * @param msg SDK 消息对象（未知形状，按字段探测）
 * @param liveId 直播 ID：扩展带 sourceId/liveId 时用于过滤跨直播间串扰；缺省不校验
 */
export function normalizePocketChatMessage(
  msg: Record<string, unknown>,
  liveId?: string,
): PocketChatMessage | null {
  if (!msg || typeof msg !== 'object')
    return null
  const extension = parseMessageExtension(msg)
  const messageType = (str(extension.messageType) || str(extension.msgType) || str(extension.type))
    .toUpperCase()

  // 跨直播间串扰过滤：两侧都带 id 且不相等时丢弃（任一侧缺省视为同房间）
  const expected = liveId ? String(liveId) : ''
  const sourceId = str(extension.sourceId) || str(extension.liveId)
  if (expected && sourceId && sourceId !== expected)
    return null

  if (messageType === 'CLOSELIVE')
    return { kind: 'system', text: '直播已结束', nick: '', userId: '' }

  // 互动榜单变化：不进气泡层（高频），由宿主路由到右上角榜单面板
  if (messageType === 'LIVEUPDATE') {
    const rankUsers = extractRankUsers(extension)
    if (!rankUsers.length)
      return null
    return { kind: 'rank', text: '', nick: '', userId: '', rankUsers }
  }

  if (IGNORED_TYPES.has(messageType))
    return null

  // 进场提示：liveIntoPromptDescribe 即描述语（如「进入了房间」），用户在扩展 user 字段。
  // 昵称放 nick 字段（渲染层作作者前缀样式），正文只留动作描述
  const intoDescribe = str(extension.liveIntoPromptDescribe)
  if (intoDescribe) {
    const intoUser = extractUser(msg, extension)
    return {
      kind: 'system',
      text: intoDescribe,
      nick: intoUser.nick,
      userId: intoUser.userId,
      level: intoUser.level || undefined,
      avatar: intoUser.avatar || undefined,
    }
  }

  const user = extractUser(msg, extension)
  const hasGiftPayload = !!(extension.giftInfo || extension.presentInfo || extension.present || extension.gift)
  const isGift = !messageType.startsWith(BARRAGE_PREFIX)
    && (GIFT_PREFIXES.some(prefix => messageType.startsWith(prefix)) || hasGiftPayload)
  if (isGift) {
    const gift = extractGift(extension)
    return {
      kind: 'gift',
      // 昵称放 nick 字段作作者前缀（渲染层按消息类型着色），正文只留动作
      text: `赠送 ${gift.num} × 「${gift.name}」🎁`,
      nick: user.nick || '用户',
      userId: user.userId,
      level: user.level || undefined,
      avatar: user.avatar || undefined,
    }
  }

  const isBarrage = messageType.startsWith(BARRAGE_PREFIX) || msg.type === 'text' || !messageType
  if (isBarrage) {
    const text = extractBarrageText(msg, extension)
    if (!text)
      return null
    return { kind: 'barrage', text, nick: user.nick, userId: user.userId, level: user.level || undefined, avatar: user.avatar || undefined }
  }

  // 未知类型的兜底（尽量参考显示）：带正文的以系统气泡上屏（用户接受噪音），
  // 昵称放 nick 字段作作者前缀，与进场消息同款式；完全无文本则无处可显，只能丢弃
  const fallbackText = extractBarrageText(msg, extension)
  if (!fallbackText)
    return null
  return {
    kind: 'system',
    text: fallbackText,
    nick: user.nick,
    userId: user.userId,
    level: user.level || undefined,
    avatar: user.avatar || undefined,
  }
}
