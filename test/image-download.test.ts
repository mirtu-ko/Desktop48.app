import { describe, expect, it } from 'vitest'
import { buildAlbumFileName, isSmallImage, pickFileName } from '../src/renderer/src/utils/image-download'

describe('pickFileName', () => {
  it('取 URL 末段并丢掉 query', () => {
    expect(pickFileName('https://source.48.cn/xxx/abc.jpg?x-oss-process=resize,w_200'))
      .toBe('abc.jpg')
  })

  it('末段无扩展名时用 content-type 补全', () => {
    expect(pickFileName('https://source.48.cn/xxx/abc', 'image/jpeg'))
      .toBe('abc.jpg')
    expect(pickFileName('https://source.48.cn/xxx/abc.png', 'application/octet-stream'))
      .toBe('abc.png')
  })

  it('已有扩展名则尊重原样，不被 content-type 覆盖', () => {
    expect(pickFileName('https://source.48.cn/a.webp', 'image/jpeg')).toBe('a.webp')
  })

  it('content-type 带 charset 也能识别', () => {
    expect(pickFileName('https://source.48.cn/a', 'image/png; charset=utf-8')).toBe('a.png')
  })

  it('末段为空（以 / 结尾）退化为时间戳名', () => {
    expect(pickFileName('https://source.48.cn/xxx/', 'image/gif')).toMatch(/^image-\d+\.gif$/)
  })

  it('非法 URL 不抛异常，退化为时间戳名', () => {
    expect(pickFileName('not a url')).toMatch(/^image-\d+$/)
  })

  it('末段为 . 或 .. 时不把它当作文件名', () => {
    expect(pickFileName('https://source.48.cn/foo/.')).toMatch(/^image-\d+$/)
    expect(pickFileName('https://source.48.cn/foo/..')).toMatch(/^image-\d+$/)
  })

  it('替换 Windows 非法字符', () => {
    expect(pickFileName('https://source.48.cn/a<b>c.png')).toBe('a_b_c.png')
  })
})

describe('isSmallImage', () => {
  it('任一短边小于阈值即视为小图', () => {
    expect(isSmallImage(239, 1200)).toBe(true)
    expect(isSmallImage(1200, 239)).toBe(true)
    expect(isSmallImage(240, 1200)).toBe(false)
  })

  it('尺寸未知时不误判为小图', () => {
    expect(isSmallImage(0, 0)).toBe(false)
    expect(isSmallImage(undefined, 1200)).toBe(false)
  })
})

describe('buildAlbumFileName', () => {
  it('按消息时间、昵称、原始尺寸与序号生成可读文件名', () => {
    const timestamp = new Date(2026, 9, 22, 21, 55, 44).getTime()
    expect(buildAlbumFileName({
      timestamp,
      nickname: '粉丝/甲',
      width: 1200,
      height: 1600,
      sequence: 3,
      url: 'https://source.48.cn/mediasource/opaque-id',
      contentType: 'image/jpeg',
    })).toBe('粉丝_甲_20261022-215544_1200x1600_03.jpg')
  })

  it('尺寸未知时省略尺寸段，并优先保留 URL 扩展名', () => {
    const timestamp = new Date(2026, 9, 22, 21, 55, 44).getTime()
    expect(buildAlbumFileName({
      timestamp,
      nickname: '用户',
      sequence: 12,
      url: 'https://source.48.cn/a.webp?x-oss-process=resize',
      contentType: 'image/jpeg',
    })).toBe('用户_20261022-215544_12.webp')
  })
})
