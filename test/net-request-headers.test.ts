import { describe, expect, it } from 'vitest'
import { mergeAppIdentity, needsAppIdentity } from '../src/main/net-request-headers'

/**
 * 主进程 netRequest 的身份收口：哪些域名报 App 身份、覆盖时谁优先。
 *
 * 背景见 src/main/net-request-headers.ts——境外线路下站点身份打 pocketapi 恒 403，
 * 只有 App 身份（UA + appInfo + pa）才被服务端认同；纯 CDN / 静态资源则刻意不报。
 */
describe('netRequest 身份收口', () => {
  it('只有业务接口报 App 身份，纯 CDN 与静态资源不报', () => {
    // 业务接口：App 域接口 + H5 动态接口
    expect(needsAppIdentity('https://pocketapi.48.cn/live/api/v1/live/getLiveList')).toBe(true)
    expect(needsAppIdentity('https://h5.48.cn/resource/jsonp/allmembers.php?gid=10')).toBe(true)
    // hostname 大小写不敏感
    expect(needsAppIdentity('https://POCKETAPI.48.cn/x')).toBe(true)

    // 纯静态资源 / 媒体 CDN / 站点页面 / 曲库
    expect(needsAppIdentity('https://source.48.cn/mediasource/avatar/1.jpg')).toBe(false)
    expect(needsAppIdentity('https://mp4.48.cn/mediasource/live/1.m3u8')).toBe(false)
    expect(needsAppIdentity('https://live.48.cn/')).toBe(false)
    expect(needsAppIdentity('https://www.cgt48.com/json/music_snh.json')).toBe(false)

    // 解析不了按不需要处理（白名单校验在调用前已完成）
    expect(needsAppIdentity('not a url')).toBe(false)
  })

  it('app 身份覆盖 UA / appInfo / pa，业务头与 Content-Type 保留', () => {
    const merged = mergeAppIdentity(
      { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)', 'Content-Type': 'application/json', 'X-Biz': '1' },
      {
        'User-Agent': 'PocketFans201807/7.1.44_26092001',
        'appInfo': '{"appName":"pocket48"}',
        'pa': 'sig',
        'Content-Type': 'application/json; charset=UTF-8',
      },
    )

    expect(merged['User-Agent']).toBe('PocketFans201807/7.1.44_26092001')
    expect(merged.appInfo).toBe('{"appName":"pocket48"}')
    expect(merged.pa).toBe('sig')
    // Content-Type 描述请求体，由调用方决定，身份头不覆盖
    expect(merged['Content-Type']).toBe('application/json')
    expect(merged['X-Biz']).toBe('1')
  })

  it('键名大小写不同也只留一份，且取身份值', () => {
    const merged = mergeAppIdentity({ 'user-agent': 'browser' }, { 'User-Agent': 'app' })

    expect(Object.keys(merged).filter(key => key.toLowerCase() === 'user-agent')).toEqual(['User-Agent'])
    expect(merged['User-Agent']).toBe('app')
  })

  it('调用方没有请求头时直接返回身份头', () => {
    expect(mergeAppIdentity(undefined, { pa: 'sig' })).toEqual({ pa: 'sig' })
  })
})
