import { describe, expect, it } from 'vitest'
/**
 * 房间频道消息归一化（pocket-room-message.ts）：
 * CustomMessageV2 → PocketRoomMessageView，覆盖 msgType 分支、extInfo 解析与兜底；
 * 左列最新消息预览（lastMsgList.msgContent → 文案）与消息流共用同一套类型分发。
 */

import { liveShareTitle, normalizePocketRoomMessage, normalizePocketRoomPreview } from '../src/renderer/src/utils/pocket-room-message'

/** 构造一条房间消息：extInfo.bodys 可传对象（自动 JSON 化） */
function roomMessage(msgType: string, options: {
  bodys?: unknown
  user?: Record<string, unknown>
  msgIdClient?: string
  msgTime?: number
  extUser?: Record<string, unknown>
} = {}) {
  return {
    msgIdServer: '100',
    msgIdClient: options.msgIdClient ?? 'c-1',
    msgType,
    msgTime: options.msgTime ?? 1728000000000,
    bodys: typeof options.bodys === 'string' ? options.bodys : JSON.stringify(options.bodys ?? {}),
    extInfo: JSON.stringify({ user: options.extUser ?? { userId: 42, nickName: '粉丝甲', avatar: '/a.jpg', level: 12 } }),
  }
}

describe('pocket-room-message / 文本与多媒体', () => {
  it('text 类型 bodys 为纯文本时直接作正文', () => {
    const view = normalizePocketRoomMessage(roomMessage('TEXT', { bodys: '大家晚安' }))!
    expect(view.kind).toBe('text')
    expect(view.text).toBe('大家晚安')
    expect(view.nick).toBe('粉丝甲')
    expect(view.userId).toBe('42')
    expect(view.level).toBe(12)
    expect(view.isMember).toBe(false)
  })

  it('text 类型 bodys 为 JSON 时取 text 字段', () => {
    const view = normalizePocketRoomMessage(roomMessage('TEXT', { bodys: { text: 'JSON 正文' } }))!
    expect(view.text).toBe('JSON 正文')
  })

  it('image/expressimage/audio/video 占位文案', () => {
    expect(normalizePocketRoomMessage(roomMessage('IMAGE'))!.text).toBe('[图片消息]')
    expect(normalizePocketRoomMessage(roomMessage('IMAGE'))!.kind).toBe('image')
    expect(normalizePocketRoomMessage(roomMessage('EXPRESSIMAGE'))!.kind).toBe('image')
    expect(normalizePocketRoomMessage(roomMessage('AUDIO'))!.text).toBe('[语音消息]')
    expect(normalizePocketRoomMessage(roomMessage('VIDEO'))!.kind).toBe('video')
  })

  it('image 提取 bodys.url：相对路径补 source.48.cn，完整 URL 原样', () => {
    const relative = normalizePocketRoomMessage(roomMessage('IMAGE', {
      bodys: { url: '/mediasource/image/2026/1014/abc.jpg' },
    }))!
    expect(relative.imageUrl).toBe('https://source.48.cn/mediasource/image/2026/1014/abc.jpg')

    const absolute = normalizePocketRoomMessage(roomMessage('IMAGE', {
      bodys: { url: 'https://source.48.cn/mediasource/x.jpg' },
    }))!
    expect(absolute.imageUrl).toBe('https://source.48.cn/mediasource/x.jpg')
  })

  it('image 提取宽高（字段宽容匹配）供 aspect-ratio 占位；缺省 0', () => {
    const sized = normalizePocketRoomMessage(roomMessage('IMAGE', {
      bodys: { url: '/a.jpg', imgWidth: 800, imgHeight: 600 },
    }))!
    expect(sized.imageWidth).toBe(800)
    expect(sized.imageHeight).toBe(600)

    const unsized = normalizePocketRoomMessage(roomMessage('IMAGE', { bodys: { url: '/b.jpg' } }))!
    expect(unsized.imageWidth).toBe(0)
    expect(unsized.imageHeight).toBe(0)
  })

  it('expressimage 从 expressImgInfo.emotionRemote 取图', () => {
    const view = normalizePocketRoomMessage(roomMessage('EXPRESSIMAGE', {
      bodys: { expressImgInfo: { emotionRemote: '/emotion/1.png' } },
    }))!
    expect(view.imageUrl).toBe('https://source.48.cn/emotion/1.png')
  })

  it('audio 提取 bodys.url：相对路径补 mp4.48.cn', () => {
    const view = normalizePocketRoomMessage(roomMessage('AUDIO', {
      bodys: { url: '/MediaSource/Voice/2026/1014/xyz.m4a' },
    }))!
    expect(view.audioUrl).toBe('https://mp4.48.cn/MediaSource/Voice/2026/1014/xyz.m4a')
    expect(view.imageUrl).toBe('')
    expect(view.videoUrl).toBe('')
  })

  it('video 提取 url 与封面', () => {
    const view = normalizePocketRoomMessage(roomMessage('VIDEO', {
      bodys: { url: '/MediaSource/Video/2026/1014/v.mp4', coverUrl: '/mediasource/cover/c.jpg' },
    }))!
    expect(view.videoUrl).toBe('https://mp4.48.cn/MediaSource/Video/2026/1014/v.mp4')
    expect(view.videoPoster).toBe('https://source.48.cn/mediasource/cover/c.jpg')
  })

  it('audioReply 从 replyInfo.voiceUrl 取语音', () => {
    const view = normalizePocketRoomMessage(roomMessage('AUDIO_REPLY', {
      bodys: { replyInfo: { replyName: '成员丁', replyText: '听听这个', voiceUrl: '/MediaSource/Voice/a.m4a' } },
    }))!
    expect(view.audioUrl).toBe('https://mp4.48.cn/MediaSource/Voice/a.m4a')
    expect(view.kind).toBe('reply')
  })

  it('flipCardAudio 从 answer JSON 取语音 url', () => {
    const view = normalizePocketRoomMessage(roomMessage('FLIPCARD_AUDIO', {
      bodys: { flipCardAudioInfo: { question: '点歌', answer: JSON.stringify({ url: '/MediaSource/Voice/f.m4a' }) } },
    }))!
    expect(view.audioUrl).toBe('https://mp4.48.cn/MediaSource/Voice/f.m4a')
  })

  it('非媒体类型媒体字段恒空', () => {
    const view = normalizePocketRoomMessage(roomMessage('TEXT', { bodys: '嗨' }))!
    expect(view.imageUrl).toBe('')
    expect(view.audioUrl).toBe('')
    expect(view.videoUrl).toBe('')
    expect(view.videoPoster).toBe('')
  })
})

describe('pocket-room-message / 回复与翻牌', () => {
  it('reply 类型展示 [回复 昵称] 正文', () => {
    const view = normalizePocketRoomMessage(roomMessage('REPLY', {
      bodys: { replyInfo: { replyName: '成员乙', replyText: '谢谢应援', replyMessageId: 'm-1' } },
    }))!
    expect(view.kind).toBe('reply')
    expect(view.text).toBe('[回复 成员乙] 谢谢应援')
  })

  it('giftReply 礼物回复同样归 reply', () => {
    const view = normalizePocketRoomMessage(roomMessage('GIFTREPLY', {
      bodys: { giftReplyInfo: { replyName: '成员丙', text: '收到小心心' } },
    }))!
    expect(view.kind).toBe('reply')
    expect(view.text).toBe('[回复 成员丙] 收到小心心')
  })

  it('audioReply 无文本时兜底语音回复占位', () => {
    const view = normalizePocketRoomMessage(roomMessage('AUDIO_REPLY', {
      bodys: { replyInfo: { replyName: '成员丁' } },
    }))!
    expect(view.kind).toBe('reply')
    expect(view.text).toBe('[语音回复消息]')
  })

  it('flipCard 优先展示答案文本', () => {
    const view = normalizePocketRoomMessage(roomMessage('FLIPCARD', {
      bodys: { flipCardInfo: { answer: '今天也要加油' } },
    }))!
    expect(view.kind).toBe('flip')
    expect(view.text).toBe('今天也要加油')
  })

  it('flipCard 答案为对象时兜底占位', () => {
    const view = normalizePocketRoomMessage(roomMessage('FLIPCARD_VIDEO', {
      bodys: { flipCardVideoInfo: { answer: { nested: true } } },
    }))!
    expect(view.text).toBe('[翻牌回复]')
  })
})

describe('pocket-room-message / 分享、礼物与系统通知', () => {
  it('shareLive 展示 [直播分享] 标题并提取 liveId（jumpPath 正则）/liveType/封面', () => {
    // 真实报文（对齐 yaya_msg 解析）：SHARE_LIVE 无独立 liveId 字段（藏在 jumpPath），封面是 sharePic
    const view = normalizePocketRoomMessage(roomMessage('SHARE_LIVE', {
      bodys: {
        shareInfo: {
          shareTitle: '成员的电台直播',
          sharePic: '/mediasource/share/p.jpg',
          liveType: 2,
          ctime: '1728000000000',
          jumpPath: 'snh48live://live/detail?id=9001&from=room',
        },
      },
    }))!
    expect(view.kind).toBe('live')
    expect(view.text).toBe('[直播分享] 成员的电台直播')
    expect(view.liveId).toBe('9001')
    expect(view.liveType).toBe(2)
    expect(view.liveStartTime).toBe(1728000000000)
    expect(view.liveCover).toBe('https://source.48.cn/mediasource/share/p.jpg')
    expect(view.liveIsPlayback).toBe(false)
  })

  it('livePush 提取封面（相对路径补 source.48.cn）与录屏标记', () => {
    const view = normalizePocketRoomMessage(roomMessage('LIVEPUSH', {
      bodys: {
        livePushInfo: {
          shareTitle: '小猫咪来了',
          liveId: '9002',
          liveType: 1,
          liveMode: 1,
          liveCover: '/mediasource/cover/x.jpg',
          ctime: 1728000000000,
        },
      },
    }))!
    expect(view.liveCover).toBe('https://source.48.cn/mediasource/cover/x.jpg')
    expect(view.liveMode).toBe(1)
    expect(view.liveIsPlayback).toBe(false)
  })

  it('review / SHARE_PLAYBACK 标记的分享指向录播/回放', () => {
    const flagged = normalizePocketRoomMessage(roomMessage('SHARE_LIVE', {
      bodys: { shareInfo: { shareTitle: '上次的直播', liveId: '9003', review: 1 } },
    }))!
    expect(flagged.liveIsPlayback).toBe(true)

    const typed = normalizePocketRoomMessage(roomMessage('SHARE_PLAYBACK', {
      bodys: { shareInfo: { shareTitle: '回放来了', liveId: '9004' } },
    }))!
    expect(typed.kind).toBe('live')
    expect(typed.liveIsPlayback).toBe(true)
  })

  it('shareLive 缺分享正文时 liveId 为空（卡片降级为只读）', () => {
    const view = normalizePocketRoomMessage(roomMessage('OPEN_LIVE', {
      bodys: { livePushInfo: { shareTitle: '只有标题' } },
    }))!
    expect(view.text).toBe('[直播分享] 只有标题')
    expect(view.liveId).toBe('')
    expect(view.liveType).toBe(0)
    expect(view.liveStartTime).toBe(0)
  })

  it('liveShareTitle 剥掉 [直播分享] 前缀；无标题返回空串', () => {
    expect(liveShareTitle('[直播分享] 小猫咪来了')).toBe('小猫咪来了')
    expect(liveShareTitle('[直播分享]')).toBe('')
  })

  it('presentNormal 展示礼物名与数量', () => {
    const view = normalizePocketRoomMessage(roomMessage('PRESENT_NORMAL', {
      bodys: { giftInfo: { giftName: '小心心', giftNum: 3 } },
    }))!
    expect(view.kind).toBe('gift')
    expect(view.text).toBe('[礼物] 小心心 x3')
  })

  it('disableSpeak/closeRoomChat 归为系统通知', () => {
    expect(normalizePocketRoomMessage(roomMessage('DISABLE_SPEAK'))!.kind).toBe('system')
    expect(normalizePocketRoomMessage(roomMessage('CLOSE_ROOM_CHAT'))!.text).toBe('[房间聊天已关闭]')
  })

  it('delete 删除通知不展示，返回 null', () => {
    expect(normalizePocketRoomMessage(roomMessage('DELETE'))).toBeNull()
  })
})

describe('pocket-room-message / 发送者与兜底', () => {
  it('extInfo.user 提供成员标识（roleId > 1）', () => {
    const view = normalizePocketRoomMessage(roomMessage('TEXT', {
      bodys: '嗨',
      extUser: { userId: 7, nickName: '成员甲', level: 30, roleId: 3 },
    }))!
    expect(view.isMember).toBe(true)
    expect(view.nick).toBe('成员甲')
    expect(view.level).toBe(30)
  })

  it('extInfo 缺失时回退顶层 sender 字段', () => {
    const view = normalizePocketRoomMessage({
      msgIdClient: 'c-9',
      msgType: 'TEXT',
      msgTime: 1,
      bodys: '嗨',
      senderUserId: '99',
      senderName: '顶层用户',
    })!
    expect(view.userId).toBe('99')
    expect(view.nick).toBe('顶层用户')
  })

  it('未识别类型：有 text 用 text，无文本兜底 [新消息]', () => {
    expect(normalizePocketRoomMessage(roomMessage('POST_INFO', { bodys: { text: '发了动态' } }))!.text).toBe('发了动态')
    expect(normalizePocketRoomMessage(roomMessage('UNKNOWN_TYPE', { bodys: {} }))!.text).toBe('[新消息]')
  })

  it('去重键优先 msgIdClient，缺失退 msgIdServer / msgTime', () => {
    expect(normalizePocketRoomMessage(roomMessage('TEXT', { bodys: 'x', msgIdClient: 'abc' }))!.id).toBe('abc')
    expect(normalizePocketRoomMessage({
      msgIdServer: 'srv-1',
      msgType: 'TEXT',
      msgTime: 5,
      bodys: 'x',
    })!.id).toBe('srv-1')
    expect(normalizePocketRoomMessage({
      msgType: 'TEXT',
      msgTime: 5,
      bodys: 'x',
    })!.id).toBe('5')
  })

  it('非对象输入不炸', () => {
    expect(normalizePocketRoomMessage(null)?.text).toBe('[新消息]')
    expect(normalizePocketRoomMessage('oops')?.text).toBe('[新消息]')
  })
})

describe('pocket-room-message / 左列最新消息预览', () => {
  it('text 类型：JSON msgContent 取 text 字段', () => {
    expect(normalizePocketRoomPreview(JSON.stringify({ messageType: 'TEXT', text: '大家晚安' }))).toBe('大家晚安')
  })

  it('text 类型：纯文本 msgContent 原样展示', () => {
    expect(normalizePocketRoomPreview('在吗')).toBe('在吗')
  })

  it('多媒体与互动类型走同一套占位文案', () => {
    expect(normalizePocketRoomPreview(JSON.stringify({ messageType: 'IMAGE' }))).toBe('[图片消息]')
    expect(normalizePocketRoomPreview(JSON.stringify({ messageType: 'AUDIO' }))).toBe('[语音消息]')
    expect(normalizePocketRoomPreview(JSON.stringify({
      messageType: 'REPLY',
      replyInfo: { replyName: '甲', replyText: '翻个牌' },
    }))).toBe('[回复 甲] 翻个牌')
    expect(normalizePocketRoomPreview(JSON.stringify({
      messageType: 'GIFT_TEXT',
      giftInfo: { giftName: '荧光棒', giftNum: 3 },
    }))).toBe('[礼物] 荧光棒 x3')
    expect(normalizePocketRoomPreview(JSON.stringify({
      messageType: 'SHARE_LIVE',
      shareInfo: { shareTitle: '深夜电台' },
    }))).toBe('[直播分享] 深夜电台')
    expect(normalizePocketRoomPreview(JSON.stringify({ messageType: 'FLIPCARD', flipCardInfo: { answer: '答好了' } }))).toBe('答好了')
  })

  it('空输入返回空串（UI 决定占位）', () => {
    expect(normalizePocketRoomPreview(null)).toBe('')
    expect(normalizePocketRoomPreview(undefined)).toBe('')
    expect(normalizePocketRoomPreview('')).toBe('')
    expect(normalizePocketRoomPreview('{}')).toBe('[新消息]')
  })
})
