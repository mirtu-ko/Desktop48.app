import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePocketCheckIn } from '../src/renderer/src/composables/use-pocket-checkin'

/**
 * 签到 composable：防连点、奖励文案拼装、错误文案转写。
 *
 * 重点是错误提示必须经 pocketAuthErrorMessage 转写，而不是把 error.message 直接甩给用户：
 * 主进程 reject 会被 Electron 包成 `Error invoking remote method 'pocketCheckIn': Error: 今日已领取，
 * 明天再来`，设置页曾因此在拆分后回归成显示这串包装。
 */

const { authMock, trackMock } = vi.hoisted(() => ({
  authMock: {
    checkInPocket: vi.fn(),
    pocketAuthErrorMessage: vi.fn(),
  },
  trackMock: vi.fn(),
}))

vi.mock('@renderer/stores/pocket-auth', () => authMock)
vi.mock('@renderer/utils/umami', () => ({ trackEvent: trackMock }))

describe('usePocketCheckIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功时拼出奖励文案（未获得鸡腿时不出现该项）', async () => {
    authMock.checkInPocket.mockResolvedValue({ addExp: 10, addSupport: 5, addMoney: 0, days: 3 })

    const { checkIn } = usePocketCheckIn()
    await expect(checkIn()).resolves.toEqual({ ok: true, message: '签到成功：成长值 +10，鸡翅 +5，累计签到 3 天' })
    expect(trackMock).toHaveBeenCalledWith('pocket:checkin', { result: 'ok' })
  })

  it('获得鸡腿时补进奖励文案', async () => {
    authMock.checkInPocket.mockResolvedValue({ addExp: 0, addSupport: 1, addMoney: 20, days: 0 })

    const { checkIn } = usePocketCheckIn()
    await expect(checkIn()).resolves.toEqual({ ok: true, message: '签到成功：成长值 +0，鸡翅 +1，鸡腿 +20' })
  })

  it('失败时走 pocketAuthErrorMessage 转写，不透出 IPC 包装', async () => {
    const wrapped = new Error('Error invoking remote method \'pocketCheckIn\': Error: 今日已领取，明天再来')
    authMock.checkInPocket.mockRejectedValue(wrapped)
    authMock.pocketAuthErrorMessage.mockReturnValue('今日已领取，明天再来')

    const { checkIn } = usePocketCheckIn()
    const result = await checkIn()

    expect(authMock.pocketAuthErrorMessage).toHaveBeenCalledWith(wrapped)
    expect(result).toEqual({ ok: false, message: '今日已领取，明天再来' })
    expect(result.message).not.toContain('Error invoking remote method')
    expect(trackMock).toHaveBeenCalledWith('pocket:checkin', { result: 'fail' })
  })

  it('连点期间复用同一个请求，只有第一次真正发出去', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((r) => {
      resolve = r
    })
    authMock.checkInPocket.mockReturnValue(pending)

    const { checkIn, checkingIn } = usePocketCheckIn()
    const first = checkIn()
    const second = await checkIn()

    // 第二次直接返回空提示，不再发请求
    expect(second).toEqual({ ok: false, message: '' })
    expect(authMock.checkInPocket).toHaveBeenCalledTimes(1)
    expect(checkingIn.value).toBe(true)

    resolve({ addExp: 1, addSupport: 1, addMoney: 0, days: 0 })
    await first
    expect(checkingIn.value).toBe(false)
  })
})
