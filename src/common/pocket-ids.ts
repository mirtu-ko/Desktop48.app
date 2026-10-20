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
