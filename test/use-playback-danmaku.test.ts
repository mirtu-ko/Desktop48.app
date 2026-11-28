import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlaybackDanmaku } from '../src/renderer/src/composables/use-playback-danmaku'

const { barrageMock, messageMock, trackMock } = vi.hoisted(() => ({
  barrageMock: vi.fn<(url: string) => Promise<string>>(),
  messageMock: vi.fn(),
  trackMock: vi.fn(),
}))

vi.mock('@renderer/services/apis', () => ({
  default: {
    barrage: (url: string) => barrageMock(url),
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: messageMock,
}))

vi.mock('@renderer/utils/umami', () => ({
  trackEvent: trackMock,
}))

beforeEach(() => {
  barrageMock.mockReset()
  messageMock.mockReset()
  trackMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePlaybackDanmaku（切源防覆盖与解析边界）', () => {
  it('按时间升序解析弹幕并丢弃空内容或非法时间行', async () => {
    barrageMock.mockResolvedValueOnce([
      '[00:00:10 ]u2\t后一条',
      '[00:00:02 ]u1\t先一条',
      '[00:00:05 ]u3\t',
      '[invalid ]u4\t坏时间',
    ].join('\n'))

    const dm = usePlaybackDanmaku({ getMedia: () => null })
    dm.barrageUrl.value = 'https://vod.48.cn/a.lrc'

    await dm.ensureBarragesLoaded()

    expect(dm.barrageLoaded.value).toBe(true)
    expect(dm.barrageEntries.value).toEqual([
      { seconds: 2, username: 'u1', content: '先一条' },
      { seconds: 10, username: 'u2', content: '后一条' },
    ])
  })

  it('切源或 resetBarrageSource 后，旧请求的在途回包被序号拦截，不覆盖新源', async () => {
    let resolveOld!: (text: string) => void
    let resolveNew!: (text: string) => void

    barrageMock
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveOld = resolve
      }))
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveNew = resolve
      }))

    const dm = usePlaybackDanmaku({ getMedia: () => null })
    dm.barrageUrl.value = 'https://vod.48.cn/old.lrc'
    const oldLoad = dm.ensureBarragesLoaded()

    dm.resetBarrageSource()
    dm.barrageUrl.value = 'https://vod.48.cn/new.lrc'
    const newLoad = dm.ensureBarragesLoaded()

    resolveNew('[00:00:03 ]newUser\t新回放弹幕')
    await newLoad
    expect(dm.barrageEntries.value.map(item => item.content)).toEqual(['新回放弹幕'])

    resolveOld('[00:00:01 ]oldUser\t旧回放弹幕')
    await oldLoad
    expect(dm.barrageEntries.value.map(item => item.content)).toEqual(['新回放弹幕'])
  })

  it('旧请求在切源后失败，不弹出误报 toast 也不重置新源状态', async () => {
    let rejectOld!: (err: Error) => void
    barrageMock
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
        rejectOld = reject
      }))
      .mockResolvedValueOnce('[00:00:01 ]u\t正常弹幕')

    const dm = usePlaybackDanmaku({ getMedia: () => null })
    dm.barrageUrl.value = 'https://vod.48.cn/old.lrc'
    const oldLoad = dm.ensureBarragesLoaded()

    dm.resetBarrageSource()
    dm.barrageUrl.value = 'https://vod.48.cn/new.lrc'
    await dm.ensureBarragesLoaded()

    rejectOld(new Error('network error'))
    await oldLoad

    expect(messageMock).not.toHaveBeenCalled()
    expect(dm.barrageLoaded.value).toBe(true)
    expect(dm.barrageEntries.value.map(item => item.content)).toEqual(['正常弹幕'])
  })
})
