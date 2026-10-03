/**
 * 弹幕鉴权用的设备标识。指纹接口给的值与浏览器 cookie 里的 buvid3 同格式，
 * 但服务端只校验非空 —— 留空会被降级到稀疏通道，故取不到时必须回落，不能空着。
 */
import { randomUUID } from 'node:crypto'

/** 指纹接口（api.bilibili.com 已在弹幕白名单内）：data.b_3 / data.b_4 即 buvid3 / buvid4 */
export const BUVID_SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 从指纹接口响应里取 b_3；取不到返回 null，由调用方决定回落 */
export function pickBuvid(payload: unknown): string | null {
  const buvid = (payload as { data?: { b_3?: unknown } } | null | undefined)?.data?.b_3
  return typeof buvid === 'string' && buvid ? buvid : null
}

/** 本地随机值：格式对齐 buvid3，服务端不校验内容 */
export function createFallbackBuvid(): string {
  return randomUUID().toUpperCase()
}
