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
interface Umami {
  track: (props: { url: string, referrer?: string, hostname?: string }) => void
}

declare global {
  interface Window {
    umami?: Umami
  }
}

// 上报一次页面访问。path 不含 '#'，如 '/setting'、'/float?live=123'
export function trackPage(path: string): void {
  // CDN 拉取失败 / 离线时 window.umami 不存在，静默跳过
  window.umami?.track({
    url: `/#${path}`,
    // referrer 同样是 file:// 路径，上报空串；hostname 固定为一个可读的应用名，
    // 避免仪表盘里出现 file:// 或空主机名
    referrer: '',
    hostname: 'desktop48-app',
  })
}
