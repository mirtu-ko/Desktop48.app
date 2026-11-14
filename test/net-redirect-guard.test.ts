import type { ClientRequest } from 'electron'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { guardRedirects } from '../src/main/net-redirect-guard'

function fakeRequest() {
  const emitter = new EventEmitter()
  const followRedirect = vi.fn()
  const abort = vi.fn()
  const request = Object.assign(emitter, { followRedirect, abort }) as unknown as ClientRequest
  const redirect = (url: string) => emitter.emit('redirect', 302, 'GET', url, {})
  return { request, followRedirect, abort, redirect }
}

describe('guardRedirects（每一跳重新过白名单）', () => {
  it('白名单内的重定向继续跟随，且多种合法域名都不拦', () => {
    for (const url of [
      'https://pocketapi.48.cn/other',
      'https://al.hls.xiaoka.48.cn/stream.m3u8',
      'https://kd48-nosdn.yunxinsvr.com/image',
    ]) {
      const { request, followRedirect, abort, redirect } = fakeRequest()
      const onBlocked = vi.fn()
      guardRedirects(request, onBlocked)
      redirect(url)
      expect(followRedirect).toHaveBeenCalledTimes(1)
      expect(abort).not.toHaveBeenCalled()
      expect(onBlocked).not.toHaveBeenCalled()
    }
  })

  it('跳到域名外、内网或 file: 一律拦下并中止请求', () => {
    for (const url of [
      'https://evil.com/avatar.png',
      'http://127.0.0.1:6379/',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      const { request, followRedirect, abort, redirect } = fakeRequest()
      const onBlocked = vi.fn()
      guardRedirects(request, onBlocked)
      redirect(url)
      expect(followRedirect).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledTimes(1)
      expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(url) }))
    }
  })

  it('连续重定向链逐跳校验：先放行再拦下', () => {
    const { request, followRedirect, abort, redirect } = fakeRequest()
    const onBlocked = vi.fn()
    guardRedirects(request, onBlocked)
    redirect('https://source.48.cn/next')
    redirect('http://localhost:8080/admin')
    expect(followRedirect).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(onBlocked).toHaveBeenCalledTimes(1)
  })
})
