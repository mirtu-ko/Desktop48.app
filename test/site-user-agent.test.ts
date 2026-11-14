import type { NetRequestOptions } from '@preload/ipc-contract'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Apis from '@renderer/services/apis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANDROID_DEVICE } from '../src/common/android-device'

/**
 * 站点请求（`Apis.*`）的 UA。
 *
 * 这条链路是匿名请求，但打的域名与 App 档重叠（同为 pocketapi），所以「机型」必须与 App 档
 * 同源：两处各写各的机型时，同一出口 IP 在服务端看就是「App 来自 A 机、浏览器来自 B 机」
 * 两台设备。机型事实的唯一来源是 `common/android-device.ts`（2026-10-16 统一）。
 */
vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn() } }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/** 捕获跨进程网络载荷，返回本次请求的请求头 */
function stubNet(body = '{}') {
  // 形参类型对齐真实契约（preload 的 netRequest），mock.calls 才能取到第 0 个实参
  const netRequest = vi.fn(async (_options: NetRequestOptions) => ({ status: 200, body, headers: {} }))
  vi.stubGlobal('window', { mainAPI: { netRequest } })
  return (index = 0) => netRequest.mock.calls[index][0].headers as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('站点请求 UA', () => {
  it('pOST：机型与 Android 版本取自共享设备事实，形态是移动端浏览器', async () => {
    const headersAt = stubNet(JSON.stringify({ status: 200, success: true, content: { onlineNum: 1 } }))

    await Apis.live('1306021298192584704')

    const ua = headersAt()['User-Agent']
    expect(ua).toBe(
      'Mozilla/5.0 (Linux; Android 14; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
    )
    // 与 App 档同源（不是各写一份的字面量）
    expect(ua).toContain(ANDROID_DEVICE.model)
    expect(ua).toContain(`Android ${ANDROID_DEVICE.osVersion}`)
  })

  it('gET（弹幕 LRC / 曲库静态 JSON）同样带该 UA', async () => {
    const headersAt = stubNet('')

    await Apis.barrage('https://cdn.48.cn/barrage.lrc')

    expect(headersAt()['User-Agent']).toContain(ANDROID_DEVICE.model)
  })

  it('主进程与各渲染层出口都复用共享常量，不再内联 UA 字面量', () => {
    const consumers = [
      'src/main/net-diagnose.ts',
      'src/main/ipc/register-system-ipc.ts',
      'src/renderer/src/services/request.ts',
    ]
    for (const file of consumers) {
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
      expect(source, file).toContain('SITE_USER_AGENT')
      expect(source, file).not.toContain('Chrome/152.0.0.0 Mobile Safari')
    }
  })
})
