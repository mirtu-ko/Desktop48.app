/**
 * 搜索关键词的文本切分（纯函数：无状态、无 DOM，可脱离 Electron 直接单测）。
 *
 * 成员页把姓名 / 昵称按关键词切成「命中 / 未命中」片段，交给模板分别着色。
 */

export interface TextSegment {
  text: string
  /** 该片段是否命中关键词 */
  hit: boolean
}

/**
 * 关键词归一化：去首尾空白 + 转小写。
 * 拼音缩写（abbr）是小写字母，匹配前必须统一大小写；
 * 归一化只在入口做一次，下游一律拿归一化后的值比较。
 */
export function normalizeKeyword(value: string): string {
  return (value || '').trim().toLowerCase()
}

/**
 * 把文本按关键词切成「命中 / 未命中」片段。
 *
 * 用下标扫描而不是拼正则：关键词来自用户输入，进正则前要先转义，
 * 漏一处就会把 `.` `*` 之类当成元字符。下标扫描从根上绕开了这个问题。
 * 关键词为空时整段返回（hit 全 false），文本为空时返回空数组（不渲染）。
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
