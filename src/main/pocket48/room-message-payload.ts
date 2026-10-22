/**
 * 房间消息发送入参构造（QChat 属性表之外的业务层）：ext 发言者快照与回复附件。
 * 构造只在主进程完成，渲染层不接触报文细节。
 */
import type { QChatSendInput } from './nim-qchat'

import { randomUUID } from 'node:crypto'

/** 发言者资料快照（ext.user；字段口径对齐参考实现的 buildExtension） */
export interface RoomSenderProfile {
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

/** 被回复消息摘要（回复态 attachment 用） */
export interface RoomReplyTarget {
  msgIdClient: string
  senderName: string
  text: string
  giftInfo?: Record<string, unknown>
}

/** 清洗正文：剔除控制符（保留 \t \n \r，口径同参考实现）并 trim；空正文视为无内容 */
export function normalizeRoomText(value: string): string {
  const kept = Array.from(String(value || '')).filter((char) => {
    const code = char.codePointAt(0) ?? 0
    return (code >= 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) && code !== 0x7F
  })
  return kept.join('').trim()
}

/** ext：发言者资料快照（口袋客户端自己拼的那份 JSON，channelRole/bubbleId 恒默认） */
export function buildRoomSenderExt(profile: RoomSenderProfile): string {
  return JSON.stringify({
    module: 'QCHAT',
    channelRole: '0',
    user: {
      userId: profile.userId,
      nickName: profile.nickname,
      teamLogo: profile.teamLogo,
      avatar: profile.avatar,
      level: profile.level,
      roleId: profile.roleId,
      vip: profile.vip,
      pfUrl: profile.pfUrl,
      ...(profile.badge.length ? { badge: profile.badge } : {}),
    },
    bubbleId: '0',
  })
}

/** 客户端消息 ID：UUID 去横杠（32 位 hex），发送 ACK 与历史列表都靠它对齐 */
export function newMsgIdClient(): string {
  return randomUUID().replace(/-/g, '')
}

/** 组装发送入参：纯文本走 body；回复走 attachment（custom，正文放 replyInfo.text） */
export function buildRoomSendInput(input: {
  serverId: string
  channelId: string
  text: string
  reply?: RoomReplyTarget | null
  profile: RoomSenderProfile
}): QChatSendInput {
  const text = normalizeRoomText(input.text)
  if (!text)
    throw new Error('请输入消息内容')
  const base = {
    serverId: input.serverId,
    channelId: input.channelId,
    ext: buildRoomSenderExt(input.profile),
    msgIdClient: newMsgIdClient(),
  }
  if (!input.reply)
    return { ...base, type: 'text', body: text }
  const replyMessageId = String(input.reply.msgIdClient || '').trim()
  if (!replyMessageId)
    throw new Error('缺少被回复消息 ID')
  const replyName = String(input.reply.senderName || '').trim() || '用户'
  const replyText = normalizeRoomText(input.reply.text)
  const hasGift = !!input.reply.giftInfo && typeof input.reply.giftInfo === 'object'
  const replyInfo: Record<string, unknown> = {
    replyName,
    replyText,
    replyMessageId,
    ...(hasGift ? { giftInfo: input.reply.giftInfo } : {}),
    text,
  }
  return {
    ...base,
    type: 'custom',
    attachment: JSON.stringify(hasGift
      ? { giftReplyInfo: replyInfo, messageType: 'GIFTREPLY' }
      : { replyInfo, messageType: 'REPLY' }),
  }
}
