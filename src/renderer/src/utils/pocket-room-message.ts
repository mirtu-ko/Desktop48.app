/**
 * 口袋48房间频道消息归一化（HTTP 拉取的 CustomMessageV2 → 展示模型）。
 *
 * 与 pocket-chat-message.ts（直播间弹幕）是两套体系：
 * - 弹幕消息来自 NIM 直播聊天室长连接，字段是 fromNick/user/giftInfo 等；
 * - 房间消息来自 im/team/message/list/homeowner，正文 bodys 多为 JSON 字符串，
 *   发送者资料在 extInfo.user（userId/nickName/avatar/level/roleId）。
 *
 * 归一规则对齐参考实现 yaya_msg 的消息解析：msgType 分发 + bodys JSON 兜底，
 * 未识别类型不丢（兜底 [新消息]），DELETE 类通知无展示价值直接过滤。
 */

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

export interface PocketRoomMessageView {
  /** 去重键：msgIdClient || msgIdServer || msgTime */
  id: string
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
  /** 图片直链（IMAGE/EXPRESSIMAGE）；空串 = 非图片或取不到 URL */
  imageUrl: string
  /** 音频直链（AUDIO / 语音回复 / 语音翻牌）；空串 = 无 */
  audioUrl: string
  /** 视频直链（VIDEO / 视频翻牌）；空串 = 无 */
  videoUrl: string

  /** 视频封面；空串 = 无 */
  videoPoster: string

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
  if (body)
    return jsonText(body, 'text')
  return typeof msg.bodys === 'string' && msg.bodys.trim() ? msg.bodys.trim() : ''
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
      const replyName = str(info.replyName) || '用户'
      const replyText = jsonText(info, 'text') || jsonText(info, 'replyText')
      return msgType.startsWith('AUDIO')
        ? (replyText || '[语音回复消息]')
        : (replyText ? `[回复 ${replyName}] ${replyText}` : '[回复消息]')
    }
    case 'FLIPCARD':
    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO': {
      const info = parseJson(body?.flipCardInfo) || parseJson(body?.filpCardInfo)
        || parseJson(body?.flipCardAudioInfo) || parseJson(body?.flipCardVideoInfo) || body || {}
      const answer = str(info.answer)
      return answer && !answer.startsWith('{') ? answer : '[翻牌回复]'
    }

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
      const giftName = str(info.giftName)
      const giftNum = num(info.giftNum) || num(info.num)
      return giftName ? (giftNum > 1 ? `[礼物] ${giftName} x${giftNum}` : `[礼物] ${giftName}`) : '[礼物]'
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

  // 媒体直链：bodys JSON 的 url 系字段（字段名对齐参考实现 yaya_msg 的解析）
  let imageUrl = ''
  let audioUrl = ''
  let videoUrl = ''
  let videoPoster = ''
  if (msgType === 'IMAGE') {
    imageUrl = mediaUrl(firstStr(body, ['url', 'imageUrl', 'imgUrl']), 'source')
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
  }
  else if (msgType === 'AUDIO_REPLY' || msgType === 'AUDIO_GIFT_REPLY') {
    const info = parseJson(body?.replyInfo) || parseJson(body?.giftReplyInfo) || body
    audioUrl = mediaUrl(firstStr(info, ['voiceUrl', 'url', 'audioUrl']), 'mp4')
  }
  else if (msgType === 'FLIPCARD_AUDIO' || msgType === 'FLIPCARD_VIDEO') {
    const info = parseJson(body?.flipCardAudioInfo) || parseJson(body?.flipCardVideoInfo)
      || parseJson(body?.flipCardInfo) || parseJson(body?.filpCardInfo) || body
    // 语音/视频翻牌的答案是 JSON 字符串，里面带媒体 url
    const answer = parseJson(firstStr(info, ['answer']))
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
    kind,
    text,
    userId,
    nick,
    avatar,
    level,
    isMember,
    msgTime: num(msg.msgTime),

    imageUrl,
    audioUrl,
    videoUrl,
    videoPoster,
    liveId,
    liveType,
    liveMode,
    liveStartTime,
    liveCover,
    liveIsPlayback,
  }
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
 */
export function normalizePocketRoomPreview(rawContent: unknown): string {
  if (rawContent == null)
    return ''
  const bodys = (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)).trim()
  if (!bodys)
    return ''
  const body = parseJson(bodys)
  const msgType = (str(body?.messageType) || '').toUpperCase()
  return messageText(msgType, { bodys }, body).trim()
}
