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

  it('closeLive 归一为下播系统消息（宿主关播，不进气泡层）', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'CLOSELIVE' }) }
    expect(normalizePocketChatMessage(msg)).toEqual({ kind: 'system', text: '直播已结束', nick: '', userId: '', liveEnd: true })
  })

  it('informPullStream 归一为换流信号（宿主拉详情重建，不进气泡层）', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'INFORM_PULL_STREAM', pullStream: 'rtmp://x' }) }
    expect(normalizePocketChatMessage(msg)).toEqual({ kind: 'system', text: '', nick: '', userId: '', liveRestream: true })
  })

  it('连麦/PK 其余消息静默丢弃（官方交 cohost 模块，不进消息流）', () => {
    for (const messageType of ['MICROPHONE_CONNECTION_AGREE_V2', 'MULTI_MIC_PK_START', 'MULTI_MIC_PK_SCORE', 'SETTLEMENT_HOST_EXIT']) {
      const msg = { type: 'custom', custom: JSON.stringify({ messageType, text: 'x' }) }
      expect(normalizePocketChatMessage(msg), messageType).toBeNull()
    }
  })

  it('disableSpeak 归一为禁言系统消息（宿主门控后提示 + 重取详情）', () => {
    const msg = { type: 'custom', custom: JSON.stringify({ messageType: 'DISABLE_SPEAK', text: 'x' }) }
    // opType/operatorType 缺失：保守按禁言 + 成员操作（报文未实测，保功能优先）
    expect(normalizePocketChatMessage(msg)).toEqual({
      kind: 'system',
      text: '你已被禁言',
      nick: '',
      userId: '',
      disableSpeak: { op: 1, operatorType: 1, operatorId: '', targetId: '' },
    })
  })

  it('disableSpeak opType=2 归一为拉黑（宿主关播，不重取详情）', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({
        messageType: 'DISABLE_SPEAK',
        opType: 2,
        operatorType: '2',
        operatorId: 167706829,
      }),
    }
    expect(normalizePocketChatMessage(msg)?.disableSpeak).toEqual({ op: 2, operatorType: 2, operatorId: '167706829', targetId: '' })
    expect(normalizePocketChatMessage(msg)?.text).toBe('你已被拉黑')
  })

  it('disableSpeak opType=3 归一为踢出（官方消息版唯一动作：targetId==本人时关播）', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({ messageType: 'DISABLE_SPEAK', opType: 3, targetId: 12345 }),
    }
    expect(normalizePocketChatMessage(msg)?.disableSpeak).toEqual({ op: 3, operatorType: 1, operatorId: '', targetId: '12345' })
    expect(normalizePocketChatMessage(msg)?.text).toBe('你已经被踢出直播间')
  })

  it('liveUpdate 无榜单无实时字段时丢弃', () => {
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
          online: 159,
          allMoney: 12034,
          topList: [
            { user: { userId: 167706829, userName: '许愿大', avatar: 'https://img.example/a.jpg' } },
            { user: { userId: 42, userName: '路人甲' } },
            // 榜单实测报文（2026-10-14）：头像字段为 userAvatar 且为相对路径
            { user: { userId: 859171, userName: '阿琂是谁🍥', userAvatar: '/avatar/2026/0601/859171.jpg', level: 16 } },
            // 榜单实测报文（2026-10）：level 在 user 里，money 在条目顶层，vip/badgeList 等冗余字段忽略
            { user: { userId: 8050966600, userName: '嘉木相思·木子', userAvatar: '/avatar/2026/0725/8050966600.jpg', level: 13, vip: true, badgeList: ['/mediasource/a.png'], nameplateList: [] }, money: 20 },
          ],
        },
      }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.kind).toBe('rank')
    expect(result?.liveOnline).toBe(159)
    expect(result?.liveAllMoney).toBe(12034)
    expect(result?.rankUsers).toEqual([
      { userId: '167706829', userName: '许愿大', avatar: 'https://img.example/a.jpg' },
      { userId: '42', userName: '路人甲', avatar: '' },
      { userId: '859171', userName: '阿琂是谁🍥', avatar: '/avatar/2026/0601/859171.jpg', level: 16 },
      { userId: '8050966600', userName: '嘉木相思·木子', avatar: '/avatar/2026/0725/8050966600.jpg', level: 13, money: 20 },
    ])
  })

  it('liveUpdate 只有实时字段（无榜单）时也下发：在线人数与礼物流水独立于榜单变化', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({ messageType: 'LIVEUPDATE', liveUpdateInfo: { liveId: 1, online: 165, topList: [] } }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.kind).toBe('rank')
    expect(result?.liveOnline).toBe(165)
    expect(result?.liveAllMoney).toBeUndefined()
    expect(result?.rankUsers).toEqual([])
  })

  it('liveUpdate 实时字段为数字字符串时也能解析', () => {
    const msg = {
      type: 'custom',
      custom: JSON.stringify({ messageType: 'LIVEUPDATE', liveUpdateInfo: { online: '238', allMoney: '0' } }),
    }
    const result = normalizePocketChatMessage(msg)
    expect(result?.liveOnline).toBe(238)
    expect(result?.liveAllMoney).toBe(0)
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
