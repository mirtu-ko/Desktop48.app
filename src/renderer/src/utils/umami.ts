// Umami 手动上报。
//
// 为什么不用自动采集：页面以 file:// 加载本地文件，自动采集会把完整本机
// 安装路径（C:/Users/xxx/AppData/.../app.asar/out/renderer/index.html#/setting）
// 当作 URL 上报——泄露用户目录结构。改由调用方
// （主窗口的路由钩子 / 播放窗入口）上报清洗后的 hash 路由。
//
// 实际发送到 cloud.umami.is 的数据范围（不止我们拼的这几个字段）：
// - 我们可控的：url（仅 '/#/xxx' 形式的 hash 路由）、referrer（置空）、
//   hostname（固定 'desktop48-app'）
// - script 自带、我们未干预的：屏幕分辨率、浏览器语言、User-Agent
//   （Umami 服务端据此解析浏览器 / 操作系统）
// - 服务端生成：基于 IP 哈希的匿名会话标识，用于去重访客，不存原始 IP
// 另：CDN 拉取失败 / 离线时 window.umami 不存在，不会发送任何数据。
interface UmamiTrackProps {
  url?: string
  referrer?: string
  hostname?: string
}

interface Umami {
  // 必须用回调形式：props 是 script 自身算好的默认字段（含 /api/send 必填的
  // website、language、screen 等），返回值覆盖默认值。
  // 不能用 track(obj) 对象形式——那会整体替换上报内容、丢掉 website，服务端 400
  track: {
    (callback: (props: UmamiTrackProps) => UmamiTrackProps): void
    (name: string, data?: Record<string, string | number>): void
  }
}

declare global {
  interface Window {
    umami?: Umami
  }
}

// 上报一次页面访问。path 不含 '#'，如 '/setting'、'/float?live=123'
export function trackPage(path: string): void {
  // CDN 拉取失败 / 离线时 window.umami 不存在，静默跳过
  // 单测跑在 node 环境，同样没有 window：与 CDN 失败 / 离线一样静默跳过
  if (typeof window === 'undefined')
    return
  window.umami?.track(props => ({
    ...props,
    url: `/#${path}`,
    // referrer 同样是 file:// 路径，上报空串；hostname 固定为应用名，
    // 避免仪表盘里出现 file:// 或空主机名
    referrer: '',
    hostname: 'desktop48-app',
  }))
}

// 上报一条自定义事件（Umami 仪表盘 Events 里看），data 里的属性会一起进库
export function trackEvent(name: string, data: Record<string, string | number>): void {
  // CDN 拉取失败 / 离线时 window.umami 不存在，静默跳过
  // 同 trackPage：无 window（单测 / 离线 / CDN 失败）一律静默跳过
  if (typeof window === 'undefined')
    return
  window.umami?.track(name, data)
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
