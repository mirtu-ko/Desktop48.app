import ApiUrls from '@renderer/services/api-urls'
import Apis from '@renderer/services/apis'
import EventBus from '@renderer/services/event-bus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * syncInfo 里次要数据源（h5.48.cn 的 allmembers）的降级行为。
 *
 * 这条 jsonp 链路不走 pocketapi 的瞬时失败重试，抽风时后果被放大：
 * - 抛异常会连带 9 个主分节一条都不落库（整次同步报失败）；
 * - 软返回空 rows 更隐蔽：saveMemberData 的 `if (content.allmembers)` 对 `[]` 判真，会清空库里已有名单。
 * 所以失败与空名单都必须表现为「不带该 key 上送」，让 saveMemberData 保留旧值。
 */
const { messageMock } = vi.hoisted(() => ({ messageMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { error: messageMock } }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

const updateOkBody = JSON.stringify({
  status: 200,
  success: true,
  message: 'OK',
  content: { starInfo: [{ userId: 1, realName: '甲' }], teamInfo: [], groupInfo: [] },
})

/** 风控拦下 callback 时返回的是站点 HTML 错误页，不是 JSON */
const wafHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head></html>'

function stubNet(options: { update?: string, allMembers?: string, allMembersError?: Error } = {}) {
  const saveMemberData = vi.fn(async () => ({ ok: true }))
  const netRequest = vi.fn(async (payload: { url: string }) => {
    if (payload.url === ApiUrls.ALL_MEMBER_URL) {
      if (options.allMembersError)
        throw options.allMembersError
      return options.allMembers ?? ''
    }
    return options.update ?? updateOkBody
  })
  vi.stubGlobal('window', {
    mainAPI: { getConfig: async () => 'Mozilla/5.0 (test)', netRequest, saveMemberData },
  })
  return { netRequest, saveMemberData }
}

/** 取本次上送给主进程的载荷（缺 key = 跳过该分节，主进程保留旧值） */
function savedPayload(saveMemberData: ReturnType<typeof stubNet>['saveMemberData']) {
  return saveMemberData.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('apis.syncInfo 的补充源降级', () => {
  it('补充源正常：载荷带 allmembers，主分节同时在', async () => {
    const { saveMemberData } = stubNet({
      allMembers: 'cb({"total":"1","rows":[{"sid":"10337","sname":"曹可甜"}]})',
    })

    await Apis.syncInfo()

    expect(saveMemberData).toHaveBeenCalledTimes(1)
    const payload = savedPayload(saveMemberData)
    expect(payload.allmembers).toEqual([{ sid: '10337', sname: '曹可甜' }])
    expect(payload.starInfo).toEqual([{ userId: 1, realName: '甲' }])
  })

  it('补充源抛异常（返回 HTML）：不带 allmembers，9 个主分节照常落库、整次同步不失败', async () => {
    const { saveMemberData } = stubNet({ allMembers: wafHtml })

    await expect(Apis.syncInfo()).resolves.toBeTruthy()

    expect(saveMemberData).toHaveBeenCalledTimes(1)
    const payload = savedPayload(saveMemberData)
    expect('allmembers' in payload).toBe(false)
    expect(payload.starInfo).toEqual([{ userId: 1, realName: '甲' }])
  })

  it('网络层异常（超时）同样只是跳过补充源', async () => {
    const { saveMemberData } = stubNet({ allMembersError: new Error('请求超时（20000ms）') })

    await expect(Apis.syncInfo()).resolves.toBeTruthy()

    expect('allmembers' in savedPayload(saveMemberData)).toBe(false)
  })

  it('补充源软返回空 rows：按失败处理，不上送空数组（否则会清空库里已有名单）', async () => {
    const { saveMemberData } = stubNet({ allMembers: 'cb({"total":"0","rows":[]})' })

    await Apis.syncInfo()

    const payload = savedPayload(saveMemberData)
    expect('allmembers' in payload).toBe(false)
    expect(payload.starInfo).toEqual([{ userId: 1, realName: '甲' }])
  })

  it('主数据源失败仍要上抛：次要源的兜底不能把主流程的错误吞掉', async () => {
    const { saveMemberData } = stubNet({
      update: JSON.stringify({ status: 500, success: false, message: '服务端异常' }),
    })

    await expect(Apis.syncInfo()).rejects.toThrow('服务端异常')

    expect(saveMemberData).not.toHaveBeenCalled()
  })
})

/**
 * 落库成功即广播 members-updated（消费方 stores/member-tree.ts）。
 * 广播点选在这里而不是调用方 use-member-sync：走到落库这一步的任何调用方都会通知到，
 * 不依赖「记得在封装层补一句」的约定；反过来，没落库就不能广播，否则下游白白重拉一遍。
 */
describe('apis.syncInfo 的变更广播', () => {
  it('落库成功后广播一次 members-updated', async () => {
    stubNet({ allMembers: 'cb({"total":"1","rows":[{"sid":"10337","sname":"曹可甜"}]})' })
    const onUpdated = vi.fn()
    EventBus.on('members-updated', onUpdated)

    try {
      await Apis.syncInfo()
      expect(onUpdated).toHaveBeenCalledTimes(1)
    }
    finally {
      EventBus.off('members-updated', onUpdated)
    }
  })

  it('主数据源失败、未落库时不广播', async () => {
    stubNet({ update: JSON.stringify({ status: 500, success: false, message: '服务端异常' }) })
    const onUpdated = vi.fn()
    EventBus.on('members-updated', onUpdated)

    try {
      await expect(Apis.syncInfo()).rejects.toThrow('服务端异常')
      expect(onUpdated).not.toHaveBeenCalled()
    }
    finally {
      EventBus.off('members-updated', onUpdated)
    }
  })
})
