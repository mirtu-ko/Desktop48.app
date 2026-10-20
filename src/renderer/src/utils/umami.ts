// Umami 手动上报。
//
// 页面以 file:// 加载，自动采集会把完整本机安装路径当作 URL 上报，故只由调用方
// （主窗口的路由钩子 / 播放窗入口）上报清洗后的 hash 路由。
//
// 实际发送到 cloud.umami.is 的数据范围（不止我们拼的这几个字段）：
// - 我们可控的：url（仅 '/#/xxx' 形式的 hash 路由）、referrer（上一页 /#/ 路由，无则置空）、
//   hostname（固定 'Desktop48.app'）
// - script 自带、我们未干预的：屏幕分辨率、浏览器语言、User-Agent
//   （Umami 服务端据此解析浏览器 / 操作系统）
// - 服务端生成：基于 IP 哈希的匿名会话标识，用于去重访客，不存原始 IP
// 另：CDN 拉取失败 / 离线时 window.umami 不存在，不会发送任何数据。
interface UmamiTrackProps {
  url?: string
  referrer?: string
  hostname?: string
  name?: string
  data?: Record<string, string | number>
}

interface Umami {
  // 必须用回调形式：props 是 script 自身算好的默认字段（含 /api/send 必填的
  // website、language、screen 等），返回值覆盖默认值。
  // 不能用 track(obj) 对象形式——那会整体替换上报内容、丢掉 website，服务端 400
  // 也不能用 track('name', data) 字符串形式——那会沿用 script 自算的 url
  // （file:// 本机路径）和空 hostname
  track: (callback: (props: UmamiTrackProps) => UmamiTrackProps) => void
}

declare global {
  interface Window {
    umami?: Umami
  }
}

// 上报用固定主机名，避免仪表盘里出现 file:// 或空主机名
const REPORT_HOSTNAME = 'Desktop48.app'

// 当前窗口的 hash 路由（不含 '#'）：主窗口如 '/rooms'，播放窗如 '/float?kind=live&liveId=1'
function currentHashPath(): string {
  return window.location.hash.slice(1) || '/'
}

// 上报一次页面访问。path 不含 '#'，如 '/setting'、'/float?live=123'
// referrer 可选：上一页路由（不含 '#'），由调用方从 router 的 from 传入；
// 无上一页（首次启动 / 播放窗）保持空串
export function trackPage(path: string, referrer?: string): void {
  // CDN 拉取失败 / 离线时 window.umami 不存在，静默跳过
  // 单测跑在 node 环境，同样没有 window：与 CDN 失败 / 离线一样静默跳过
  if (typeof window === 'undefined')
    return
  window.umami?.track(props => ({
    ...props,
    url: `/#${path}`,
    // 有上一页路由就上报清洗后的 /#/hash（不带 file:// 路径）；无上一页保持空串。
    // hostname 固定为应用名，避免仪表盘里出现 file:// 或空主机名
    referrer: referrer ? `/#${referrer}` : '',
    hostname: REPORT_HOSTNAME,
  }))
}

// 上报一条自定义事件（Umami 仪表盘 Events 里看），data 里的属性会一起进库
export function trackEvent(name: string, data: Record<string, string | number>): void {
  // CDN 拉取失败 / 离线时 window.umami 不存在，静默跳过
  // 同 trackPage：无 window（单测 / 离线 / CDN 失败）一律静默跳过
  if (typeof window === 'undefined')
    return
  // 走回调形式并显式带上 name / data：服务端按 name 判 customEvent、data 进 eventData；
  // 同时覆盖 script 自算的 file:// url 与空 hostname
  window.umami?.track(props => ({
    ...props,
    name,
    data,
    url: `/#${currentHashPath()}`,
    referrer: '',
    hostname: REPORT_HOSTNAME,
  }))
}

// 观看时长只上报分桶（<1m / 1-5m / 5-15m / 15m+）：Umami 事件没有时长概念，
// 逐条精确时长落库也没有仪表盘可看，分桶足够回答「点开就走」的比例
export function durationBucket(seconds: number): string {
  if (seconds < 60)
    return '<1m'
  if (seconds < 300)
    return '1-5m'
  if (seconds < 900)
    return '5-15m'
  return '15m+'
}
