import type { RoomSenderProfile } from '../src/main/pocket48/room-message-payload'
import { describe, expect, it } from 'vitest'
import {
  buildRoomSenderExt,
  buildRoomSendInput,
  newMsgIdClient,
  normalizeRoomText,

} from '../src/main/pocket48/room-message-payload'

/**
 * 房间发送入参构造（主进程）：正文清洗、发言者快照 ext、纯文本 / 回复 / 礼物回复
 * 三种报文形状。属性表层的字段号映射见 test/nim-qchat.test.ts。
 */

const profile: RoomSenderProfile = {
  userId: '999',
  nickname: '我',
  avatar: '/avatar.jpg',
  level: 12,
  roleId: 0,
  vip: false,
  pfUrl: '',
  teamLogo: '',
  badge: [],
}

describe('room-message-payload / 正文清洗', () => {
  it('剔除控制符（保留 \\t \\n \\r）并 trim', () => {
    expect(normalizeRoomText(' 大家\u0000晚安\u0007 ')).toBe('大家晚安')
    expect(normalizeRoomText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('空 / 纯空白视为无内容', () => {
    expect(normalizeRoomText('')).toBe('')
    expect(normalizeRoomText('   \n  ')).toBe('')
    expect(normalizeRoomText(undefined as unknown as string)).toBe('')
  })
})

describe('room-message-payload / 发言者快照 ext', () => {
  it('ext.user 带全字段，channelRole/bubbleId 恒默认', () => {
    const ext = JSON.parse(buildRoomSenderExt({ ...profile, roleId: 3, vip: true }))

    expect(ext.module).toBe('QCHAT')
    expect(ext.channelRole).toBe('0')
    expect(ext.bubbleId).toBe('0')
    expect(ext.user).toMatchObject({
      userId: '999',
      nickName: '我',
      avatar: '/avatar.jpg',
      level: 12,
      roleId: 3,
      vip: true,
    })
  })

  it('badge 空数组时省略该字段（不为空徽章位发一个空数组）', () => {
    expect(JSON.parse(buildRoomSenderExt(profile)).user.badge).toBeUndefined()
    expect(JSON.parse(buildRoomSenderExt({ ...profile, badge: ['年度'] })).user.badge).toEqual(['年度'])
  })
})

describe('room-message-payload / newMsgIdClient', () => {
  it('uUID 去横杠：32 位 hex，两次生成不同', () => {
    const id = newMsgIdClient()

    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(newMsgIdClient()).not.toBe(id)
  })
})

describe('room-message-payload / 发送入参构造', () => {
  const base = { serverId: '111', channelId: '222', profile }

  it('纯文本：type=text、正文进 body、不带附件', () => {
    const input = buildRoomSendInput({ ...base, text: '大家晚安' })

    expect(input.type).toBe('text')
    expect(input.body).toBe('大家晚安')
    expect(input.attachment).toBeUndefined()
    expect(input.serverId).toBe('111')
    expect(input.channelId).toBe('222')
    expect(input.ext).toContain('"module":"QCHAT"')
    expect(input.msgIdClient).toMatch(/^[0-9a-f]{32}$/)
  })

  it('空正文：直接抛错（不进协议层）', () => {
    expect(() => buildRoomSendInput({ ...base, text: '   ' })).toThrow('请输入消息内容')
  })

  it('回复：type=custom、附件为 { replyInfo, messageType: REPLY }', () => {
    const input = buildRoomSendInput({
      ...base,
      text: '不客气～',
      reply: { msgIdClient: 'orig-1', senderName: '成员甲', text: '谢谢应援' },
    })

    expect(input.type).toBe('custom')
    expect(input.body).toBeUndefined()
    const attachment = JSON.parse(input.attachment!)
    expect(attachment.messageType).toBe('REPLY')
    expect(attachment.replyInfo).toEqual({
      replyName: '成员甲',
      replyText: '谢谢应援',
      replyMessageId: 'orig-1',
      text: '不客气～',
    })
  })

  it('礼物回复：附件走 giftReplyInfo 且 messageType=GIFTREPLY', () => {
    const input = buildRoomSendInput({
      ...base,
      text: '收到小心心',
      reply: {
        msgIdClient: 'orig-2',
        senderName: '成员乙',
        text: '送你花花',
        giftInfo: { giftName: '小心心', giftNum: 3 },
      },
    })

    const attachment = JSON.parse(input.attachment!)
    expect(attachment.messageType).toBe('GIFTREPLY')
    expect(attachment.giftReplyInfo).toEqual({
      replyName: '成员乙',
      replyText: '送你花花',
      replyMessageId: 'orig-2',
      giftInfo: { giftName: '小心心', giftNum: 3 },
      text: '收到小心心',
    })
  })

  it('回复缺被回复消息 ID：抛错（服务端无法关联原消息）', () => {
    expect(() => buildRoomSendInput({
      ...base,
      text: '试试',
      reply: { msgIdClient: '', senderName: '甲', text: '原消息' },
    })).toThrow('缺少被回复消息 ID')
  })

  it('回复缺昵称兜底「用户」，被引用正文同样过清洗', () => {
    const input = buildRoomSendInput({
      ...base,
      text: '好的',
      reply: { msgIdClient: 'orig-3', senderName: '  ', text: ' 原消息\u0000 ' },
    })
    const attachment = JSON.parse(input.attachment!)

    expect(attachment.replyInfo.replyName).toBe('用户')
    expect(attachment.replyInfo.replyText).toBe('原消息')
  })
})
