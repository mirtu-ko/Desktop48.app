/**
 * utils/umami：手动上报的字段清洗。
 *
 * 为什么盯这条：应用以 file:// 加载，umami script 若用字符串形式 track，
 * 会把 location.href（本机安装路径）和空 hostname 原样上报出去。
 * 这里只验证「我们交出去的 payload 是否干净」，不碰 script 自身的行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackEvent, trackPage } from '../src/renderer/src/utils/umami'

/** 装一个假 window：script 自算的默认字段 + 当前 hash 路由 */
function stubUmami(hash = '#/rooms') {
  const payloads: Record<string, any>[] = []
  const track = vi.fn((callback: (props: any) => any) => {
    // 线上 script 的默认字段：file:// 下 hostname 为空串、url 是本机路径
    payloads.push(callback({
      website: 'W',
      screen: '1x1',
      language: 'zh',
      title: 'T',
      hostname: '',
      url: 'file:///Users/test/app/index.html#/rooms',
      referrer: '',
    }))
  })
  vi.stubGlobal('window', {
    umami: { track },
    location: { hash },
  })
  return { payloads, track }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('umami / trackEvent', () => {
  it('url 不含 file://，hostname 固定', () => {
    const { payloads } = stubUmami()
    trackEvent('app:start', { version: '1.0.0' })
    expect(payloads).toHaveLength(1)
    expect(payloads[0].url).toBe('/#/rooms')
    expect(payloads[0].url).not.toContain('file://')
    expect(payloads[0].hostname).toBe('Desktop48.app')
  })

  it('保留 name / data，服务端才能判为自定义事件', () => {
    const { payloads } = stubUmami()
    trackEvent('live:play', { mode: 'all' })
    expect(payloads[0].name).toBe('live:play')
    expect(payloads[0].data).toEqual({ mode: 'all' })
  })

  it('保留 script 自算的必填字段（website 等）', () => {
    const { payloads } = stubUmami()
    trackEvent('app:start', { version: '1.0.0' })
    expect(payloads[0].website).toBe('W')
    expect(payloads[0].screen).toBe('1x1')
  })

  it('url 取当前窗口 hash 路由：播放窗带上查询参数', () => {
    const { payloads } = stubUmami('#/float?kind=live&liveId=1')
    trackEvent('live:play', { mode: 'all' })
    expect(payloads[0].url).toBe('/#/float?kind=live&liveId=1')
  })

  it('hash 为空时回落到根路径', () => {
    const { payloads } = stubUmami('')
    trackEvent('app:start', { version: '1.0.0' })
    expect(payloads[0].url).toBe('/#/')
  })

  it('无 window（离线 / CDN 失败）时静默跳过', () => {
    vi.stubGlobal('window', undefined)
    expect(() => trackEvent('app:start', { version: '1.0.0' })).not.toThrow()
  })
})

describe('umami / trackPage', () => {
  it('url 用传入的 hash 路由，hostname 固定', () => {
    const { payloads } = stubUmami()
    trackPage('/setting')
    expect(payloads[0].url).toBe('/#/setting')
    expect(payloads[0].hostname).toBe('Desktop48.app')
    expect(payloads[0].referrer).toBe('')
  })

  it('referrer 传上一页路由时上报清洗后的 /#/hash，不带 file:// 路径', () => {
    const { payloads } = stubUmami()
    trackPage('/setting', '/rooms/123')
    expect(payloads[0].referrer).toBe('/#/rooms/123')
    expect(payloads[0].referrer).not.toContain('file://')
  })
})
