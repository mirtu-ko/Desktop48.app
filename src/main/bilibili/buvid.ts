/**
 * 弹幕鉴权用的设备标识。留空会被服务端降级到稀疏通道 —— 同时段与 blivechat 对比，
 * 空值时弹幕少一半以上。故必须有值：优先指纹接口签发的 b_3，取不到再回落。
 */
import { randomUUID } from 'node:crypto'

/** 指纹接口（api.bilibili.com 已在弹幕白名单内）：data.b_3 / data.b_4 即 buvid3 / buvid4 */
export const BUVID_SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 从指纹接口响应里取 b_3；取不到返回 null，由调用方决定回落 */
export function pickBuvid(payload: unknown): string | null {
  const buvid = (payload as { data?: { b_3?: unknown } } | null | undefined)?.data?.b_3
  return typeof buvid === 'string' && buvid ? buvid : null
}

/** 本地随机值：格式对齐 buvid3，仅作指纹接口不可用时的兜底 */
export function createFallbackBuvid(): string {
  return randomUUID().toUpperCase()
}
