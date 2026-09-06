import Constants from '../utils/constants'
import { debugLog } from '../utils/debug'

/** 网络请求参数：直接从 preload 契约签名反推，避免渲染层反向依赖 preload 目录 */
type NetRequestPayload = Parameters<typeof window.mainAPI.netRequest>[0]

export default class Request {
  /**
   * 发送 POST 请求。
   *
   * 所有网络请求都绕道主进程（★ 跨进程：preload → main/ipc/register-system-ipc.ts 的 'netRequest'），
   * 原因有二：渲染层受同源策略限制，且主进程侧有域名白名单（main/allowed-hosts.ts）。
   *
   * 主进程以 utf-8 字符串回包（可能不是合法 JSON，由 apis.request 统一解析），
   * 故返回 Promise<string> 而非对象。
   */
  public static async post(url: string, body: object, headers: Record<string, string> = {}): Promise<string> {
    headers['User-Agent'] = await window.mainAPI.getConfig('userAgent', Constants.DEFAULT_USER_AGENT)
    headers['Content-Type'] = 'application/json'
    return this.tracedNetRequest({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  /** 发送 GET 请求。同样绕道主进程，说明见上方 post */
  public static async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    headers['User-Agent'] = await window.mainAPI.getConfig('userAgent', Constants.DEFAULT_USER_AGENT)
    return this.tracedNetRequest({
      url,
      method: 'GET',
      headers,
    })
  }

  /**
   * dev-only 网络追踪：记录每个跨进程网络请求的 url / 耗时 / 失败原因，
   * 与主进程 [ipc] tracer 对称——排查「接口挂了还是解析挂了」时先看这里。
   */
  private static async tracedNetRequest(payload: NetRequestPayload): Promise<string> {
    const startedAt = performance.now()
    try {
      const response = await window.mainAPI.netRequest(payload)
      debugLog('net', payload.method, payload.url, `${(performance.now() - startedAt).toFixed(0)}ms`)
      return response
    }
    catch (e: any) {
      debugLog('net', payload.method, payload.url, `失败(${(performance.now() - startedAt).toFixed(0)}ms):`, e?.message || e)
      throw e
    }
  }
}
