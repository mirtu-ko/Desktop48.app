import type { MemberTeamPromotion } from '../src/common/member-team-promotion'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 升格 store：登录态是唯一身份源，主进程只回当前账号的记录。
 * 覆盖首灌并发、未登录拒绝、换号自动重拉、订阅不随宿主组件卸载，以及「已正式升格不再覆盖」。
 */
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}))

let promotions: MemberTeamPromotion[] = []
const calls = { set: [] as MemberTeamPromotion[], remove: [] as number[] }

async function setup(loggedIn = true, userId = '20001', options: { inScope?: boolean } = {}) {
  vi.resetModules()
  promotions = []
  calls.set = []
  calls.remove = []
  const getMemberTeamPromotions = vi.fn(async () => promotions.map(item => ({ ...item })))
  vi.stubGlobal('window', {
    mainAPI: {
      getMemberTeamPromotions,
      setMemberTeamPromotion: vi.fn(async (promotion: MemberTeamPromotion) => {
        calls.set.push(promotion)
        promotions = [...promotions.filter(item => item.userId !== promotion.userId), promotion]
      }),
      removeMemberTeamPromotion: vi.fn(async (id: number) => {
        calls.remove.push(id)
        promotions = promotions.filter(item => item.userId !== id)
      }),
      pocketAuthExpired: vi.fn(),
    },
  })
  const { pocketAuthState } = await import('../src/renderer/src/stores/pocket-auth')
  pocketAuthState.value = { ...pocketAuthState.value, loggedIn, userId, mobileMasked: '139****1234' }
  const { useMemberTeamPromotionStore } = await import('../src/renderer/src/stores/member-team-promotion')
  const { effectScope } = await import('vue')

  // inScope：复刻「store 在某个组件 setup 里首次被调用」，返回的 scope 用 stop() 复刻卸载
  const scope = options.inScope ? effectScope() : null
  const store = scope ? scope.run(() => useMemberTeamPromotionStore())! : useMemberTeamPromotionStore()
  return { store, auth: pocketAuthState, getMemberTeamPromotions, scope }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('member-team-promotion store', () => {
  it('首灌并发共用一次请求', async () => {
    const { store, getMemberTeamPromotions } = await setup()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    expect(getMemberTeamPromotions).toHaveBeenCalledTimes(1)
    await store.ensureLoaded()
    expect(getMemberTeamPromotions).toHaveBeenCalledTimes(1)
  })

  it('未登录直接拒绝写入，不发 IPC', async () => {
    const { store } = await setup(false)
    const error = await store.setPromotion({ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }).catch(caught => caught)
    expect(error).toMatchObject({ code: 'not-logged-in' })
    expect(calls.set).toEqual([])
  })

  it('写入只带升格内容；展示仅在当前仍是预备生时覆盖', async () => {
    const { store } = await setup()
    await store.ensureLoaded()
    await store.setPromotion({ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' })

    expect(calls.set[0]).toEqual({ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' })
    expect(calls.set[0]).not.toHaveProperty('ownerId')
    expect(store.displayTeamOf(10001, '预备生', 'a7b0ba'))
      .toEqual({ teamName: 'TEAM SII', teamColor: '90CCEA' })
    // 她已正式升格：本地记录不再改写展示
    expect(store.displayTeamOf(10001, 'TEAM NII', 'AD85BA'))
      .toEqual({ teamName: 'TEAM NII', teamColor: 'AD85BA' })

    await store.clearPromotion(10001)
    expect(calls.remove).toEqual([10001])
    expect(store.displayTeamOf(10001, '预备生', 'a7b0ba'))
      .toEqual({ teamName: '预备生', teamColor: 'a7b0ba' })
  })

  it('换号后自动重拉，不残留上一个账号的升格', async () => {
    const { store, auth, getMemberTeamPromotions } = await setup()
    promotions = [{ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }]
    await store.ensureLoaded()
    expect(store.promotionOf(10001)?.teamName).toBe('TEAM SII')

    promotions = [{ userId: 10002, teamName: 'TEAM NII', teamColor: 'AD85BA' }]
    auth.value = { ...auth.value, userId: '20002' }

    await vi.waitFor(() => {
      expect(store.promotionOf(10001)).toBeNull()
      expect(store.promotionOf(10002)?.teamName).toBe('TEAM NII')
    })
    expect(getMemberTeamPromotions.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('退出登录后自动清空展示', async () => {
    const { store, auth } = await setup()
    promotions = [{ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }]
    await store.ensureLoaded()
    expect(store.promotionOf(10001)).not.toBeNull()

    auth.value = { ...auth.value, loggedIn: false, userId: '', mobileMasked: '' }
    await vi.waitFor(() => {
      expect(store.promotionOf(10001)).toBeNull()
    })
  })

  it('在组件 setup 里首灌的订阅不随组件卸载而失效', async () => {
    const { store, auth, getMemberTeamPromotions, scope } = await setup(true, '20001', { inScope: true })
    promotions = [{ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }]
    await store.ensureLoaded()
    expect(store.promotionOf(10001)?.teamName).toBe('TEAM SII')

    // 宿主组件卸载：订阅若挂在它的 scope 上，会连同 watch 一起停掉
    scope!.stop()

    promotions = [{ userId: 10002, teamName: 'TEAM NII', teamColor: 'AD85BA' }]
    auth.value = { ...auth.value, userId: '20002' }
    await vi.waitFor(() => {
      expect(store.promotionOf(10001)).toBeNull()
      expect(store.promotionOf(10002)?.teamName).toBe('TEAM NII')
    })

    // 退出登录同样要清空——这条最容易在「订阅已死」时静默失效
    auth.value = { ...auth.value, loggedIn: false, userId: '', mobileMasked: '' }
    await vi.waitFor(() => {
      expect(store.promotionOf(10002)).toBeNull()
    })
    expect(getMemberTeamPromotions.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
