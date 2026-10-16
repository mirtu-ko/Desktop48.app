import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clientHeaders,
  NIM_ANDROID,
  POCKET48_ANDROID,
  pocketDeviceId,
  SEINE48_ANDROID,
} from '../src/main/pocket48/client-profile'

/**
 * 客户端身份唯一来源：字段值是与真实客户端对齐过的契约（换值 = 换伪装身份，需重跑
 * D:/DEV/48/probe-profile.mjs 的多接口 A/B），故这里按精确值断言，不做模糊匹配。
 *
 * 设备 ID 现在落盘（userData/pocket48-device.json），落盘目录指向临时目录；
 * 「跨会话复用」用 vi.resetModules 重新加载模块模拟重启。
 */
let tmpUserData = ''

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? tmpUserData : '') },
}))

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
}))

beforeEach(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop48-device-'))
})

afterEach(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true })
})

/** 设备 ID 的持久化文件（与 client-profile.ts 里的文件名一致） */
function deviceFilePath(): string {
  return path.join(tmpUserData, 'pocket48-device.json')
}

describe('client-profile / 设备 ID', () => {
  it('形如 16 位小写 hex（Android 档的 IMEI 形状），且进程内单例', () => {
    const first = pocketDeviceId()
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(pocketDeviceId()).toBe(first)
  })
})

describe('client-profile / 设备 ID 持久化', () => {
  it('首次生成即落盘，同一会话内不重复读盘', async () => {
    vi.resetModules()
    const mod = await import('../src/main/pocket48/client-profile')
    const id = mod.pocketDeviceId()

    expect(JSON.parse(fs.readFileSync(deviceFilePath(), 'utf-8'))).toEqual({ deviceId: id })
    // 第二次调用走内存缓存；即便把文件删掉也不受影响
    fs.rmSync(deviceFilePath())
    expect(mod.pocketDeviceId()).toBe(id)
  })

  it('重启（重新加载模块）后读回同一个 ID，不再重新生成', async () => {
    vi.resetModules()
    const first = await import('../src/main/pocket48/client-profile')
    const id = first.pocketDeviceId()

    vi.resetModules() // 模拟重启：清模块缓存与内存中的设备 ID
    const second = await import('../src/main/pocket48/client-profile')

    expect(second.pocketDeviceId()).toBe(id)
  })

  it('文件里的值不合法（手改 / 旧格式）时重建并覆盖', async () => {
    fs.writeFileSync(deviceFilePath(), JSON.stringify({ deviceId: 'NOT-A-DEVICE-ID' }))

    vi.resetModules()
    const mod = await import('../src/main/pocket48/client-profile')
    const id = mod.pocketDeviceId()

    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(id).not.toBe('NOT-A-DEVICE-ID')
    expect(JSON.parse(fs.readFileSync(deviceFilePath(), 'utf-8'))).toEqual({ deviceId: id })
  })
})

describe('client-profile / 公共头', () => {
  it('主 App（pocket48）Android 档：UA / Content-Type / appInfo 与真实客户端一致', () => {
    const headers = clientHeaders(POCKET48_ANDROID)
    expect(headers['User-Agent'])
      .toBe('PocketFans201807/7.1.43_26082801 (23013RK75C:Android 14;Xiaomi UKQ1.231003.002 release-keys)')
    // Android 档的写法带空格且 UTF-8 大写，勿「顺手统一」成 iOS 档的紧写形式
    expect(headers['Content-Type']).toBe('application/json; charset=UTF-8')
    expect(headers['Accept-Language']).toBe('zh-Hans-CN;q=1')
    expect(headers.appInfo).toBe(JSON.stringify({
      IMEI: pocketDeviceId(),
      appBuild: '26082801',
      appName: 'pocket48',
      appVersion: '7.1.43',
      deviceId: pocketDeviceId(),
      deviceName: '23013RK75C',
      osType: 'android',
      osVersion: '14',
      phoneName: '23013RK75C',
      phoneSystemVersion: '14',
      vendor: 'Xiaomi',
    }))
  })

  it('seine48 Android 档：独立特征并带专属 Device-Type 头', () => {
    const headers = clientHeaders(SEINE48_ANDROID)
    expect(headers['User-Agent'])
      .toBe('PocketFans201807/1.3.4_26092001 (23013RK75C:Android 14;Xiaomi UKQ1.231003.002 release-keys)')
    expect(headers['X-Custom-Device-Type']).toBe('ANDROID')
    const appInfo = JSON.parse(headers.appInfo)
    expect(appInfo).toMatchObject({
      appName: 'seine48',
      appVersion: '1.3.4',
      appBuild: 26092001,
      osType: 'android',
    })
  })

  it('两档共用同一台设备（同一设备 ID），且都不自带 token / pa', () => {
    const main = JSON.parse(clientHeaders(POCKET48_ANDROID).appInfo)
    const seine = JSON.parse(clientHeaders(SEINE48_ANDROID).appInfo)
    expect(seine.deviceId).toBe(main.deviceId)
    expect(seine.IMEI).toBe(main.IMEI)
    for (const headers of [clientHeaders(POCKET48_ANDROID), clientHeaders(SEINE48_ANDROID)]) {
      expect(headers).not.toHaveProperty('token')
      expect(headers).not.toHaveProperty('pa')
    }
  })
})

describe('client-profile / 云信聊天室身份', () => {
  it('包名与 SDK 版本取自官方 Android 客户端（Web SDK 被服务端拒）', () => {
    expect(NIM_ANDROID).toEqual({ sdkVersion: 92110, packageName: 'com.seine48.app' })
  })
})
