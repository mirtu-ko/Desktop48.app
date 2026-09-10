import Constants from '@renderer/utils/constants'
import { debugLog } from '@renderer/utils/debug'

/** 网络请求参数：直接从 preload 契约签名反推，避免渲染层反向依赖 preload 目录 */
type NetRequestPayload = Parameters<typeof window.mainAPI.netRequest>[0]

/**
 * dev-only 网络追踪：记录每个跨进程网络请求的 url / 耗时 / 失败原因，
 * 与主进程 [ipc] tracer 对称——排查「接口挂了还是解析挂了」时先看这里。
 */
async function tracedNetRequest(payload: NetRequestPayload): Promise<string> {
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

/**
 * 发送 POST 请求。
 *
 * 所有网络请求都绕道主进程（★ 跨进程：preload → main/ipc/register-system-ipc.ts 的 'netRequest'），
 * 原因有二：渲染层受同源策略限制，且主进程侧有域名白名单（main/allowed-hosts.ts）。
 *
 * 主进程以 utf-8 字符串回包（可能不是合法 JSON，由 apis.request 统一解析），
 * 故返回 Promise<string> 而非对象。
 */
async function post(url: string, body: object, headers: Record<string, string> = {}): Promise<string> {
  headers['User-Agent'] = await window.mainAPI.getConfig('userAgent', Constants.DEFAULT_USER_AGENT)
  headers['Content-Type'] = 'application/json'
  return tracedNetRequest({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** 发送 GET 请求。同样绕道主进程，说明见上方 post */
async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  headers['User-Agent'] = await window.mainAPI.getConfig('userAgent', Constants.DEFAULT_USER_AGENT)
  return tracedNetRequest({
    url,
    method: 'GET',
    headers,
  })
}

/**
 * 渲染层网络入口（全部无状态）。
 *
 * 说明：不用 `class + static` —— ES 模块本身就是单例，class 外壳对无状态函数没有收益，
 * 还会让 `this.tracedNetRequest` 这种隐式耦合出现（对象字面量里的 `this` 一旦被解构就会断）。
 * 内部一律直接调用模块级函数，只有导出时才组装成命名空间对象。
 */
const Request = {
  post,
  get,
}

export default Request
