import { describe, expect, it } from 'vitest'
import { normalizeKeyword, segments } from '../src/renderer/src/utils/text-highlight'

describe('normalizeKeyword', () => {
  it('去首尾空白并转小写', () => {
    expect(normalizeKeyword('  ZYG ')).toBe('zyg')
    expect(normalizeKeyword('张 三')).toBe('张 三')
  })

  it('空值返回空串，不抛错', () => {
    expect(normalizeKeyword('')).toBe('')
    expect(normalizeKeyword('   ')).toBe('')
  })
})

describe('segments（文本按关键词切成命中 / 未命中片段）', () => {
  it('文本为空返回空数组（模板据此不渲染）', () => {
    expect(segments(undefined, '张')).toEqual([])
    expect(segments('', '张')).toEqual([])
  })

  it('关键词为空时整段返回且不命中', () => {
    expect(segments('张三', '')).toEqual([{ text: '张三', hit: false }])
    expect(segments('张三', '   ')).toEqual([{ text: '张三', hit: false }])
  })

  it('命中在开头 / 中间 / 结尾都能切对', () => {
    expect(segments('张三', '张')).toEqual([
      { text: '张', hit: true },
      { text: '三', hit: false },
    ])
    expect(segments('张三丰', '三')).toEqual([
      { text: '张', hit: false },
      { text: '三', hit: true },
      { text: '丰', hit: false },
    ])
    expect(segments('张三', '三')).toEqual([
      { text: '张', hit: false },
      { text: '三', hit: true },
    ])
  })

  it('整段命中时只产出一个片段，不留空尾', () => {
    expect(segments('张三', '张三')).toEqual([{ text: '张三', hit: true }])
  })

  it('多次命中逐段切开', () => {
    expect(segments('abab', 'ab')).toEqual([
      { text: 'ab', hit: true },
      { text: 'ab', hit: true },
    ])
    expect(segments('aXbXc', 'x')).toEqual([
      { text: 'a', hit: false },
      { text: 'X', hit: true },
      { text: 'b', hit: false },
      { text: 'X', hit: true },
      { text: 'c', hit: false },
    ])
  })

  it('大小写不敏感匹配，但片段保留原文大小写', () => {
    expect(segments('ZhangSan', 'zhang')).toEqual([
      { text: 'Zhang', hit: true },
      { text: 'San', hit: false },
    ])
  })

  it('关键词里的正则元字符按字面匹配（这就是不用正则拼的原因）', () => {
    // 若走 new RegExp('.'), 每个字符都会命中；下标扫描下只有真正的 '.' 命中
    expect(segments('a.b', '.')).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
    ])
    expect(segments('a*b', '*')).toEqual([
      { text: 'a', hit: false },
      { text: '*', hit: true },
      { text: 'b', hit: false },
    ])
  })

  it('未命中时整段返回', () => {
    expect(segments('张三', '李')).toEqual([{ text: '张三', hit: false }])
  })
})
