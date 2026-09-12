/**
 * 直播播放纯函数集合。
 * 全部无副作用——不碰 DOM / IPC / ElMessage，只做纯计算。
 * 对应单测见 test/live-stream.test.ts（测试即用法文档）。
 */

export interface OpenLiveStream {
  streamPath?: string
  streamType?: number
}

/**
 * 开放公演流选择：优先高清（streamType 2），
 * 其次第一条有地址的流；全空返回 null。
 */
export function pickPreferredStream(streams: OpenLiveStream[] | undefined): OpenLiveStream | null {
  const list = streams || []
  return list.find(s => s.streamType === 2 && s.streamPath)
    || list.find(s => s.streamPath)
    || null
}

/**
 * 开放公演回放 VOD 流选择：优先超清（streamType 3），
 * 回落高清（2）与第一条有地址的流；全空返回 null。
 */
export function pickPreferredVodStream(streams: OpenLiveStream[] | undefined): OpenLiveStream | null {
  const list = streams || []
  return list.find(s => s.streamType === 3 && s.streamPath)
    || list.find(s => s.streamType === 2 && s.streamPath)
    || list.find(s => s.streamPath)
    || null
}

/**
 * 本地 HTTP-FLV 播放地址：时间戳防缓存 + 重启序号防止
 * 同 URL 被浏览器/mpegts 复用旧连接。
 */
export function buildPlaybackUrl(url: string, restartToken: number, now = Date.now()): string {
  return `${url}?t=${now}&r=${restartToken}`
}

/**
 * 直播详情接口明确返回的「直播已终结」业务文案：
 * 命中即说明不该再走断流重试，应直接关闭直播窗口。
 */
const UNAVAILABLE_LIVE_MESSAGES = new Set([
  '回放生成中',
  '该成员直播已被删除',
])

/** 判断 apis.ts 抛出的业务错误是否属于「直播已终结/不可用」 */
export function isUnavailableLiveMessage(message: string): boolean {
  return UNAVAILABLE_LIVE_MESSAGES.has(message)
}

/** 电台轮播切换间隔（毫秒）：接口缺省或非法时回退 5 秒 */
export function normalizeCarouselTime(raw: number | string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '')
    return 5000
  const parsed = Number.parseInt(String(raw))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000
}

/**
 * 电台轮播图列表：接口返回 carousels 时逐个转 URL，
 * 否则回退封面图单张展示；非电台模式返回空数组。
 * toSourceUrl 由调用方注入（Tools.sourceUrl），保持本函数纯净。
 */
export function resolveCarouselImages(
  isRadio: boolean,
  carousels: string[] | undefined,
  coverPath: string,
  toSourceUrl: (url: string) => string,
): string[] {
  if (!isRadio)
    return []
  if (carousels?.length)
    return carousels.map(toSourceUrl)
  return coverPath ? [toSourceUrl(coverPath)] : []
}

/**
 * 重试决策：未达上限返回下一次尝试序号；已达上限返回 null，
 * 由调用方走"直播结束"分支。
 */
export function nextRetryAttempt(current: number, maxRetries: number): number | null {
  return current < maxRetries ? current + 1 : null
}
