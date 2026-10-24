/**
 * 人数 / 人气格式化（官方 App formatViewNum 同款）：
 * <10000 原样输出；≥10000 归一为 X.YW（小数位末尾的 .0 去掉）。
 * 直播卡片、播放器在线人数、累计礼物流水共用。
 */
export function formatViewNum(value: number): string {
  if (!Number.isFinite(value) || value <= 0)
    return '0'
  if (value < 10000)
    return String(Math.floor(value))
  const text = (value / 10000).toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}W`
}
