import { describe, expect, it } from 'vitest'
import { parseStreamRequestPath } from '../src/main/stream-request-path'

/** 本地流媒体服务的请求路径解析：畸形输入必须降级为 null，不能把异常抛到请求回调顶层 */

describe('parseStreamRequestPath', () => {
  it('解析普通直播路径', () => {
    expect(parseStreamRequestPath('/live/123.flv')).toBe('/live/123.flv')
  })

  it('解码百分号转义', () => {
    expect(parseStreamRequestPath('/live/a%20b.flv')).toBe('/live/a b.flv')
  })

  it('请求目标为空时回退到根路径', () => {
    expect(parseStreamRequestPath(undefined)).toBe('/')
    expect(parseStreamRequestPath('')).toBe('/')
  })

  it('畸形转义返回 null（不抛 URIError）', () => {
    expect(parseStreamRequestPath('/live/%E0%A4%A.flv')).toBeNull()
    expect(parseStreamRequestPath('/live/%ZZ.flv')).toBeNull()
    expect(parseStreamRequestPath('/live/%.flv')).toBeNull()
  })

  it('绝对形式的非法请求目标返回 null（不抛 TypeError）', () => {
    expect(parseStreamRequestPath('http://[invalid/live/123.flv')).toBeNull()
  })
})
