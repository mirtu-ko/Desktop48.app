/** 弹幕文本的表情切分（纯函数，可脱离 Electron 单测）。把 "[热]" 这类占位符切成表情图片段 */
import type { DanmakuEmoteMap } from '../../../common/live-danmaku'

/** 一条弹幕最多替换的表情数，超出部分按原文本显示（防刷屏） */
export const DANMAKU_EMOTE_LIMIT = 9

export type DanmakuSegment
  = | { type: 'text', text: string }
  /** text 为原始占位符，用于 alt 与加载失败兜底 */
    | { type: 'emote', text: string, url: string, width: number, height: number }

/**
 * 按表情表把弹幕文本切成文本 / 表情片段。
 * 下标扫描而非正则：表情名含方括号等特殊字符，且要按最长名优先匹配。
 */
export function splitDanmakuContent(
  content: string,
  emots?: DanmakuEmoteMap,
  limit: number = DANMAKU_EMOTE_LIMIT,
): DanmakuSegment[] {
  if (!content)
    return []
  if (!emots)
    return [{ type: 'text', text: content }]

  // 长名优先：先试 "[比心]" 再试 "[比]"
  const names = Object.keys(emots).sort((a, b) => b.length - a.length)
  if (names.length === 0)
    return [{ type: 'text', text: content }]
  // 只在首字符可能命中时才做完整比对，避免逐字符扫全表
  const heads = new Set(names.map(name => name.charAt(0)))

  const segments: DanmakuSegment[] = []
  let cursor = 0
  let index = 0
  let matched = 0

  while (index < content.length) {
    const name = matched < limit && heads.has(content.charAt(index))
      ? names.find(candidate => content.startsWith(candidate, index))
      : undefined
    const emote = name ? emots[name] : undefined
    if (name && emote) {
      if (index > cursor)
        segments.push({ type: 'text', text: content.slice(cursor, index) })
      segments.push({ type: 'emote', text: name, url: emote.url, width: emote.width, height: emote.height })
      matched += 1
      index += name.length
      cursor = index
      continue
    }
    index += 1
  }

  if (cursor < content.length)
    segments.push({ type: 'text', text: content.slice(cursor) })
  return segments
}
