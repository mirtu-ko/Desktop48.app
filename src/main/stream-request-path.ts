/**
 * 本地流媒体服务的请求路径解析。
 *
 * 两处都能抛：畸形转义（`%E0%A4%A`、`%ZZ`）让 decodeURIComponent 抛 URIError，
 * 绝对形式请求目标里的非法主机名（`GET http://[ HTTP/1.1`）让 new URL 抛 TypeError。
 * 这一行原本位于请求回调顶层、在 try 之外，异常会变成 uncaughtException 打崩主进程；
 * 本机任意网页用一张 `<img src="http://127.0.0.1:8080/live/%ZZ.flv">` 就能触发。
 * 故一律降级为 null，由调用方回 400。
 */
export function parseStreamRequestPath(rawUrl: string | undefined): string | null {
  try {
    return decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname)
  }
  catch {
    return null
  }
}
