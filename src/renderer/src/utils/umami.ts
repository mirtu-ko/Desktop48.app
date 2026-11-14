// Umami 手动上报。
//
// 页面以 file:// 加载，自动采集会把本机安装路径当作 URL 上报，故统一由这里清洗后发送。
// 计费口径：pageview、自定义事件、每条事件属性各算 1 条配额。
// 因此不带数字 ID（撑爆维度）与恒定属性，高频事件只带低基数枚举 / 分桶。
// 例外：低频排障事件 player:error / live:stall 带 title（前者另带 liveId）才能定位场次；
// rooms:enter 每日按房间去重，保留 starName 作为唯一业务维度。
import { debugLog } from '@renderer/utils/debug'

interface UmamiTrackProps {
  url?: string
  referrer?: string
  hostname?: string
  name?: string
  data?: Record<string, string | number>
}

interface Umami {
  // 必须用回调形式：props 是 script 算好的默认字段（含 /api/send 必填的 website 等）。
  // 对象形式会整体替换、丢掉 website；'name', data 形式会沿用 script 自算的 file:// url
  track: (callback: (props: UmamiTrackProps) => UmamiTrackProps) => void
}

declare global {
  interface Window {
    umami?: Umami
  }
}

const REPORT_HOSTNAME = 'Desktop48.app'

/** 上报依赖 hash 路由与脚本对象：测试环境可能只 stub 了 window，不保证 location 存在 */
function isTrackingContext(): boolean {
  return typeof window !== 'undefined' && !!window.location
}

// URL 里只保留低基数、可读的枚举值；liveId / member 等 ID 会撑爆 Pages 维度
const PAGE_QUERY_ALLOWLIST = ['kind']

function sanitizePagePath(rawPath: string): string {
  const [pathname, search = ''] = rawPath.split('?')
  if (!search)
    return pathname
  const params = new URLSearchParams(search)
  for (const key of [...params.keys()]) {
    if (!PAGE_QUERY_ALLOWLIST.includes(key))
      params.delete(key)
  }
  const kept = params.toString()
  return kept ? `${pathname}?${kept}` : pathname
}

/** 当前窗口的 hash 路由（不含 '#'） */
function currentHashPath(): string {
  return sanitizePagePath(window.location.hash.slice(1) || '/')
}

/** 播放会话从未出画时的时长分桶：与「出画后不足 1 分钟」区分开 */
export const DURATION_BUCKET_FAILED = 'failed'

/** 一条待发送的上报 */
interface PendingPayload {
  name?: string
  data?: Record<string, string | number>
  url: string
  referrer: string
}

// CDN 脚本未就绪时的暂存队列：就绪后补发，避免启动期事件被静默丢弃
const PENDING_LIMIT = 50
const FLUSH_INTERVAL_MS = 2000
const FLUSH_BACKOFF_MS = 30000
const FLUSH_BACKOFF_AFTER = 10

let pending: PendingPayload[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushAttempts = 0

function send(payload: PendingPayload): void {
  window.umami?.track(props => ({
    ...props,
    ...payload,
    hostname: REPORT_HOSTNAME,
  }))
}

function flushPending(): void {
  flushTimer = null
  if (!isTrackingContext() || !window.umami || pending.length === 0)
    return
  const queued = pending
  pending = []
  flushAttempts = 0
  for (const item of queued)
    send(item)
}

// 轮询检测 window.umami 是否就绪：CSP 的 script-src 不含 unsafe-inline，
// 没法用内联 onload 派发事件，只能定时探测
function scheduleFlush(): void {
  if (flushTimer !== null)
    return
  const delay = flushAttempts >= FLUSH_BACKOFF_AFTER ? FLUSH_BACKOFF_MS : FLUSH_INTERVAL_MS
  flushTimer = setTimeout(() => {
    flushAttempts += 1
    flushPending()
    if (pending.length > 0)
      scheduleFlush()
  }, delay)
}

function enqueue(payload: PendingPayload): void {
  if (pending.length >= PENDING_LIMIT)
    pending.shift()
  pending.push(payload)
  scheduleFlush()
}

/** 唯一出口：开发构建只打日志（确认埋点有没有触发），不发送；生产按脚本是否就绪发送或入队 */
function dispatch(payload: PendingPayload): void {
  if (import.meta.env.DEV) {
    debugLog('umami', payload.name ?? 'pageview', payload.data ?? payload.url)
    return
  }
  if (!window.umami) {
    enqueue(payload)
    return
  }
  send(payload)
}

/** 上报一次页面访问。path / referrer 不含 '#'，无上一页时 referrer 留空 */
export function trackPage(path: string, referrer?: string): void {
  if (!isTrackingContext())
    return
  dispatch({
    url: `/#${sanitizePagePath(path)}`,
    referrer: referrer ? `/#${sanitizePagePath(referrer)}` : '',
  })
}

/** 上报一条自定义事件。空串 / undefined 属性剔除，剔空后不带 data 字段 */
export function trackEvent(name: string, data?: Record<string, string | number>): void {
  if (!isTrackingContext())
    return
  const payload = Object.fromEntries(
    Object.entries(data ?? {}).filter(([, value]) => value !== '' && value !== undefined),
  )
  dispatch({
    name,
    ...(Object.keys(payload).length > 0 ? { data: payload } : {}),
    url: `/#${currentHashPath()}`,
    referrer: '',
  })
}

/** 数量类属性只上报分桶：原始条数会随单次操作波动，分桶足够回答规模分布 */
export function countBucket(count: number): string {
  // 0 单独成桶：批量保存可能一张都没成功，归到 '1' 会把空操作算成有结果
  if (!Number.isFinite(count) || count <= 0)
    return '0'
  if (count <= 1)
    return '1'
  if (count <= 5)
    return '2-5'
  if (count <= 20)
    return '6-20'
  return '20+'
}

/** 观看时长只上报分桶：事件没有时长概念，分桶足够回答「点开就走」的比例 */
export function durationBucket(seconds: number): string {
  if (seconds < 60)
    return '<1m'
  if (seconds < 300)
    return '1-5m'
  if (seconds < 900)
    return '5-15m'
  return '15m+'
}
