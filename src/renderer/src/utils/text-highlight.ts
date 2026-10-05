/** 搜索关键词的文本切分（纯函数，可脱离 Electron 单测）。成员页用它把姓名 / 昵称切成命中片段分别着色 */

export interface TextSegment {
  text: string
  /** 该片段是否命中关键词 */
  hit: boolean
}

/** 关键词归一化：去首尾空白 + 转小写（abbr 是小写字母，匹配前必须统一大小写） */
export function normalizeKeyword(value: string): string {
  return (value || '').trim().toLowerCase()
}

/**
 * 把文本按关键词切成「命中 / 未命中」片段：用下标扫描而不是拼正则，关键词来自用户输入，进正则前要转义。
 * 关键词为空时整段返回（hit 全 false），文本为空时返回空数组。
 */
export function segments(text: string | undefined, keyword: string): TextSegment[] {
  const value = text || ''
  const kw = normalizeKeyword(keyword)
  if (!value)
    return []
  if (!kw)
    return [{ text: value, hit: false }]

  const lower = value.toLowerCase()
  const parts: TextSegment[] = []
  let cursor = 0
  let index = lower.indexOf(kw, cursor)
  while (index !== -1) {
    if (index > cursor)
      parts.push({ text: value.slice(cursor, index), hit: false })
    parts.push({ text: value.slice(index, index + kw.length), hit: true })
    cursor = index + kw.length
    index = lower.indexOf(kw, cursor)
  }
  if (cursor < value.length)
    parts.push({ text: value.slice(cursor), hit: false })
  return parts
}
