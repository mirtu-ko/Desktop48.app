import type { DanmakuEmoteMap } from '../src/common/live-danmaku'
import { describe, expect, it } from 'vitest'
import { DANMAKU_EMOTE_LIMIT, splitDanmakuContent } from '../src/renderer/src/utils/danmaku-content'

/** 造表情表：名字按序编号，便于断言命中的是哪一个 */
function makeEmotes(...names: string[]): DanmakuEmoteMap {
  const map: DanmakuEmoteMap = {}
  names.forEach((name, index) => {
    map[name] = { url: `https://cdn/${index}.png`, width: 20, height: 20 }
  })
  return map
}

/** 便于断言的紧凑形态 */
function kinds(segments: { type: string }[]) {
  return segments.map(segment => segment.type)
}

describe('splitDanmakuContent / 基础切分', () => {
  it('空文本返回空数组', () => {
    expect(splitDanmakuContent('', makeEmotes('[热]'))).toEqual([])
  })

  it('没有表情表时整条作为文本', () => {
    expect(splitDanmakuContent('白花300块[热]')).toEqual([{ type: 'text', text: '白花300块[热]' }])
  })

  it('表情表为空对象时整条作为文本', () => {
    expect(splitDanmakuContent('白花300块[热]', {})).toEqual([{ type: 'text', text: '白花300块[热]' }])
  })

  it('纯文本不含表情时只有一段文本', () => {
    expect(splitDanmakuContent('晚上好', makeEmotes('[热]'))).toEqual([{ type: 'text', text: '晚上好' }])
  })

  it('夹在文本中间的表情切出三段，emote 片段带原占位符与尺寸', () => {
    const segments = splitDanmakuContent('白花300块[热]真香', makeEmotes('[热]'))

    expect(kinds(segments)).toEqual(['text', 'emote', 'text'])
    expect(segments[0]).toEqual({ type: 'text', text: '白花300块' })
    expect(segments[1]).toEqual({ type: 'emote', text: '[热]', url: 'https://cdn/0.png', width: 20, height: 20 })
    expect(segments[2]).toEqual({ type: 'text', text: '真香' })
  })

  it('整条就是一个表情时不产出空文本片段', () => {
    const segments = splitDanmakuContent('[比心]', makeEmotes('[比心]'))

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'emote', text: '[比心]' })
  })

  it('表情在开头 / 结尾时只切出两段', () => {
    expect(kinds(splitDanmakuContent('[热]好', makeEmotes('[热]')))).toEqual(['emote', 'text'])
    expect(kinds(splitDanmakuContent('好[热]', makeEmotes('[热]')))).toEqual(['text', 'emote'])
  })

  it('连续两个表情切出两个 emote 片段', () => {
    expect(kinds(splitDanmakuContent('[热][比心]', makeEmotes('[热]', '[比心]')))).toEqual(['emote', 'emote'])
  })

  it('同一表情出现多次全部替换', () => {
    expect(kinds(splitDanmakuContent('[热]好[热]', makeEmotes('[热]')))).toEqual(['emote', 'text', 'emote'])
  })
})

describe('splitDanmakuContent / 不猜与容错', () => {
  it('文本里的方括号名不在表情表内时原样保留（绝不猜）', () => {
    expect(splitDanmakuContent('好[不存在]', makeEmotes('[热]')))
      .toEqual([{ type: 'text', text: '好[不存在]' }])
  })

  it('表情表里有但文本里没出现的不产出片段', () => {
    expect(kinds(splitDanmakuContent('晚上好', makeEmotes('[热]', '[比心]')))).toEqual(['text'])
  })

  it('最长名优先：短名是长名前缀时取长的那个', () => {
    const segments = splitDanmakuContent('[比心]', makeEmotes('[比]', '[比心]'))

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'emote', text: '[比心]' })
  })

  it('表情名含正则元字符也按字面量匹配（下标扫描而非正则）', () => {
    const segments = splitDanmakuContent('a[b.c]+d', makeEmotes('[b.c]+'))

    expect(segments[1]).toEqual({ type: 'emote', text: '[b.c]+', url: 'https://cdn/0.png', width: 20, height: 20 })
    expect(segments[2]).toEqual({ type: 'text', text: 'd' })
  })

  it('未闭合的方括号不吞掉后面的文本', () => {
    expect(splitDanmakuContent('好[热', makeEmotes('[热]'))).toEqual([{ type: 'text', text: '好[热' }])
  })
})

describe('splitDanmakuContent / 表情数量上限', () => {
  it('超出上限的部分按原文本显示，前面的照常替换', () => {
    const segments = splitDanmakuContent('[热]'.repeat(DANMAKU_EMOTE_LIMIT + 2), makeEmotes('[热]'))

    expect(segments.filter(segment => segment.type === 'emote')).toHaveLength(DANMAKU_EMOTE_LIMIT)
    // 反向验证：去掉 limit 判断后这里会变成两个 emote 片段
    expect(segments[segments.length - 1]).toEqual({ type: 'text', text: '[热][热]' })
  })

  it('上限可显式传入', () => {
    const segments = splitDanmakuContent('[热][热][热]', makeEmotes('[热]'), 1)

    expect(kinds(segments)).toEqual(['emote', 'text'])
  })

  it('上限为 0 时整条退回文本', () => {
    expect(splitDanmakuContent('[热]好', makeEmotes('[热]'), 0)).toEqual([{ type: 'text', text: '[热]好' }])
  })
})
