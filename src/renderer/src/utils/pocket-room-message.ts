/**
 * 口袋48房间频道消息归一化（HTTP 拉取的 CustomMessageV2 → 展示模型）。
 *
 * 与 pocket-chat-message.ts（直播间弹幕）是两套体系：
 * - 弹幕消息来自 NIM 直播聊天室长连接，字段是 fromNick/user/giftInfo 等；
 * - 房间消息来自 im/team/message/list/homeowner，正文 bodys 多为 JSON 字符串，
 *   发送者资料在 extInfo.user（userId/nickName/avatar/level/roleId）。
 * - 房间消息也有实时来源：QChat 长连接推送（24/11），见 normalizePocketRoomQChatMessage
 *   ——同样改写成这里的原始形状，共用同一套归一规则。
 *
 * 归一规则对齐参考实现 yaya_msg 的消息解析：msgType 分发 + bodys JSON 兜底，
 * 未识别类型不丢（兜底 [新消息]），DELETE 类通知无展示价值直接过滤。
 * 用户原文里的表情占位符（[爱心] 等）统一在这里换成 emoji，见 data/pocket-emojis.ts。
 */

import type { PocketRoomQChatMessage } from '@preload/ipc-contract'

import { replacePocketEmoji } from '../data/pocket-emojis'

/** 消息类别：决定气泡样式与正文占位文案 */
export type PocketRoomMessageKind
  = | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'reply'
    | 'flip'
    | 'live'
    | 'gift'
    | 'vote'
    | 'system'

/**
 * 引用信息：消息流渲染引用块（被回复者昵称 + 被引用内容摘要）。
 * 字段来自 bodys 的 replyInfo / giftReplyInfo（协议结构见参考实现
 * yaya_msg 的 buildReplyOptions：replyName/replyText/replyMessageId/text）。
 * 翻牌的被翻提问（info.question）也归到这里：翻牌不是回复消息、被回复内容
 * 也不在 replyInfo 里，但「谁提问 + 问什么」正是这里要表达的，由 UI 单独渲染成问答卡。
 */
export interface PocketRoomQuote {
  /** 被引用者昵称；翻牌协议不给提问者昵称，固定「提问」 */
  nick: string
  /** 被引用消息的文本摘要；空串 = 原消息无文本（UI 兜底占位） */
  text: string
  /** 被引用的是一条礼物消息（replyInfo.giftInfo）：摘要走礼物文案 */
  isGift: boolean
}

export interface PocketRoomMessageView {
  /** 去重键：msgIdClient || msgIdServer || msgTime */
  id: string
  /** 客户端消息 ID（UUID 去横杠）；空串 = 接口未回（老消息 / 降级回包） */
  msgIdClient: string
  kind: PocketRoomMessageKind
  text: string
  userId: string
  nick: string
  avatar: string
  /** 发送者等级；0 = 未返回 */
  level: number
  /** roleId > 1 = 成员（xox），昵称可着色区分 */
  isMember: boolean
  msgTime: number

  /** 引用信息（回复类取自 replyInfo/giftReplyInfo，翻牌取自 info.question）；null = 无被引用内容 */
  quote: PocketRoomQuote | null

  /** 图片直链（IMAGE/EXPRESSIMAGE）；空串 = 非图片或取不到 URL */
  imageUrl: string
  /** 图片原始宽度；0 = 未返回（无法预留占位，加载时仍会轻微抖动） */
  imageWidth: number
  /** 图片原始高度；0 = 未返回 */
  imageHeight: number
  /** 音频直链（AUDIO / 语音回复 / 语音翻牌）；空串 = 无 */
  audioUrl: string
  /** 视频直链（VIDEO / 视频翻牌）；空串 = 无 */
  videoUrl: string

  /** 视频封面；空串 = 无 */
  videoPoster: string
  /** 视频原始宽度（bodys 的 w/width）；0 = 未提供（渲染层回退 16:9 占位） */
  videoWidth: number
  /** 视频原始高度；0 = 未提供 */
  videoHeight: number

  /** 直播分享目标 liveId（LIVEPUSH/OPEN_LIVE/SHARE_LIVE 系）；空串 = 非分享或未解析到，卡片不可点 */
  liveId: string
  /** 直播分享的直播类型：1=视频 2=电台；0 = 未返回（播放窗按视频降级） */
  liveType: number
  /** 直播分享的直播形态：1=录屏（liveType=1 时），0 = 普通直播/未返回 */
  liveMode: number
  /** 直播分享的开播时间（毫秒）；0 = 未返回 */
  liveStartTime: number
  /** 分享卡封面直链；空串 = 未解析到（卡片回退类型图标） */
  liveCover: string
  /** true = 指向录播/回放，点击走回放播放窗；false = 实时直播 */
  liveIsPlayback: boolean
}

/**
 * 直播分享正文 → 纯标题：剥掉归一层加的 [直播分享] 前缀。
 * 消息流卡片与播放窗标题共用，避免两处各写一份去除逻辑；空标题由调用方兜底。
 */
export function liveShareTitle(text: string): string {
  return text.replace(/^\[直播分享\]\s*/, '').trim()
}

/**
 * 类型占位文案：归一化自己拼的 [图片消息] 一类，不是用户说的话。
 * 消息卡的正文渲染（语音条下要不要再补一行）与「复制文字」共用这一份判据。
 */
const PLACEHOLDER_TEXTS = new Set([
  '[图片消息]',
  '[语音消息]',
  '[视频消息]',
  '[回复消息]',
  '[语音回复消息]',
  '[翻牌回复]',
  '[直播分享]',
  '[礼物]',
  '[投票]',
  '[禁言通知]',
  '[房间聊天已关闭]',
  '[新消息]',
])

/** 是否占位文案（空串同判：没有正文） */
export function isPlaceholderText(text: string): boolean {
  return !text || PLACEHOLDER_TEXTS.has(text)
}

export type PocketRoomCopyKey = 'text' | 'image' | 'audio' | 'video'

/**
 * 一条消息可复制的内容清单：正文优先，媒体直链在后；空数组 = 无可复制内容（系统通知、投票）。
 *
 * 正文只认用户原文——占位文案与礼物 / 直播分享的合成文案不算（复制出来是垃圾）；
 * 图片 / 语音 / 视频消息的复制目标是直链，占位正文不参与。
 */
export function pocketRoomCopyTargets(message: PocketRoomMessageView): Array<{ key: PocketRoomCopyKey, text: string }> {
  const targets: Array<{ key: PocketRoomCopyKey, text: string }> = []
  if (message.kind !== 'gift' && message.kind !== 'live' && !isPlaceholderText(message.text))
    targets.push({ key: 'text', text: message.text })
  if (message.imageUrl)
    targets.push({ key: 'image', text: message.imageUrl })
  if (message.audioUrl)
    targets.push({ key: 'audio', text: message.audioUrl })
  if (message.videoUrl)
    targets.push({ key: 'video', text: message.videoUrl })
  return targets
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object')
    return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim())
    return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

function str(value: unknown): string {
  if (typeof value === 'string')
    return value.trim()
  if (typeof value === 'number' && Number.isFinite(value))
    return String(value)
  return ''
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 取 JSON 里的文本字段：空串/纯空白视为缺失 */
function jsonText(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** 依次取第一个非空字符串字段；source 为 null 时返回空串 */
function firstStr(source: Record<string, unknown> | null | undefined, keys: string[]): string {
  for (const key of keys) {
    const value = str(source?.[key])
    if (value)
      return value
  }
  return ''
}

/**
 * 媒体相对路径 → 直链。口袋媒体按类型挂两个 CDN：
 * 图片/封面挂 source.48.cn，音视频挂 mp4.48.cn；完整 URL 原样返回。
 */
function mediaUrl(raw: unknown, host: 'source' | 'mp4'): string {
  const path = str(raw)
  if (!path)
    return ''
  if (/^https?:\/\//i.test(path))
    return path
  const base = host === 'mp4' ? 'https://mp4.48.cn' : 'https://source.48.cn'
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * bodys 兜底正文：能解析成 JSON 的只认其中 text 字段（'{}' 这类空壳不当正文），
 * 解析失败的纯文本才整体作正文（TEXT 消息 bodys 可能就是裸文本）。
 */
function bodyText(msg: Record<string, unknown>, body: Record<string, unknown> | null): string {
  const raw = body
    ? jsonText(body, 'text')
    : (typeof msg.bodys === 'string' ? msg.bodys.trim() : '')
  return replacePocketEmoji(raw)
}

/**
 * 礼物摘要：[礼物] 名 / [礼物] 名 xN；取不到礼物名返回空串（由调用方兜底）。
 * 礼物消息正文与被礼物消息的引用摘要共用，避免两处各写一份格式。
 */
function giftSummary(gift: Record<string, unknown> | null): string {
  if (!gift)
    return ''
  const giftName = str(gift.giftName)
  if (!giftName)
    return ''
  const giftNum = num(gift.giftNum) || num(gift.num)
  return giftNum > 1 ? `[礼物] ${giftName} x${giftNum}` : `[礼物] ${giftName}`
}

/**
 * 回复类消息自己的正文：replyInfo.text 优先（协议侧 buildReplyOptions 的 text
 * 即回复语）， bodys 为裸文本时兜底。空串 = 无正文（调用方给占位文案）。
 */
function replyOwnText(info: Record<string, unknown>, msg: Record<string, unknown>, body: Record<string, unknown> | null): string {
  return replacePocketEmoji(jsonText(info, 'text')) || bodyText(msg, body)
}

/**
 * 翻牌 info 解析：文本 / 语音 / 视频翻牌各有一套键，且协议里 flipCard 与 filpCard
 * 两种拼写并存（实测语音 / 视频翻牌同时带多套同构键）。正文、媒体直链、被翻提问
 * 三处共用这一处口径。
 */
function flipCardInfo(body: Record<string, unknown> | null): Record<string, unknown> {
  return parseJson(body?.flipCardAudioInfo) || parseJson(body?.flipCardVideoInfo)
    || parseJson(body?.filpCardAudioInfo) || parseJson(body?.filpCardVideoInfo)
    || parseJson(body?.flipCardInfo) || parseJson(body?.filpCardInfo)
    || body || {}
}

/**
 * 翻牌答案正文：answer 是纯文本才算正文——语音 / 视频翻牌的 answer 是带 url 的 JSON 串，
 * 内容在语音条 / 视频里，不进正文。空串 = 无正文（调用方给占位文案）。
 */
function flipAnswerText(info: Record<string, unknown>): string {
  const answer = firstStr(info, ['answer'])
  return answer && !answer.startsWith('{') ? replacePocketEmoji(answer) : ''
}

/**
 * msgType + bodys JSON → 展示文案。
 * 房间消息流（normalizePocketRoomMessage）与左侧列表最新消息预览
 * （normalizePocketRoomPreview）共用同一套类型语义，两边不重复维护。
 * msg.bodys 仅作纯文本兜底；预览场景把 msgContent 原样塞进 bodys 即可复用。
 */
function messageText(msgType: string, msg: Record<string, unknown>, body: Record<string, unknown> | null): string {
  switch (msgType) {
    case 'TEXT':
      return bodyText(msg, body)
    case 'IMAGE':
    case 'EXPRESSIMAGE':
      return '[图片消息]'
    case 'AUDIO':
      return '[语音消息]'
    case 'VIDEO':
      return '[视频消息]'
    case 'REPLY':
    case 'GIFTREPLY':
    case 'AUDIO_REPLY':
    case 'AUDIO_GIFT_REPLY': {
      const info = parseJson(body?.replyInfo) || parseJson(body?.giftReplyInfo) || body || {}
      // 被引用内容在 replyText，已单独解析为引用块（parseReplyQuote），不拼进正文前缀
      const own = replyOwnText(info, msg, body)
      if (own)
        return own
      return msgType.startsWith('AUDIO') ? '[语音回复消息]' : '[回复消息]'
    }
    case 'FLIPCARD':
    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO':
      return flipAnswerText(flipCardInfo(body)) || '[翻牌回复]'

    case 'LIVEPUSH':
    case 'OPEN_LIVE':
    case 'SHARE_LIVE':
    case 'SHARE_PLAYBACK':
    case 'PLAYBACK_SHARE': {
      const info = parseJson(body?.shareInfo) || parseJson(body?.livePushInfo) || body || {}
      const title = str(info.shareTitle) || str(info.liveTitle) || str(info.title)
      return title ? `[直播分享] ${title}` : '[直播分享]'
    }
    case 'PRESENT_NORMAL':
    case 'PRESENT_TEXT':
    case 'GIFT_TEXT':
    case 'RED_PACKET_2024':
    case 'ZHONGQIU_ACTIVITY_LANTERN_FANS': {
      const info = parseJson(body?.giftInfo) || body || {}
      return giftSummary(info) || '[礼物]'
    }
    case 'VOTE':
      return '[投票]'
    case 'DISABLE_SPEAK':
      return '[禁言通知]'
    case 'CLOSE_ROOM_CHAT':
      return '[房间聊天已关闭]'
    default:
      // 未识别类型不丢：extMsgType 动态消息（POST_INFO 等）与兜底文本
      return bodyText(msg, body) || '[新消息]'
  }
}

/**
 * 解析引用（回复）信息：bodys 的 replyInfo / giftReplyInfo → PocketRoomQuote。
 * 只认 replyName / replyText / giftInfo 三个字段——一个都没有（接口演进或
 * 结构变动）时返回 null，不渲染空的引用块。
 *
 * 被引用内容优先 replyText（原消息文本）；原消息是礼物时 replyText 为空，
 * 用 giftInfo 生成礼物摘要（isGift 供 UI 区分样式）。
 */
function parseReplyQuote(body: Record<string, unknown> | null): PocketRoomQuote | null {
  const info = parseJson(body?.replyInfo) || parseJson(body?.giftReplyInfo)
  if (!info)
    return null
  const replyName = str(info.replyName)
  // 被引用内容同为用户原文，表情一并还原
  const replyText = replacePocketEmoji(jsonText(info, 'replyText'))
  const gift = parseJson(info.giftInfo)
  if (!replyText && !gift && !replyName)
    return null
  return {
    nick: replyName || '用户',
    text: replyText || giftSummary(gift),
    isGift: !replyText && !!gift,
  }
}

/**
 * 解析翻牌的被翻提问：info.question → PocketRoomQuote。
 * 翻牌是「成员回答提问」而非回复某条消息，被回复内容不在 replyInfo 里，而在各自的
 * flipCard*Info.question；提问者昵称协议不给，昵称位固定「提问」。
 * 无 question（接口演进或结构变动）返回 null，不渲染空的问答卡。
 */
function parseFlipQuote(body: Record<string, unknown> | null): PocketRoomQuote | null {
  const question = replacePocketEmoji(jsonText(flipCardInfo(body), 'question'))
  return question ? { nick: '提问', text: question, isGift: false } : null
}

/**
 * 归一化单条房间消息。
 * 返回 null = 无需展示（DELETE 删除通知等非发言类系统消息）。
 */
export function normalizePocketRoomMessage(raw: unknown): PocketRoomMessageView | null {
  const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const body = parseJson(msg.bodys) ?? parseJson(msg.msgContent)
  const ext = parseJson(msg.extInfo) || {}
  const user = (ext.user && typeof ext.user === 'object' ? ext.user : {}) as Record<string, unknown>

  const msgType = (str(msg.msgType) || str(body?.messageType)).toUpperCase()
  if (msgType === 'DELETE')
    return null

  // 发送者资料：extInfo.user 为主（参考实现的发送结构同构），顶层字段兜底
  const nick = str(user.nickName) || str(user.nickname) || str(user.userName)
    || str(msg.senderName) || str(msg.nickName) || '口袋用户'
  const userId = str(user.userId) || str(user.id) || str(msg.senderUserId) || str(msg.senderId)
  const avatar = str(user.avatar) || str(msg.avatar)
  const level = num(user.level)
  const isMember = num(user.roleId) > 1

  // kind 与正文都从同一份分发取，保证列表预览和消息流文案一致
  const kind: PocketRoomMessageKind = msgType === 'TEXT' || !msgType
    ? 'text'
    : messageKind(msgType)
  const text = messageText(msgType, msg, body)
  // 引用信息：回复类取 replyInfo 系列，翻牌取被翻提问；被引用内容渲染成引用块（只读），不进正文
  let quote: PocketRoomQuote | null = null
  if (kind === 'reply')
    quote = parseReplyQuote(body)
  else if (kind === 'flip')
    quote = parseFlipQuote(body)

  // 媒体直链：bodys JSON 的 url 系字段（字段名对齐参考实现 yaya_msg 的解析）

  let imageUrl = ''
  let imageWidth = 0
  let imageHeight = 0
  let audioUrl = ''
  let videoUrl = ''
  let videoPoster = ''
  let videoWidth = 0
  let videoHeight = 0

  if (msgType === 'IMAGE') {
    imageUrl = mediaUrl(firstStr(body, ['url', 'imageUrl', 'imgUrl']), 'source')
    // 尺寸给渲染层做 aspect-ratio 占位（消除图片加载时的布局抖动）；字段名宽容匹配
    imageWidth = num(body?.width) || num(body?.imgWidth) || num(body?.w)
    imageHeight = num(body?.height) || num(body?.imgHeight) || num(body?.h)
  }
  else if (msgType === 'EXPRESSIMAGE') {
    imageUrl = mediaUrl(firstStr(parseJson(body?.expressImgInfo), ['emotionRemote']) || firstStr(body, ['url']), 'source')
  }
  else if (msgType === 'AUDIO') {
    audioUrl = mediaUrl(firstStr(body, ['url', 'audioUrl']), 'mp4')
  }
  else if (msgType === 'VIDEO') {
    videoUrl = mediaUrl(firstStr(body, ['url', 'videoUrl', 'videoPath']), 'mp4')
    videoPoster = mediaUrl(firstStr(body, ['coverUrl', 'cover', 'firstFrame', 'picUrl']), 'source')
    // 视频原始尺寸：实测 bodys 带 w/h（如竖屏 w=1080/h=1920），渲染层按真实比例占位
    videoWidth = num(body?.w) || num(body?.width)
    videoHeight = num(body?.h) || num(body?.height)
  }
  else if (msgType === 'AUDIO_REPLY' || msgType === 'AUDIO_GIFT_REPLY') {
    const info = parseJson(body?.replyInfo) || parseJson(body?.giftReplyInfo) || body
    audioUrl = mediaUrl(firstStr(info, ['voiceUrl', 'url', 'audioUrl']), 'mp4')
  }
  else if (msgType === 'FLIPCARD_AUDIO' || msgType === 'FLIPCARD_VIDEO') {
    // 语音/视频翻牌的答案是 JSON 字符串，里面带媒体 url
    const answer = parseJson(firstStr(flipCardInfo(body), ['answer']))
    if (msgType === 'FLIPCARD_AUDIO')
      audioUrl = mediaUrl(firstStr(answer, ['url']), 'mp4')
    else
      videoUrl = mediaUrl(firstStr(answer, ['url']), 'mp4')
  }

  // 直播分享目标：各字段从分享正文取。字段名对齐参考实现 yaya_msg 的解析——
  // LIVEPUSH 封面在 livePushInfo.liveCover，SHARE_LIVE 封面在 shareInfo.sharePic（相对路径挂 source.48.cn）；
  // SHARE_LIVE 的 liveId 不一定有独立字段，藏在 jumpPath（…id=12345…）里需正则提取。
  // 回放标记仍是宽容匹配（review 数值/显式标记/PLAYBACK 类 msgType）——口袋真实分享不带该标记，
  // 在播与否由房间页按当前直播列表判定（见 use-pocket-rooms 的 isSharedLiveOnAir）。
  let liveId = ''
  let liveType = 0
  let liveMode = 0
  let liveStartTime = 0
  let liveCover = ''
  let liveIsPlayback = false
  if (msgType === 'LIVEPUSH' || msgType === 'OPEN_LIVE' || msgType === 'SHARE_LIVE'
    || msgType === 'SHARE_PLAYBACK' || msgType === 'PLAYBACK_SHARE') {
    const info = parseJson(body?.shareInfo) || parseJson(body?.livePushInfo) || body
    const jumpLiveId = str(info?.jumpPath).match(/id=(\d+)/)?.[1] ?? ''
    liveId = firstStr(info, ['liveId', 'liveID', 'liveid', 'live_id']) || jumpLiveId || str(msg.liveId)
    liveType = num(info?.liveType) || num(body?.liveType)
    liveMode = num(info?.liveMode) || num(body?.liveMode)
    liveStartTime = num(info?.ctime) || num(info?.stime) || num(info?.startTime) || num(msg.ctime)
    liveCover = mediaUrl(firstStr(info, ['liveCover', 'sharePic', 'coverPath', 'picPath', 'liveImg', 'shareImg', 'cover', 'pic', 'imgUrl']), 'source')
    liveIsPlayback = num(info?.review) > 0 || num(info?.isPlayback) > 0 || num(info?.isReview) > 0
      || str(info?.type) === 'playback'
      || msgType.includes('PLAYBACK') || msgType.includes('REVIEW')
  }

  return {
    id: str(msg.msgIdClient) || str(msg.msgIdServer) || String(num(msg.msgTime)),
    msgIdClient: str(msg.msgIdClient),
    kind,
    text,
    userId,
    nick,
    avatar,
    level,
    isMember,
    msgTime: num(msg.msgTime),

    quote,

    imageUrl,
    imageWidth,
    imageHeight,
    audioUrl,
    videoUrl,
    videoPoster,
    videoWidth,
    videoHeight,
    liveId,
    liveType,
    liveMode,
    liveStartTime,
    liveCover,
    liveIsPlayback,
  }
}

/** QChat 线路类型 → 媒体类 msgType（参考实现的 type 1/2/3，正文在 attachment） */
const QCHAT_WIRE_MEDIA_TYPES: Record<number, string> = { 1: 'IMAGE', 2: 'AUDIO', 3: 'VIDEO' }

/**
 * 归一化 QChat 长连接推送消息（24/11）→ 展示模型。
 *
 * 做法与参考实现一致：把传输层消息**改写成 HTTP 拉取那条链路的原始形状**
 * （msgType + bodys + extInfo + 各 ID 字段），再走 normalizePocketRoomMessage——
 * 两套来源共用同一份类型分发与媒体解析，不为实时推送另养一套规则。
 * 映射口径（对齐参考实现的实时归一化）：
 * - 线路类型 0 = 文本，body 即正文；
 * - 线路类型 1/2/3 = 图片/语音/视频，正文在 attachment；
 * - 线路类型 100 = 自定义，msgType 取 attachment.messageType（REPLY / GIFTREPLY /
 *   FLIPCARD / LIVEPUSH…），正文整体在 attachment——与 HTTP 侧 bodys 同构。
 *
 * time 是协议原值（**秒**，参考实现同款判据）：小于 1e12 视为秒、乘 1000 归一成毫秒，
 * 与 HTTP 侧 msgTime 同一量纲（排序、日期分隔线、时刻展示都按毫秒）。
 * id 键取 msgIdClient，与发送 ACK 回显、HTTP 回包同一键空间——三源按 messageKeys 去重，
 * 自己发的消息不管经哪条链路回来都只显示一次。
 */
export function normalizePocketRoomQChatMessage(raw: PocketRoomQChatMessage): PocketRoomMessageView | null {
  const attachment = parseJson(raw.attachment)
  const msgType = raw.type === 100
    ? (str(attachment?.messageType) || 'UNKNOWN')
    : (QCHAT_WIRE_MEDIA_TYPES[raw.type] ?? 'TEXT')
  // 自定义消息的 attachment 解不出 JSON（协议演进）：塞 '{}' 走占位文案，
  // 不把原始串当正文展示
  const bodys = raw.type === 100 ? (attachment ? raw.attachment : '{}') : (raw.type === 0 ? raw.body : raw.attachment)
  const time = num(raw.time)
  return normalizePocketRoomMessage({
    msgType,
    bodys,
    extInfo: raw.ext,
    senderName: raw.fromNick,
    senderId: raw.fromAccount,
    msgIdClient: raw.msgIdClient,
    msgIdServer: raw.msgIdServer,
    msgTime: time > 0 && time < 1e12 ? time * 1000 : time,
  })
}

/** msgType → 消息类别（气泡样式）；text/system 之外的都归到对应磁贴 */
function messageKind(msgType: string): PocketRoomMessageKind {
  switch (msgType) {
    case 'IMAGE':
    case 'EXPRESSIMAGE':
      return 'image'
    case 'AUDIO':
      return 'audio'
    case 'VIDEO':
      return 'video'
    case 'REPLY':
    case 'GIFTREPLY':
    case 'AUDIO_REPLY':
    case 'AUDIO_GIFT_REPLY':
      return 'reply'
    case 'FLIPCARD':
    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO':
      return 'flip'

    case 'LIVEPUSH':
    case 'OPEN_LIVE':
    case 'SHARE_LIVE':
    case 'SHARE_PLAYBACK':
    case 'PLAYBACK_SHARE':
      return 'live'
    case 'PRESENT_NORMAL':
    case 'PRESENT_TEXT':
    case 'GIFT_TEXT':
    case 'RED_PACKET_2024':
    case 'ZHONGQIU_ACTIVITY_LANTERN_FANS':
      return 'gift'
    case 'VOTE':
      return 'vote'
    case 'DISABLE_SPEAK':
    case 'CLOSE_ROOM_CHAT':
      return 'system'
    default:
      return 'text'
  }
}

/**
 * 左侧房间列表的最新消息预览：lastMsgList.msgContent → 一行文案。
 * msgContent 与房间消息 bodys 同构（messageType + 类型字段），复用同一套分发；
 * 空内容（无消息）返回空串，由 UI 决定占位。
 * 回复类消息带一句「回复 昵称」前缀：左列一行放不下引用块，前缀是最省的等价物；
 * 回复无自己的正文（空回复）时退回被引用内容，避免预览只剩占位文案。
 * 翻牌同理，「[提问 xxx]」前缀带上被翻提问，后面接答案正文；答案无正文
 * （语音 / 视频翻牌）时前缀就是全部信息——这正是消息流引用块存在的理由。
 */
export function normalizePocketRoomPreview(rawContent: unknown): string {
  if (rawContent == null)
    return ''
  const bodys = (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)).trim()
  if (!bodys)
    return ''
  const body = parseJson(bodys)
  const msgType = (str(body?.messageType) || '').toUpperCase()
  const text = messageText(msgType, { bodys }, body).trim()
  const quote = parseReplyQuote(body)
  if (quote) {
    const info = parseJson(body?.replyInfo) || parseJson(body?.giftReplyInfo) || body || {}
    const own = replyOwnText(info, { bodys }, body)
    return `[回复 ${quote.nick}] ${own || quote.text || text}`
  }
  const flipQuote = parseFlipQuote(body)
  if (flipQuote) {
    const answer = flipAnswerText(flipCardInfo(body))
    return `[提问 ${flipQuote.text}]${answer ? ` ${answer}` : ''}`
  }
  return text
}
