import Apis from '@renderer/services/apis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * apis.request 的瞬时失败重试。
 *
 * 背景（2026-09-13 实测）：pocketapi 的 getLiveOne 会随机返回
 * `{status:1017, success:false, message:'参数错误'}`，同一份 body 约 1/3 命中，
 * 与参数/频率/并发无关。旧实现直接上抛 → 轮询弹红条、resumeLive 误判「直播不存在」关窗。
 */
const { messageMock } = vi.hoisted(() => ({ messageMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { error: messageMock } }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/** 网络层返回体（apis 期望的是 utf-8 字符串，信封解析在 apis 内完成） */
interface NetResult { body?: string, error?: Error }

/**
 * 顺序消费预设的响应；用完后沿用最后一个，方便断言"调用了几次"。
 */
function stubNet(results: NetResult[]) {
  const netRequest = vi.fn(async () => {
    const result = results.length > 1 ? results.shift()! : results[0]
    if (result.error)
      throw result.error
    return result.body!
  })
  vi.stubGlobal('window', {
    mainAPI: {
      getConfig: async () => 'Mozilla/5.0 (test)',
      netRequest,
    },
  })
  return netRequest
}

const okBody = JSON.stringify({ status: 200, success: true, message: 'OK', content: { onlineNum: 1067 } })
const paramErrorBody = JSON.stringify({ status: 1017, success: false, message: '参数错误' })
const deletedBody = JSON.stringify({ status: 10049, success: false, message: '该成员直播已被删除' })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

/** 等重试的退避定时器走完（400/800/1200ms）：先让出微任务排到定时器，再推进假时钟 */
async function settleRetries() {
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 20; j++)
      await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2000)
  }
}

describe('apis.live 的瞬时失败重试', () => {
  it('先 1017 后成功：返回内容、不弹提示', async () => {
    const netRequest = stubNet([{ body: paramErrorBody }, { body: okBody }])

    // 重试要等退避定时器，断言先挂上再推进假时钟（见 settleRetries）
    const assertion = expect(Apis.live('1306021298192584704')).resolves.toEqual({ onlineNum: 1067 })
    await settleRetries()
    await assertion

    expect(netRequest).toHaveBeenCalledTimes(2)
    expect(messageMock).not.toHaveBeenCalled()
  })

  it('1017 连续命中：按 4 次尝试（3 次重试）后上抛，只弹一次提示', async () => {
    const netRequest = stubNet([{ body: paramErrorBody }])

    // 先挂上 rejects 断言再推进时钟：否则重试期间的 rejection 无人接管，会变成未处理拒绝
    const assertion = expect(Apis.live('1306021298192584704')).rejects.toThrow('参数错误')
    await settleRetries()
    await assertion

    expect(netRequest).toHaveBeenCalledTimes(4)
    expect(messageMock).toHaveBeenCalledTimes(1)
  })

  it('业务结论（该成员直播已被删除）不重试，立即上抛让上层关窗', async () => {
    const netRequest = stubNet([{ body: deletedBody }])

    await expect(Apis.live('123')).rejects.toThrow('该成员直播已被删除')

    expect(netRequest).toHaveBeenCalledTimes(1)
    expect(messageMock).toHaveBeenCalledWith('该成员直播已被删除')
  })

  it('silent：最终失败也不弹提示（后台轮询不打扰用户）', async () => {
    const netRequest = stubNet([{ body: paramErrorBody }])

    const assertion = expect(Apis.live('123', { silent: true })).rejects.toThrow('参数错误')
    await settleRetries()
    await assertion

    expect(netRequest).toHaveBeenCalledTimes(4)
    expect(messageMock).not.toHaveBeenCalled()
  })

  it('网络层异常同样重试，重试后成功即恢复', async () => {
    const netRequest = stubNet([{ error: new Error('请求超时（20000ms）') }, { body: okBody }])

    const assertion = expect(Apis.live('123')).resolves.toEqual({ onlineNum: 1067 })
    await settleRetries()
    await assertion

    expect(netRequest).toHaveBeenCalledTimes(2)
    expect(messageMock).not.toHaveBeenCalled()
  })

  it('retries: 0 时保持旧行为（不重试，失败即抛）', async () => {
    const netRequest = stubNet([{ body: paramErrorBody }])

    await expect(Apis.live('123', { retries: 0 })).rejects.toThrow('参数错误')

    expect(netRequest).toHaveBeenCalledTimes(1)
  })
})
