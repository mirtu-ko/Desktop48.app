/**
 * 口袋接口 ID 字段的请求体形状。
 *
 * 频道 / server 的 ID 由服务端下发、渲染层按字符串透传。历史上请求体一律写成
 * `Number(id)`，在 6-7 位的现有 ID 上没问题，但一旦换成雪花 ID（19 位）就会
 * 超出 Number.MAX_SAFE_INTEGER 而静默丢精度。这里统一收口：
 * 纯数字且落在安全整数范围内才转 number（保持既有请求形状，服务端行为不变），
 * 其余原样发字符串，宁可让服务端报错也不要带着错误的 ID 发请求。
 */
export function toApiId(value: string): number | string {
  if (!/^\d+$/.test(value))
    return value
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? numeric : value
}
