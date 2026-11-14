/**
 * 直播播放纯函数集合。
 * 全部无副作用——不碰 DOM / IPC / ElMessage，只做纯计算。
 * 类型 OpenLiveStream 来自 services/api-types，纯类型导入不产生运行时依赖。
 * 对应单测见 test/live-stream.test.ts（测试即用法文档）。
 */
import type { OpenLiveStream } from '@renderer/services/api-types'

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
 * 直播详情接口的两类终结业务文案，处置不同：
 * 「回放生成中」= 本场刚下播（进结束卡）；「已被删除」= 内容下架（关窗）。
 */
const LIVE_ENDED_MESSAGE = '回放生成中'
const LIVE_REMOVED_MESSAGE = '该成员直播已被删除'

/** 本场已下播、回放尚未生成：不该再重试，应进下播结束态 */
export function isLiveEndedMessage(message: string): boolean {
  return message === LIVE_ENDED_MESSAGE
}

/** 直播已被删除/下架：错误态，关闭浮窗 */
export function isLiveRemovedMessage(message: string): boolean {
  return message === LIVE_REMOVED_MESSAGE
}

/**
 * 详情是否已从直播态转为回放态：进行中是 review=false + rtmp 地址，
 * 下播后是 review=true + https VOD 地址（无 token 也能查，见 getLiveOne）。
 * 仅 user 源可判：open 详情没有 review 概念，归一后恒 true。
 * 地址缺失或异常协议不算结束，留给重试链处理。
 */
export function isEndedLiveDetail(
  view: { review: boolean, playStreamPath: string },
  source: string,
): boolean {
  if (source !== 'user')
    return false
  return view.review === true || /^https?:\/\//i.test(view.playStreamPath)
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
 * 由调用方查状态判是否下播，未确认则切加载失败卡。
 */
export function nextRetryAttempt(current: number, maxRetries: number): number | null {
  return current < maxRetries ? current + 1 : null
}

/** 加载失败的来源：流本身 / 首次详情 / 本地网络断开 */
export type LoadFailureKind = 'stream' | 'detail' | 'offline'

/** 失败卡文案；三种来源共用一张卡，模板不再按分支拼字串 */
export interface LoadFailureView {
  title: string
  hint: string
  action: string
}

const LOAD_FAILURE_VIEWS: Record<LoadFailureKind, LoadFailureView> = {
  stream: {
    title: '直播暂时无法加载',
    hint: '主播推流或网络可能暂时异常，稍后可以重试',
    action: '重试',
  },
  detail: {
    title: '直播暂时无法加载',
    hint: '无法获取直播信息，请检查网络后重试',
    action: '重试',
  },
  offline: {
    title: '网络连接已断开',
    hint: '网络恢复后将自动重新连接',
    action: '立即重试',
  },
}

/** 失败态 → 卡片文案；新增来源只需在此登记取值 */
export function describeLoadFailure(kind: LoadFailureKind): LoadFailureView {
  return LOAD_FAILURE_VIEWS[kind]
}
