// 两个对外请求通道共用的重定向校验：白名单只在入口判一次挡不住 302 跳到内网。

import type { ClientRequest } from 'electron'
import { isAllowedUrl } from './allowed-hosts'

/** net.request 默认自动跟随重定向；挂上本守卫后每一跳都要重新过白名单 */
export function guardRedirects(request: ClientRequest, onBlocked: (error: Error) => void): void {
  request.on('redirect', (_statusCode, _method, redirectUrl) => {
    if (isAllowedUrl(redirectUrl)) {
      request.followRedirect()
      return
    }
    // 先落结论再 abort：abort 事件会走同一个 fail，别让它把明确原因覆盖成「请求被中断」
    onBlocked(new Error(`重定向目标不在白名单中: ${redirectUrl}`))
    request.abort()
  })
}
