/**
 * 主进程 `netRequest` 的请求头收口规则：按目标域名决定报哪套客户端身份。
 *
 * **2026-10-17 境外线路实测（同一出口、同一 URL、同一 body，只换身份头）**：
 * - 站点身份（移动端浏览器 UA，无 `appInfo` / `pa`）→ HTTP 403，约 100ms，响应体为边缘的
 *   HTML 拦截页（一个 RTT 就返回，未到业务后端）；同一台机器上「验证登录态」却能拿到钱包。
 * - App 身份（PocketFans UA + `appInfo` + `pa`）→ HTTP 200。
 *
 * 即服务端的判定维度是**客户端身份**而非出口 IP。渲染层的读接口（直播 / 回放列表、直播详情、
 * 开放公演）打的就是 pocketapi，若继续报站点身份，境外用户的整条业务链路都会 403。
 * 大陆网络下两种身份对同一接口返回 200 且字段集完全一致（2026-10-17 逐字段比对），
 * 故改用 App 身份不改变既有回包。
 *
 * 覆盖范围只到「会做身份判定」的业务接口：**纯静态资源与媒体 CDN 不报 App 身份**——
 * 它们不认这套头，把 deviceId / pa 指纹发给 CDN 只是无谓扩散（见 APP_IDENTITY_HOSTS）。
 */

/**
 * 报 App 身份的域名（口袋体系里做客户端身份 / 风控判定的动态接口）：
 * - `pocketapi.48.cn`：App 域接口（直播、回放、IM、用户域）
 * - `h5.48.cn`：成员名单 jsonp 等 H5 动态接口
 *
 * 刻意不含 `source.48.cn` / `mp4.48.cn` / `live.48.cn`（静态资源、媒体、站点页面）
 * 与 `www.cgt48.com`（曲库静态 JSON）：这些是纯 CDN / 页面，身份头对它们没有意义，
 * 还会把设备指纹和签名扩散到与登录无关的静态服务器。
 */
const APP_IDENTITY_HOSTS = new Set(['pocketapi.48.cn', 'h5.48.cn'])

/** 该 url 是否需要报 App 身份（解析失败按「不需要」处理——白名单校验已在调用前完成） */
export function needsAppIdentity(url: string): boolean {
  try {
    return APP_IDENTITY_HOSTS.has(new URL(url).hostname.toLowerCase())
  }
  catch {
    return false
  }
}

/**
 * 身份头里不参与覆盖的键：`Content-Type` 描述的是请求体，由调用方决定；
 * 客户端特征里那份 `application/json; charset=UTF-8` 只是默认值，不该覆盖
 * 渲染层为 GET / jsonp 请求准备的头。
 */
const NON_IDENTITY_KEYS = new Set(['content-type'])

/**
 * 用 App 身份头覆盖调用方请求头（键名大小写不敏感）。
 *
 * 身份头优先：UA 与 `appInfo` 里的设备必须同属一台，不能让调用方单独改 UA 造出
 * 「浏览器 UA + App 的 appInfo / pa」这种任何真实客户端都不存在的混搭。
 * 身份头未覆盖的键（调用方自带的业务头、Content-Type）原样保留。
 */
export function mergeAppIdentity(
  headers: Record<string, string> | undefined,
  identity: Record<string, string>,
): Record<string, string> {
  const overrides = Object.entries(identity)
    .filter(([key]) => !NON_IDENTITY_KEYS.has(key.toLowerCase()))
  const overrideKeys = new Set(overrides.map(([key]) => key.toLowerCase()))

  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!overrideKeys.has(key.toLowerCase()))
      merged[key] = value
  }
  for (const [key, value] of overrides)
    merged[key] = value
  return merged
}
