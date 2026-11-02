/**
 * 口袋接口 ID 字段的请求体形状。
 *
 * ID 由服务端下发、按字符串透传；仅纯数字且为安全整数才转 number
 * （雪花 ID 会超出 Number.MAX_SAFE_INTEGER 静默丢精度），其余原样发字符串。
 */
export function toApiId(value: string): number | string {
  if (!/^\d+$/.test(value))
    return value
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? numeric : value
}

/**
 * 消息 ID 归一：0 / '0' 与缺失一律视为「无 id」（空串）。
 * 服务端会给无 id 的消息填 0，透传给「按 id 定位」（分割线、未读计数）会命中列表里
 * 第一条 id 为 0 的消息；归一后调用方退回时刻比较。
 */
export function toMessageId(value: unknown): string {
  if (typeof value === 'number')
    return Number.isFinite(value) && value > 0 ? String(value) : ''
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text !== '0' ? text : ''
}
