import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConfigIPC } from '../src/main/ipc/register-config-ipc'
import { handleTraced } from '../src/main/ipc/trace'

const { storeMock } = vi.hoisted(() => ({
  storeMock: {
    getConfig: vi.fn((key: string) => key === 'trayOnClose' ? 'on' : 'left'),
    setConfig: vi.fn(),
  },
}))

vi.mock('../src/main/ipc/trace', () => ({
  handleTraced: vi.fn(),
}))

vi.mock('../src/main/config-store', () => ({
  ConfigStore: {
    instance: vi.fn(() => storeMock),
  },
}))

type InvokeHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function handlerOf(channel: string): InvokeHandler {
  const call = vi.mocked(handleTraced).mock.calls.find(([name]) => name === channel)
  if (!call)
    throw new Error(`通道未注册: ${channel}`)
  return call[1] as unknown as InvokeHandler
}

describe('registerConfigIPC 通道注册', () => {
  beforeEach(() => {
    vi.mocked(handleTraced).mockClear()
    storeMock.setConfig.mockClear()
  })

  it('注册 preload 配置 API 所需的全部 invoke 通道', () => {
    registerConfigIPC()

    const channels = vi.mocked(handleTraced).mock.calls.map(([channel]) => channel)
    expect(channels.sort()).toEqual(['getConfig', 'setConfig'])
  })

  it('setConfig 在入口校验取值：非法枚举不落库', async () => {
    registerConfigIPC()

    await expect(handlerOf('setConfig')({}, 'floatTopmost', 'sometimes')).rejects.toThrow('Invalid config value')
    expect(storeMock.setConfig).not.toHaveBeenCalled()
  })

  it('setConfig 校验通过后才写存储', async () => {
    registerConfigIPC()

    await handlerOf('setConfig')({}, 'danmakuPlacement', 'left')
    expect(storeMock.setConfig).toHaveBeenCalledWith('danmakuPlacement', 'left')
  })

  it('getConfig 透传到存储', async () => {
    registerConfigIPC()

    await expect(handlerOf('getConfig')({}, 'trayOnClose')).resolves.toBe('on')
    expect(storeMock.getConfig).toHaveBeenCalledWith('trayOnClose')
  })
})
