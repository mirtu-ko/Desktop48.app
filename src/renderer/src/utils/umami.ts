// Umami 手动上报。
//
// 页面以 file:// 加载，自动采集会把本机安装路径当作 URL 上报，故统一由这里清洗后发送。
// 计费口径：pageview、自定义事件、每条事件属性各算 1 条配额，故不带数字 ID 与恒定属性。
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

// 开发构建不上报：调试期事件同样占配额、也会污染生产数据
const trackingEnabled = !import.meta.env.DEV

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

/** 上报一次页面访问。path / referrer 不含 '#'，无上一页时 referrer 留空 */
export function trackPage(path: string, referrer?: string): void {
  // 离线 / CDN 失败时没有 window，静默跳过
  if (!trackingEnabled || typeof window === 'undefined')
    return
  window.umami?.track(props => ({
    ...props,
    url: `/#${sanitizePagePath(path)}`,
    referrer: referrer ? `/#${sanitizePagePath(referrer)}` : '',
    hostname: REPORT_HOSTNAME,
  }))
}

/** 上报一条自定义事件。空串 / undefined 属性剔除，剔空后不带 data 字段 */
export function trackEvent(name: string, data?: Record<string, string | number>): void {
  if (!trackingEnabled || typeof window === 'undefined')
    return
  const payload = Object.fromEntries(
    Object.entries(data ?? {}).filter(([, value]) => value !== '' && value !== undefined),
  )
  window.umami?.track(props => ({
    ...props,
    name,
    ...(Object.keys(payload).length > 0 ? { data: payload } : {}),
    url: `/#${currentHashPath()}`,
    referrer: '',
    hostname: REPORT_HOSTNAME,
  }))
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
