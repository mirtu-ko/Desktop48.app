import type { PocketChatMessage } from '../src/renderer/src/utils/pocket-chat-message'
import { describe, expect, it } from 'vitest'
import { normalizePocketChatMessage, parseMessageExtension } from '../src/renderer/src/utils/pocket-chat-message'

/** 口袋文本弹幕的典型形状：业务扩展整体挂在 custom（JSON 字符串）里 */
function makeTextMessage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text',
    text: '今天也要加油鸭',
    fromNick: '小河',
    custom: JSON.stringify({
      messageType: 'BARRAGE_NORMAL',
      sourceId: '995010563687649280',
      user: { userId: '711741', nickName: '小河' },
    }),
    ...extra,
  }
}

describe('pocket-chat-message.parseMessageExtension', () => {
  it('解析 custom 里的 JSON 扩展', () => {
    const ext = parseMessageExtension(makeTextMessage())
    expect(ext.messageType).toBe('BARRAGE_NORMAL')
    expect((ext.user as Record<string, unknown>).nickName).toBe('小河')
  })

  it('扩展嵌套在 attach.custom 时也能取到', () => {
    const msg = {
      attach: JSON.stringify({ custom: JSON.stringify({ messageType: 'PRESENT_NORMAL', giftInfo: { giftName: '小心心' } }) }),
    }
    const ext = parseMessageExtension(msg)
    expect(ext.messageType).toBe('PRESENT_NORMAL')
  })

  it('多个候选字段合并，后到不覆盖已有键', () => {
    const msg = {
      custom: JSON.stringify({ messageType: 'A', user: { nickName: '甲' } }),
      ext: JSON.stringify({ sourceId: '1' }),
    }
    const ext = parseMessageExtension(msg)
    expect(ext.messageType).toBe('A')
    expect(ext.sourceId).toBe('1')
  })
})

describe('pocket-chat-message.normalizePocketChatMessage', () => {
  it('文本弹幕：取扩展文本与昵称', () => {
    const result = normalizePocketChatMessage(makeTextMessage())
    expect(result).toEqual({ kind: 'barrage', text: '今天也要加油鸭', nick: '小河', userId: '711741' })
  })

  it('付费弹幕（BARRAGE_PAY）与普通弹幕同类', () => {
    const raw = makeTextMessage({ custom: JSON.stringify({ messageType: 'BARRAGE_PAY', text: '冲鸭', user: { nickName: '乙' } }) })
    expect(normalizePocketChatMessage(raw)?.kind).toBe('barrage')
  })

  it('礼物消息：昵称入 nick，正文为「赠送 N × 「礼物名」🎁」', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({
        messageType: 'PRESENT_NORMAL',
        sourceId: '995010563687649280',
        user: { userId: '711741', nickName: '小河' },
        giftInfo: { giftName: '小心心', giftNum: 3 },
      }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.kind).toBe('gift')
    expect(result?.text).toBe('赠送 3 × 「小心心」🎁')
    expect(result?.nick).toBe('小河')
  })

  it('礼物数量缺省按 1', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({
        messageType: 'GIFT_1',
        giftInfo: { giftName: '星愿' },
        user: { nickName: '丙' },
      }),
    }
    expect(normalizePocketChatMessage(msg)?.text).toBe('赠送 1 × 「星愿」🎁')
  })

  it('closeLive 消息归一为系统消息', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'CLOSELIVE' }) }
    expect(normalizePocketChatMessage(msg)).toEqual({ kind: 'system', text: '直播已结束', nick: '', userId: '' })
  })

  it('disableSpeak 类型直接丢弃', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'DISABLE_SPEAK', text: 'x' }) }
    expect(normalizePocketChatMessage(msg)).toBeNull()
  })

  it('liveUpdate 无榜单数据时丢弃', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'LIVEUPDATE', text: 'x' }) }
    expect(normalizePocketChatMessage(msg)).toBeNull()
  })

  it('liveUpdate 榜单归一为 rank 消息（不进气泡，路由榜单面板）', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({
        messageType: 'LIVEUPDATE',
        liveUpdateInfo: {
          liveId: 995010563687649280,
          topList: [
            { user: { userId: 167706829, userName: '许愿大', avatar: 'https://img.example/a.jpg' } },
            { user: { userId: 42, userName: '路人甲' } },
          ],
        },
      }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.kind).toBe('rank')
    expect(result?.rankUsers).toEqual([
      { userId: '167706829', userName: '许愿大', avatar: 'https://img.example/a.jpg' },
      { userId: '42', userName: '路人甲', avatar: '' },
    ])
  })

  it('弹幕扩展带 level 时透传等级，无 level 不携带字段', () => {
    const withLevel = makeTextMessage({ custom: JSON.stringify({ messageType: 'BARRAGE_NORMAL', text: '冲', user: { nickName: '甲', level: 25 } }) })
    const levelResult = normalizePocketChatMessage(withLevel)
    expect(levelResult?.level).toBe(25)

    const withoutLevel = makeTextMessage({ custom: JSON.stringify({ messageType: 'BARRAGE_NORMAL', text: '冲', user: { nickName: '乙' } }) })
    const noLevelResult = normalizePocketChatMessage(withoutLevel)
    expect(noLevelResult?.level).toBeUndefined()
  })

  it('进场消息归一为系统消息：昵称进 nick 字段作作者前缀，正文只留动作', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({
        liveIntoPromptDescribe: '进入了房间',
        user: { userId: '711741', userName: '许愿大' },
      }),
    }
    expect(normalizePocketChatMessage(msg)).toEqual({
      kind: 'system',
      text: '进入了房间',
      nick: '许愿大',
      userId: '711741',
    })
  })

  it('未知类型带正文时以系统消息兜底：昵称进 nick 字段', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({ messageType: 'SHARE_LIVE', text: '分享了直播', user: { userName: '路人乙' } }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.kind).toBe('system')
    expect(result?.text).toBe('分享了直播')
    expect(result?.nick).toBe('路人乙')
  })

  it('liveId 过滤：扩展 sourceId 与当前直播不符的串扰消息丢弃', () => {
    const msg = makeTextMessage()
    expect(normalizePocketChatMessage(msg, '995010563687649280')).not.toBeNull()
    expect(normalizePocketChatMessage(msg, '12345')).toBeNull()
  })

  it('扩展无 sourceId 时不做过滤（部分系统消息不带）', () => {
    const msg = {
      type: 'text',
      text: 'hi',
      custom: JSON.stringify({ messageType: 'BARRAGE_NORMAL' }),
    }
    expect(normalizePocketChatMessage(msg, '12345')).not.toBeNull()
  })

  it('无文本且非礼物的未知类型返回 null', () => {
    expect(normalizePocketChatMessage({ type: 'custom', custom: JSON.stringify({ messageType: 'SOMETHING_ELSE' }) })).toBeNull()
  })

  it('非对象输入返回 null', () => {
    expect(normalizePocketChatMessage(null as unknown as Record<string, unknown>)).toBeNull()
  })
})

describe('pocket-chat-message 兜底字段', () => {
  it('扩展缺 user 时回退 SDK 的 fromNick', () => {
    const msg = { type: 'text', text: '好耶', fromNick: '路人丁' }
    const result: PocketChatMessage | null = normalizePocketChatMessage(msg)
    expect(result?.nick).toBe('路人丁')
  })

  it('扩展 text 缺失时回退 msg.text', () => {
    const msg = { type: 'text', text: '兜底文本', custom: JSON.stringify({ messageType: 'BARRAGE_NORMAL' }) }
    expect(normalizePocketChatMessage(msg)?.text).toBe('兜底文本')
  })
})
