/**
 * B 站请求的浏览器标识，**唯一来源**（room-info 与 danmaku-session 共用）。
 *
 * 两处打的是同一个接口 `api.live.bilibili.com/room/v1/Room/get_info`（一处做公演名兜底匹配，
 * 一处做弹幕握手取真实房间号）。各写一份时曾出现 Win10 与 macOS 两套桌面 UA 打同一接口的情况，
 * 同一出口 IP 下就是硬矛盾，故收敛到此处。
 *
 * 取 macOS 那套而非 Windows：握手链对风控最敏感，且它已带 Referer，保持原样不动更稳。
 */
export const BILIBILI_USER_AGENT
  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** B 站接口与长连接都要求 Referer 落在直播域，浏览器标识与它成对出现 */
export const BILIBILI_REFERER = 'https://live.bilibili.com/'
