// 主进程网络请求白名单。
// 主进程独立维护安全策略，避免渲染层 URL 配置影响白名单。
const ALLOWED_HOSTS = new Set([
  'pocketapi.48.cn',
  'www.cgt48.com',
  'b50.ckg48.com',
  'live.48.cn',
])

// 直播/点播的媒体域名由接口动态下发，无法枚举，按域名后缀兜底
const ALLOWED_HOST_SUFFIXES = ['.48.cn', '.snh48.com']

/** rtmp:// 拉流域名的动态下发后缀（与 HTTP 白名单分开维护：拉流走 RTMP 协议，域名体系不同） */
const ALLOWED_RTMP_SUFFIXES = ['.48.cn', '.snh48.com']

// B 站弹幕链路专用白名单：只给主进程的 danmaku-session 用，不并入 netRequest 的放行集合
const BILIBILI_API_HOSTS = new Set(['api.bilibili.com', 'api.live.bilibili.com'])
/** 弹幕服务器地址由 getDanmuInfo 动态下发，无法枚举，按域名后缀兜底 */
const BILIBILI_SOCKET_SUFFIXES = ['.chat.bilibili.com']

/** 解析 URL 并归一化 hostname；解析不了返回 null —— 白名单一律「解析不了即不放行」 */
function parseUrl(url: string): { protocol: string, hostname: string } | null {
  try {
    const { protocol, hostname } = new URL(url)
    return { protocol, hostname: hostname.toLowerCase() }
  }
  catch {
    return null
  }
}

/** hostname 须已小写（由 parseUrl 归一） */
function isAllowedHost(hostname: string, suffixes: string[] = ALLOWED_HOST_SUFFIXES): boolean {
  return ALLOWED_HOSTS.has(hostname) || suffixes.some(suffix => hostname.endsWith(suffix))
}

/** 走通用 HTTP 白名单的两种协议（rtmp 另有后缀表） */
function isHttpProtocol(protocol: string): boolean {
  return protocol === 'https:' || protocol === 'http:'
}

/** B 站接口地址校验（WBI / 房间信息 / 弹幕服务器列表），见 danmaku-session.ts */
export function isAllowedBilibiliApiUrl(url: string): boolean {
  const parsed = parseUrl(url)
  return !!parsed && isHttpProtocol(parsed.protocol) && BILIBILI_API_HOSTS.has(parsed.hostname)
}

/** B 站弹幕长连接地址校验：ws(s) 协议 + `.chat.bilibili.com` 后缀 */
export function isAllowedBilibiliSocketUrl(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed || (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:'))
    return false
  return BILIBILI_SOCKET_SUFFIXES.some(suffix => parsed.hostname.endsWith(suffix))
}

export function isAllowedUrl(url: string): boolean {
  const parsed = parseUrl(url)
  return !!parsed && isHttpProtocol(parsed.protocol) && isAllowedHost(parsed.hostname)
}

/**
 * ffmpeg 输入地址校验（直播拉流 createLiveStream / 下载 downloadTaskStart / 录制 recordTaskStart）：
 * - rtmp:// 直播拉流：按 RTMP 后缀白名单放行（域名由接口动态下发，无法枚举）
 * - http(s):// 回放/录制源：与 netRequest 同一套 HTTP 白名单
 * 渲染层传入的 URL 直接交给 spawn，不经此校验会形成安全旁路（主进程被诱导向任意地址连接/写文件）
 */
export function isAllowedStreamUrl(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed)
    return false
  if (parsed.protocol === 'rtmp:')
    return isAllowedHost(parsed.hostname, ALLOWED_RTMP_SUFFIXES)
  return isHttpProtocol(parsed.protocol) && isAllowedHost(parsed.hostname)
}
