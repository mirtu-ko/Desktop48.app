import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLiveResult, normalizeLiveResult } from '../src/renderer/src/services/live-result'

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/** 实测报文（2026-10-24，token 请求）：数字字段全是字符串，头像为服务端相对路径 */
function rawResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    liveId: '1320895340900847616',
    liveTime: '900803',
    liveOnline: 213,
    userName: 'GNZ48-鲍雨欣',
    totalMoney: '4558',
    topUser: {
      user: { userId: '66453841', userName: '线条小猪', userAvatar: '/avatar/2026/0829/66453841.jpg', level: 11 },
      money: 1500,
    },
    topUserList: [
      { user: { userId: '66453841', userName: '线条小猪', userAvatar: '/avatar/2026/0829/66453841.jpg', level: 11, vip: true }, money: 1500 },
      { user: { userId: '1751121953', userName: '加班不冻港', userAvatar: '/avatar/2026/0730/1751121953.jpg', level: 12 }, money: '1500' },
      { user: { userId: '167641224', userName: '立冬❄️🍔', userAvatar: '/avatar/2026/0311/167641224.jpg', level: 8 }, money: 1500 },
    ],
    ...extra,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('normalizeLiveResult（复盘字段宽松解析）', () => {
  it('字符串数字全部解析为数值，榜单前三保留', () => {
    const view = normalizeLiveResult('fallback-id', rawResult())

    expect(view.liveId).toBe('1320895340900847616')
    expect(view.liveTime).toBe(900803)
    expect(view.liveOnline).toBe(213)
    expect(view.totalMoney).toBe(4558)
    expect(view.userName).toBe('GNZ48-鲍雨欣')
    expect(view.topUsers).toEqual([
      { user: { userId: '66453841', userName: '线条小猪', userAvatar: '/avatar/2026/0829/66453841.jpg', level: 11 }, money: 1500 },
      { user: { userId: '1751121953', userName: '加班不冻港', userAvatar: '/avatar/2026/0730/1751121953.jpg', level: 12 }, money: 1500 },
      { user: { userId: '167641224', userName: '立冬❄️🍔', userAvatar: '/avatar/2026/0311/167641224.jpg', level: 8 }, money: 1500 },
    ])
  })

  it('字段缺失 / 非数字按 0 或空串，不抛错', () => {
    const view = normalizeLiveResult('fallback-id', { liveTime: 'abc', liveOnline: -5, totalMoney: null })

    expect(view.liveId).toBe('fallback-id')
    expect(view.liveTime).toBe(0)
    expect(view.liveOnline).toBe(0)
    expect(view.totalMoney).toBe(0)
    expect(view.userName).toBe('')
    expect(view.topUsers).toEqual([])
  })

  it('无昵称的榜单条目整条丢弃', () => {
    const view = normalizeLiveResult('id', rawResult({
      topUserList: [
        { user: { userId: '1' }, money: 100 },
        { money: 50 },
        null,
        { user: { userId: '2', userName: '有人' }, money: 20 },
      ],
    }))

    expect(view.topUsers).toHaveLength(1)
    expect(view.topUsers[0].user.userName).toBe('有人')
    expect(view.topUsers[0].money).toBe(20)
  })
})

describe('loadLiveResult（主进程取数）', () => {
  it('经 pocketGetLiveResult 取回并归一', async () => {
    const pocketGetLiveResult = vi.fn().mockResolvedValue(rawResult())
    vi.stubGlobal('window', { mainAPI: { pocketGetLiveResult } })

    const view = await loadLiveResult('1320895340900847616')

    expect(pocketGetLiveResult).toHaveBeenCalledWith('1320895340900847616')
    expect(view.liveOnline).toBe(213)
    expect(view.topUsers).toHaveLength(3)
  })

  it('主进程失败（未登录 / 接口异常）原样上抛，由调用方降级', async () => {
    const pocketGetLiveResult = vi.fn().mockRejectedValue(new Error('未登录口袋48账号'))
    vi.stubGlobal('window', { mainAPI: { pocketGetLiveResult } })

    await expect(loadLiveResult('1')).rejects.toThrow('未登录口袋48账号')
  })

  it('回包为空对象时归一为空复盘（不抛错）', async () => {
    const pocketGetLiveResult = vi.fn().mockResolvedValue({})
    vi.stubGlobal('window', { mainAPI: { pocketGetLiveResult } })

    const view = await loadLiveResult('1')

    expect(view.liveTime).toBe(0)
    expect(view.topUsers).toEqual([])
  })
})
