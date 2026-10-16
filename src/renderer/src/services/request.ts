import { ANDROID_DEVICE } from '@common/android-device'
import { debugLog } from '@renderer/utils/debug'

/**
 * 站点请求的 UA（`Apis.*` 全部接口：站点直播 / 回放、成员 jsonp、曲库）。
 *
 * 与口袋客户端的伪装身份是两回事，不要合并：`main/pocket48/client-profile.ts` 那套
 * （PocketFans UA + appInfo + pa）用于**模拟 App 客户端**打 pocketapi 的 App 域接口；
 * 而这里打的是面向网页/浏览器受众的接口，用移动端浏览器标识才是它们的正常调用方。
 *
 * 但**设备必须是同一台**：机型事实取自 `common/android-device.ts`（App 档同源），
 * 否则同一出口 IP 在服务端看来就是「App 来自 A 机、浏览器来自 B 机」两台设备。
 *
 * 固定为常量、不再可配置：原先设置页有自定义入口，改坏后接口异常且无从排查；
 * 顺带省掉每次请求读一次配置的跨进程往返（原为 `getConfig('userAgent')`）。
 */
const SITE_USER_AGENT = `Mozilla/5.0 (Linux; Android ${ANDROID_DEVICE.osVersion}; ${ANDROID_DEVICE.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`

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
    debugLog('net', payload.method, payload.url, payload.body, `${(performance.now() - startedAt).toFixed(0)}ms`)
    return response
  }
  catch (e: any) {
    debugLog('net', payload.method, payload.url, payload.body, `失败(${(performance.now() - startedAt).toFixed(0)}ms):`, e?.message || e)
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
