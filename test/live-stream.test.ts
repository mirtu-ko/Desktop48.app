import { describe, expect, it } from 'vitest'
import {
  buildPlaybackUrl,
  isUnavailableLiveMessage,
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

  it('已达上限返回 null（走直播结束分支）', () => {
    expect(nextRetryAttempt(3, 3)).toBeNull()
    expect(nextRetryAttempt(4, 3)).toBeNull()
  })
})
describe('isUnavailableLiveMessage（直播终结业务文案判定）', () => {
  it('命中已列出的直播终结文案', () => {
    expect(isUnavailableLiveMessage('回放生成中')).toBe(true)
    expect(isUnavailableLiveMessage('该成员直播已被删除')).toBe(true)
  })

  it('网络/参数/普通业务错误不视为终结', () => {
    expect(isUnavailableLiveMessage('参数错误')).toBe(false)
    expect(isUnavailableLiveMessage('网络请求失败')).toBe(false)
    expect(isUnavailableLiveMessage('')).toBe(false)
  })
})
