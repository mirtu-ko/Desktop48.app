import { ANDROID_DEVICE } from '@common/android-device'
import { debugLog } from '@renderer/utils/debug'

/**
 * 站点请求的 UA（本模块发出的请求都带它）。
 *
 * 与口袋客户端的伪装身份是两回事，不要合并：`main/pocket48/client-profile.ts` 那套
 * 用于模拟 App 客户端；这里打的是静态资源 / 媒体 CDN / cgt48 曲库等网页域。
 *
 * ⚠️ **打口袋业务接口（pocketapi.48.cn、h5.48.cn）的请求不以此 UA 发出**：
 * 主进程 netRequest 转发前会把 UA / appInfo / pa 整组换成 App 身份（清单见
 * `main/net-request-headers.ts`）——站点身份在业务接口上直接 403。
 *
 * 但**设备必须是同一台**：机型事实取自 `common/android-device.ts`（App 档同源）。
 *
 * 固定为常量、不再可配置。
 */
const SITE_USER_AGENT = `Mozilla/5.0 (Linux; Android ${ANDROID_DEVICE.osVersion}; ${ANDROID_DEVICE.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`

/** 网络请求参数：直接从 preload 契约签名反推，避免渲染层反向依赖 preload 目录 */
type NetRequestPayload = Parameters<typeof window.mainAPI.netRequest>[0]

/**
 * 非 2xx 响应。
 *
 * 状态码必须一路带到调用方的重试判断里：429 是「该停」而不是「该重试」，
 * 旧实现把非 2xx 当网络故障，会在限流窗口里再连打 3 次。
 * 主进程收到 429 已按 Retry-After 让整域冷却（main/net-rate-limit.ts），这里只管不重试。
 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, url: string) {
    super(`请求失败 HTTP ${status}: ${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * dev-only 网络追踪：记录每个跨进程网络请求的 url / 状态码 / 耗时 / 失败原因，
 * 与主进程 [ipc] tracer 对称——排查「接口挂了还是解析挂了」时先看这里。
 */
async function tracedNetRequest(payload: NetRequestPayload): Promise<string> {
  const startedAt = performance.now()
  const elapsed = () => `${(performance.now() - startedAt).toFixed(0)}ms`
  let response: Awaited<ReturnType<typeof window.mainAPI.netRequest>>
  try {
    response = await window.mainAPI.netRequest(payload)
  }
  catch (e: any) {
    debugLog('net', payload.method, payload.url, payload.body, `失败(${elapsed()}):`, e?.message || e)
    throw e
  }
  if (response.status < 200 || response.status >= 300) {
    debugLog('net', payload.method, payload.url, payload.body, `HTTP ${response.status}`, elapsed())
    throw new HttpError(response.status, payload.url)
  }
  debugLog('net', payload.method, payload.url, payload.body, response.status, elapsed())
  return response.body
}

/**
 * 发送 POST 请求。
 *
 * 所有网络请求都绕道主进程（★ 跨进程：preload → main/ipc/register-system-ipc.ts 的 'netRequest'），
 * 原因有二：渲染层受同源策略限制，且主进程侧有域名白名单（main/allowed-hosts.ts）。
 *
 * 主进程以 utf-8 字符串回包（可能不是合法 JSON，由 apis.request 统一解析），
 * 故返回 Promise<string> 而非对象。
 */
function post(url: string, body: object, headers: Record<string, string> = {}): Promise<string> {
  headers['User-Agent'] = SITE_USER_AGENT
  headers['Content-Type'] = 'application/json'
  return tracedNetRequest({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** 发送 GET 请求。同样绕道主进程，说明见上方 post */
function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  headers['User-Agent'] = SITE_USER_AGENT
  return tracedNetRequest({
    url,
    method: 'GET',
    headers,
  })
}

/**
 * 渲染层网络入口（全部无状态）。
 *
 * 请求经模块级函数转发，避免对象方法解构后丢失上下文。
 */
const Request = {
  post,
  get,
}

export default Request
