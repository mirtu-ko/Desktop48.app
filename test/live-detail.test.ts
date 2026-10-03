import type { LiveDetail, OpenLiveDetail } from '../src/renderer/src/services/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLiveDetail } from '../src/renderer/src/services/live-detail'

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

const { liveMock, openLiveMock } = vi.hoisted(() => ({
  liveMock: vi.fn(),
  openLiveMock: vi.fn(),
}))
vi.mock('../src/renderer/src/services/apis', () => ({
  default: { live: liveMock, openLive: openLiveMock },
}))

/** LiveDetail 只需 loader 实际读取的字段 */
function userDetail(extra: Partial<LiveDetail> = {}): LiveDetail {
  return {
    playStreamPath: 'rtmp://live.example/live/a',
    coverPath: '/cover/a.jpg',
    user: { userName: '成员一', userAvatar: '/avatar/1.jpg' },
    review: true,
    ...extra,
  } as LiveDetail
}

/** OpenLiveDetail 只需 loader 实际读取的字段 */
function openDetail(extra: Partial<OpenLiveDetail> = {}): OpenLiveDetail {
  return { liveId: 'open-1', coverPath: '/cover/o.jpg', ...extra } as OpenLiveDetail
}

/** 一路 VOD m3u8，档位齐全 */
const VOD_STREAMS = [
  { streamType: 2, streamPath: 'https://vod.example/2.m3u8' },
  { streamType: 3, streamPath: 'https://vod.example/3.m3u8' },
]

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadLiveDetail（详情加载与归一）', () => {
  describe('user 源（个人直播 / 回放）', () => {
    it('归一单档地址、封面、头像与轮播图', async () => {
      liveMock.mockResolvedValue(userDetail({
        onlineNum: 1234,
        liveType: 2,
        carousels: { carousels: ['/c1.jpg', '/c2.jpg'], carouselTime: 3000 },
        msgFilePath: '/barrage.json',
      }))

      const view = await loadLiveDetail({ liveId: 'a', source: 'user', stream: 'live' })

      expect(view.playStreamPath).toBe('rtmp://live.example/live/a')
      // 接口只给单档地址，没有档位概念
      expect(view.streamType).toBeUndefined()
      expect(view.coverUrl).toBe('https://source.48.cn/cover/a.jpg')
      expect(view.realName).toBe('成员一')
      expect(view.userAvatar).toBe('https://source.48.cn/avatar/1.jpg')
      expect(view.onlineNum).toBe(1234)
      expect(view.carouselImages).toEqual(['https://source.48.cn/c1.jpg', 'https://source.48.cn/c2.jpg'])
      expect(view.carouselTime).toBe(3000)
      expect(view.barrageUrl).toBe('/barrage.json')
      expect(view.review).toBe(true)
    })

    it('不传 startTime 时不重写播放地址；传了才按开播日期改写一直播路径', async () => {
      const yiZhiBo = 'https://alcdn.hls.xiaoka.tv/live/20260905/live.m3u8'
      liveMock.mockResolvedValue(userDetail({ playStreamPath: yiZhiBo }))

      const noRewrite = await loadLiveDetail({ liveId: 'a', source: 'user', stream: 'live' })
      expect(noRewrite.playStreamPath).toBe(yiZhiBo)

      const rewritten = await loadLiveDetail({
        liveId: 'a',
        source: 'user',
        stream: 'live',
        startTime: new Date(2026, 8, 5).getTime(),
      })
      expect(rewritten.playStreamPath).toContain('20260905')
    })

    it('轮播图缺失与非法间隔降级（空数组 / 5000ms）', async () => {
      liveMock.mockResolvedValue(userDetail({ carousels: { carousels: [], carouselTime: 'abc' } }))

      const view = await loadLiveDetail({ liveId: 'a', source: 'user', stream: 'live' })

      expect(view.carouselImages).toEqual([])
      expect(view.carouselTime).toBe(5000)
    })

    it('avatarUrl 缺省时不参与（user 源头像只取详情）', async () => {
      liveMock.mockResolvedValue(userDetail())

      const view = await loadLiveDetail({ liveId: 'a', source: 'user', stream: 'live' })

      expect(view.userAvatar).toBe('https://source.48.cn/avatar/1.jpg')
    })
  })

  describe('open 源（开放公演 / 公演回放）', () => {
    it('stream=live 优先高清 2 档', async () => {
      openLiveMock.mockResolvedValue(openDetail({
        playStreams: [
          { streamType: 3, streamPath: 'https://vod.example/3.m3u8' },
          { streamType: 2, streamPath: 'https://vod.example/2.m3u8' },
        ],
      }))

      const view = await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'live' })

      expect(view.playStreamPath).toBe('https://vod.example/2.m3u8')
      expect(view.streamType).toBe(2)
    })

    it('stream=vod 优先超清 3 档', async () => {
      openLiveMock.mockResolvedValue(openDetail({ playStreams: VOD_STREAMS }))

      const view = await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'vod' })

      expect(view.playStreamPath).toBe('https://vod.example/3.m3u8')
      expect(view.streamType).toBe(3)
    })

    it('没有 3 档时回落到 2 档；全无有效地址时 playStreamPath 为空串', async () => {
      openLiveMock.mockResolvedValue(openDetail({
        playStreams: [{ streamType: 2, streamPath: 'https://vod.example/2.m3u8' }],
      }))
      const fallback = await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'vod' })
      expect(fallback.playStreamPath).toBe('https://vod.example/2.m3u8')

      openLiveMock.mockResolvedValue(openDetail({ playStreams: [{ streamType: 3, streamPath: '' }] }))
      const none = await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'vod' })
      expect(none.playStreamPath).toBe('')
      expect(none.streamType).toBeUndefined()
    })

    it('realName 三级兜底：subTitle → title → 固定文案', async () => {
      openLiveMock.mockResolvedValue(openDetail({ subTitle: '副题', title: '标题' }))
      expect((await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'live' })).realName).toBe('副题')

      openLiveMock.mockResolvedValue(openDetail({ title: '标题' }))
      expect((await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'live' })).realName).toBe('标题')

      openLiveMock.mockResolvedValue(openDetail())
      expect((await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'live' })).realName).toBe('开放公演')
    })

    it('头像只取传入的 avatarUrl；在线人数恒 undefined；review 恒 true', async () => {
      openLiveMock.mockResolvedValue(openDetail({ onlineNum: 999 }))

      const view = await loadLiveDetail({ liveId: 'o', source: 'open', stream: 'live', avatarUrl: '/cover/o.jpg' })

      expect(view.userAvatar).toBe('https://source.48.cn/cover/o.jpg')
      expect(view.onlineNum).toBeUndefined()
      expect(view.review).toBe(true)
    })

    it('open 源不按开播日期重写路径（公演地址由接口直给）', async () => {
      const path = 'https://alcdn.hls.xiaoka.tv/live/20260101/old.m3u8'
      openLiveMock.mockResolvedValue(openDetail({ playStreams: [{ streamType: 3, streamPath: path }] }))

      const view = await loadLiveDetail({
        liveId: 'o',
        source: 'open',
        stream: 'vod',
        startTime: new Date(2026, 8, 5).getTime(),
      })

      expect(view.playStreamPath).toBe(path)
    })
  })

  describe('异常穿透（loader 不得吞异常）', () => {
    it('「直播已终结」业务错误原样上抛，message 不被改写', async () => {
      // 调用方（LivePlayer.recoverStream）靠 isUnavailableLiveMessage 判别后关窗；
      // 在这里吞掉或改写会把可恢复的临时故障当成永久下架
      liveMock.mockRejectedValue(new Error('该成员直播已被删除'))

      await expect(loadLiveDetail({ liveId: 'a', source: 'user', stream: 'live' }))
        .rejects
        .toThrow('该成员直播已被删除')
    })

    it('open 源的接口异常同样原样上抛', async () => {
      openLiveMock.mockRejectedValue(new Error('网络异常'))

      await expect(loadLiveDetail({ liveId: 'o', source: 'open', stream: 'vod' }))
        .rejects
        .toThrow('网络异常')
    })
  })
})
