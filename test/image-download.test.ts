import { describe, expect, it } from 'vitest'
import { pickFileName } from '../src/renderer/src/utils/image-download'

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

  it('替换 Windows 非法字符', () => {
    expect(pickFileName('https://source.48.cn/a<b>c.png')).toBe('a_b_c.png')
  })
})
