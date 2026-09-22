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

function isAllowedHost(hostname: string, suffixes: string[] = ALLOWED_HOST_SUFFIXES): boolean {
  const host = hostname.toLowerCase()
  return ALLOWED_HOSTS.has(host) || suffixes.some(suffix => host.endsWith(suffix))
}

export function isAllowedUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:')
      return false
    return isAllowedHost(hostname)
  }
  catch {
    return false
  }
}

/**
 * ffmpeg 输入地址校验（直播拉流 createLiveStream / 下载 downloadTaskStart / 录制 recordTaskStart）：
 * - rtmp:// 直播拉流：按 RTMP 后缀白名单放行（域名由接口动态下发，无法枚举）
 * - http(s):// 回放/录制源：与 netRequest 同一套 HTTP 白名单
 * 渲染层传入的 URL 直接交给 spawn，不经此校验会形成安全旁路（主进程被诱导向任意地址连接/写文件）
 */
export function isAllowedStreamUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol === 'rtmp:')
      return isAllowedHost(hostname, ALLOWED_RTMP_SUFFIXES)
    if (protocol === 'https:' || protocol === 'http:')
      return isAllowedHost(hostname)
    return false
  }
  catch {
    return false
  }
}
