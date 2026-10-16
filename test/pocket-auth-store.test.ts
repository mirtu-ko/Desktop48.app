/**
 * stores/pocket-auth 的登录态写入门户（applyAuthState）与它顺带承担的一件事：
 * 账号身份一变就作废小房间暗号的解锁态（utils/small-room-unlock.ts）。
 *
 * 为什么盯这条：小房间频道 id 跨账号稳定，而消息列表接口不带暗号——
 * 解锁表若跟着上一个账号留到下一个账号，等于门禁白送。
 * 登录态里没有 userId，身份只能靠「脱敏手机号 + 昵称 + 凭证保存时刻」指纹判定，
 * 所以同账号重复刷新（指纹不变）绝不能误清，否则用户每次轮询都会被踢出小房间。
 */
import type { PocketAuthState } from '@preload/ipc-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT_A: PocketAuthState = {
  loggedIn: true,
  nickname: '甲',
  avatar: '',
  mobileMasked: '139****0001',
  plainFallback: false,
  savedAt: 1000,
}
const ACCOUNT_B: PocketAuthState = { ...ACCOUNT_A, nickname: '乙', mobileMasked: '139****0002', savedAt: 2000 }

async function setup(initial: PocketAuthState) {
  vi.resetModules()
  let current = initial
  vi.stubGlobal('window', {
    mainAPI: {
      // IPC 回包每次都是新对象，桩照此返回副本，逼出「按值比指纹」而不是「按引用比对象」
      pocketGetAuthState: vi.fn(async () => ({ ...current })),
      pocketLogout: vi.fn(async () => {}),
    },
  })
  const store = await import('../src/renderer/src/stores/pocket-auth')
  const unlock = await import('../src/renderer/src/utils/small-room-unlock')
  return {
    store,
    unlock,
    /** 换到另一个账号并走一次正常刷新（模拟在设置页重新登录 / 主进程凭证文件变化） */
    switchTo: async (next: PocketAuthState) => {
      current = next
      await store.refreshPocketAuthState()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pocket-auth store / 账号变化作废小房间解锁', () => {
  it('同账号重复刷新不误作废：指纹没变就留着解锁态', async () => {
    const { store, unlock } = await setup(ACCOUNT_A)
    await store.refreshPocketAuthState()
    unlock.markSmallRoomUnlocked('ch-1-small')
    await store.refreshPocketAuthState()
    await store.refreshPocketAuthState()
    expect(unlock.isSmallRoomUnlocked('ch-1-small')).toBe(true)
  })

  it('换账号即作废：新账号不得继承上一个账号解锁过的小房间', async () => {
    const { store, unlock, switchTo } = await setup(ACCOUNT_A)
    await store.refreshPocketAuthState()
    unlock.markSmallRoomUnlocked('ch-1-small')
    await switchTo(ACCOUNT_B)
    expect(unlock.isSmallRoomUnlocked('ch-1-small')).toBe(false)
  })

  it('退出登录即作废：重新登录同一账号也要重新输暗号', async () => {
    const { store, unlock, switchTo } = await setup(ACCOUNT_A)
    // 先真正登进 A（登录态镜像初值是「未登录」，不同步这一步的话测不出「身份变化」）
    await store.refreshPocketAuthState()
    unlock.markSmallRoomUnlocked('ch-1-small')
    await store.logoutPocket()
    expect(unlock.isSmallRoomUnlocked('ch-1-small')).toBe(false)
    await switchTo(ACCOUNT_A)
    expect(unlock.isSmallRoomUnlocked('ch-1-small')).toBe(false)
  })
})
