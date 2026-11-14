import { describe, expect, it } from 'vitest'
import {
  buildPlaybackUrl,
  describeLoadFailure,
  isEndedLiveDetail,
  isLiveEndedMessage,
  isLiveRemovedMessage,
  nextRetryAttempt,
  normalizeCarouselTime,
  pickPreferredStream,
  pickPreferredVodStream,
  resolveCarouselImages,
} from '../src/renderer/src/utils/live-stream'

describe('pickPreferredStream（开放公演流选择）', () => {
  it('优先选高清流（streamType 2）', () => {
    const streams = [
      { streamPath: '/low.flv', streamType: 1 },
      { streamPath: '/hd.flv', streamType: 2 },
    ]
    expect(pickPreferredStream(streams)?.streamPath).toBe('/hd.flv')
  })

  it('无高清时取第一条有地址的流', () => {
    const streams = [
      { streamPath: '', streamType: 2 },
      { streamPath: '/only.flv', streamType: 1 },
    ]
    expect(pickPreferredStream(streams)?.streamPath).toBe('/only.flv')
  })

  it('空列表 / undefined 返回 null', () => {
    expect(pickPreferredStream([])).toBeNull()
    expect(pickPreferredStream(undefined)).toBeNull()
  })
})

describe('pickPreferredVodStream（开放公演回放流选择）', () => {
  it('优先超清（streamType 3），回落高清（2）', () => {
    const streams = [
      { streamPath: '/hd.flv', streamType: 2 },
      { streamPath: '/uhd.flv', streamType: 3 },
    ]
    expect(pickPreferredVodStream(streams)?.streamPath).toBe('/uhd.flv')
    expect(pickPreferredVodStream([
      { streamPath: '/hd.flv', streamType: 2 },
      { streamPath: '/low.flv', streamType: 1 },
    ])?.streamPath).toBe('/hd.flv')
  })

  it('只有无类型流时取第一条有地址的流', () => {
    expect(pickPreferredVodStream([{ streamPath: '/any.flv', streamType: 0 }])?.streamPath).toBe('/any.flv')
  })

  it('全空返回 null', () => {
    expect(pickPreferredVodStream([{ streamPath: '', streamType: 3 }])).toBeNull()
    expect(pickPreferredVodStream(undefined)).toBeNull()
  })
})

describe('buildPlaybackUrl（本地 FLV 播放地址）', () => {
  it('拼接防缓存时间戳与重启序号', () => {
    expect(buildPlaybackUrl('http://127.0.0.1:8080/live/a.flv', 3, 1000)).toBe(
      'http://127.0.0.1:8080/live/a.flv?t=1000&r=3',
    )
  })

  it('默认使用当前时间', () => {
    const url = buildPlaybackUrl('http://x/a.flv', 1)
    expect(url).toMatch(/^http:\/\/x\/a\.flv\?t=\d+&r=1$/)
  })
})

describe('normalizeCarouselTime（轮播间隔归一化）', () => {
  it('合法值原样返回', () => {
    expect(normalizeCarouselTime(8000)).toBe(8000)
    expect(normalizeCarouselTime('6000')).toBe(6000)
  })

  it('缺省 / 非法值回退 5 秒', () => {
    expect(normalizeCarouselTime(undefined)).toBe(5000)
    expect(normalizeCarouselTime(null)).toBe(5000)
    expect(normalizeCarouselTime('')).toBe(5000)
    expect(normalizeCarouselTime('abc')).toBe(5000)
    expect(normalizeCarouselTime(-1)).toBe(5000)
  })
})

describe('resolveCarouselImages（轮播图列表）', () => {
  const toUrl = (u: string) => `https://cdn/${u}`

  it('非电台模式返回空数组', () => {
    expect(resolveCarouselImages(false, ['a.jpg'], 'cover.jpg', toUrl)).toEqual([])
  })

  it('接口返回 carousels 时逐个转 URL', () => {
    expect(resolveCarouselImages(true, ['a.jpg', 'b.jpg'], 'cover.jpg', toUrl)).toEqual([
      'https://cdn/a.jpg',
      'https://cdn/b.jpg',
    ])
  })

  it('无 carousels 时回退封面图单张', () => {
    expect(resolveCarouselImages(true, undefined, 'cover.jpg', toUrl)).toEqual(['https://cdn/cover.jpg'])
    expect(resolveCarouselImages(true, [], '', toUrl)).toEqual([])
  })
})

describe('nextRetryAttempt（重试决策）', () => {
  it('未达上限返回下一次序号', () => {
    expect(nextRetryAttempt(0, 3)).toBe(1)
    expect(nextRetryAttempt(2, 3)).toBe(3)
  })

  it('已达上限返回 null（交给耗尽处理）', () => {
    expect(nextRetryAttempt(3, 3)).toBeNull()
    expect(nextRetryAttempt(4, 3)).toBeNull()
  })
})
describe('直播终结业务文案分流', () => {
  it('两类文案分流：下播进结束卡，删除才关窗', () => {
    expect(isLiveEndedMessage('回放生成中')).toBe(true)
    expect(isLiveEndedMessage('该成员直播已被删除')).toBe(false)
    expect(isLiveRemovedMessage('该成员直播已被删除')).toBe(true)
    expect(isLiveRemovedMessage('回放生成中')).toBe(false)
  })

  it('网络/参数/普通业务错误两类都不命中', () => {
    expect(isLiveEndedMessage('参数错误')).toBe(false)
    expect(isLiveRemovedMessage('参数错误')).toBe(false)
    expect(isLiveEndedMessage('网络请求失败')).toBe(false)
    expect(isLiveRemovedMessage('网络请求失败')).toBe(false)
    expect(isLiveEndedMessage('')).toBe(false)
    expect(isLiveRemovedMessage('')).toBe(false)
  })
})

describe('isEndedLiveDetail（详情状态判决）', () => {
  const streaming = { review: false, playStreamPath: 'rtmp://idol.tv.48.cn/live/abc' }

  it('user 源下播后 review=true 或 VOD 地址判为结束', () => {
    expect(isEndedLiveDetail({ review: true, playStreamPath: 'https://idol-vod.48.cn/a.m3u8' }, 'user')).toBe(true)
    expect(isEndedLiveDetail({ review: true, playStreamPath: 'rtmp://idol.tv.48.cn/live/abc' }, 'user')).toBe(true)
    expect(isEndedLiveDetail({ review: false, playStreamPath: 'https://idol-vod.48.cn/a.m3u8' }, 'user')).toBe(true)
  })

  it('进行中 rtmp + review=false 不判结束', () => {
    expect(isEndedLiveDetail(streaming, 'user')).toBe(false)
  })

  it('地址缺失或异常协议不判结束（留给重试链）', () => {
    expect(isEndedLiveDetail({ review: false, playStreamPath: '' }, 'user')).toBe(false)
    expect(isEndedLiveDetail({ review: false, playStreamPath: 'ftp://x/a.flv' }, 'user')).toBe(false)
  })

  it('open 源恒不判结束（详情归一后 review 恒 true）', () => {
    expect(isEndedLiveDetail({ review: true, playStreamPath: 'https://vod/abc.m3u8' }, 'open')).toBe(false)
    expect(isEndedLiveDetail({ review: true, playStreamPath: 'rtmp://live/abc' }, 'open')).toBe(false)
  })
})

describe('describeLoadFailure（失败卡文案）', () => {
  it('三种来源都有完整文案与操作入口', () => {
    for (const kind of ['stream', 'detail', 'offline'] as const) {
      const view = describeLoadFailure(kind)
      expect(view.title).not.toBe('')
      expect(view.hint).not.toBe('')
      expect(view.action).not.toBe('')
    }
  })

  it('离线单独说明会自动重连，其余两种只给重试入口', () => {
    expect(describeLoadFailure('offline').title).toBe('网络连接已断开')
    expect(describeLoadFailure('offline').hint).toContain('自动')
    expect(describeLoadFailure('stream').title).toBe('直播暂时无法加载')
    expect(describeLoadFailure('detail').hint).toContain('直播信息')
  })
})
