import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMember } from './fixtures/member'

/**
 * stores/member-flags 的口袋关注合并（mergeFromPocket）与
 * use-member-actions 的双写编排（策略 A 的渲染侧两半），
 * 以及关注 / 屏蔽的正交关系（屏蔽不连带取关，见 use-member-actions 的文件头）。
 *
 * store 是模块级单例：每个用例都 resetModules 后重新 import，拿到干净状态。
 */

const { ElMessageMock } = vi.hoisted(() => {
  // ElMessage 既可调用、又挂着 error/success/warning 静态方法：Object.assign 一次给全，
  // 逐个赋值不成立（vi.fn() 的函数类型上写这些属性属于新增属性）
  const mock = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
  return { ElMessageMock: mock }
})
vi.mock('element-plus', () => ({ ElMessage: ElMessageMock }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface FlagEntry {
  userId: number
  realName: string
  teamColor: string
}

interface SetupOptions {
  loggedIn: boolean
  /** 主进程 getMemberFlags 的初始解析结果（本地成员树里查得到的人） */
  flags?: FlagEntry[]
  /** 初始屏蔽名单（kind='blocked'）：验证屏蔽优先与「屏遮不改关注」的起点 */
  blockedFlags?: FlagEntry[]
  /** true = 服务端关注写入抛错（双写失败降级场景） */
  followWriteFails?: boolean
}

async function setup({ loggedIn, flags: initialFlags = [], blockedFlags: initialBlocked = [], followWriteFails = false }: SetupOptions) {
  vi.resetModules()
  const calls = {
    addMemberFlag: [] as Array<[string, number]>,
    removeMemberFlag: [] as Array<[string, number]>,
    addMemberFlags: [] as Array<[string, number[]]>,
    pocketFollow: [] as number[],
    pocketUnfollow: [] as number[],
  }
  // 假主进程：addMemberFlag 落库后 getMemberFlags 能读到（真实链路由 Database 保证）；
  // 两类名单各存一份，getMemberFlags 按 kind 分派
  let flags: FlagEntry[] = [...initialFlags]
  let blocked: FlagEntry[] = [...initialBlocked]
  const entryOf = (userId: number) => ({ userId, realName: `用户${userId}`, teamColor: '' })
  vi.stubGlobal('window', {
    mainAPI: {
      getMemberFlags: vi.fn(async (kind: string) => (kind === 'blocked' ? blocked : flags)),
      addMemberFlag: vi.fn(async (kind: string, userId: number) => {
        calls.addMemberFlag.push([kind, userId])
        if (kind === 'blocked')
          blocked = [...blocked, entryOf(userId)]
        else
          flags = [...flags, entryOf(userId)]
      }),
      removeMemberFlag: vi.fn(async (kind: string, userId: number) => {
        calls.removeMemberFlag.push([kind, userId])
        if (kind === 'blocked')
          blocked = blocked.filter(member => member.userId !== userId)
        else
          flags = flags.filter(member => member.userId !== userId)
      }),
      addMemberFlags: vi.fn(async (kind: string, userIds: number[]) => {
        calls.addMemberFlags.push([kind, userIds])
        if (kind === 'followed')
          flags = [...flags, ...userIds.map(entryOf)]
      }),
      pocketGetAuthState: vi.fn(async () => ({
        loggedIn,
        nickname: '',
        avatar: '',
        mobileMasked: '',
        plainFallback: false,
        savedAt: 0,
      })),
      pocketFollowMember: vi.fn(async (userId: number) => {
        if (followWriteFails)
          throw new Error('network down')
        calls.pocketFollow.push(userId)
      }),
      pocketUnfollowMember: vi.fn(async (userId: number) => {
        if (followWriteFails)
          throw new Error('network down')
        calls.pocketUnfollow.push(userId)
      }),
    },
  })
  const [{ useBlockedMembersStore, useFollowedMembersStore }, { useMemberActions }] = await Promise.all([
    import('@renderer/stores/member-flags'),
    import('@renderer/composables/use-member-actions'),
  ])
  return {
    store: useFollowedMembersStore(),
    blockedStore: useBlockedMembersStore(),
    actions: useMemberActions(),
    calls,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('mergeFromPocket（口袋关注合并，只增不删）', () => {
  it('批量落库后重拉，返回合并后总数', async () => {
    const { store, calls } = await setup({ loggedIn: true })
    const total = await store.mergeFromPocket([10001, 10002])
    expect(calls.addMemberFlags).toEqual([['followed', [10001, 10002]]])
    expect(total).toBe(2)
    expect(store.followedMembers.value.map(member => member.userId)).toEqual([10001, 10002])
  })

  it('脏 id 被过滤，合法 id 原样合并', async () => {
    const { store, calls } = await setup({ loggedIn: true })
    await store.mergeFromPocket([1, 0, -5, Number.NaN, '3' as unknown as number])
    expect(calls.addMemberFlags).toEqual([['followed', [1, 3]]])
  })

  it('空列表不写库但仍重拉（合并结果以主进程解析为准）', async () => {
    const { store, calls } = await setup({ loggedIn: true, flags: [{ userId: 7, realName: '甲', teamColor: '' }] })
    const total = await store.mergeFromPocket([])
    expect(calls.addMemberFlags).toEqual([])
    expect(total).toBe(1)
  })

  it('isFollowed 覆盖合并进来的 id（数字/字符串归一化）', async () => {
    const { store } = await setup({ loggedIn: true })
    await store.mergeFromPocket([10001])
    expect(store.isFollowed(10001)).toBe(true)
    expect(store.isFollowed('10001')).toBe(true)
    expect(store.isFollowed(999)).toBe(false)
  })
})

describe('toggleFollowMember 双写口袋关注', () => {
  it('新关注：本地落库 + pocketFollowMember', async () => {
    const { actions, calls } = await setup({ loggedIn: true })
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(calls.pocketFollow).toEqual([10001])
    expect(calls.pocketUnfollow).toEqual([])
  })

  it('取消关注：本地移除 + pocketUnfollowMember', async () => {
    const { store, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.removeMemberFlag).toEqual([['followed', 10001]])
    expect(calls.pocketUnfollow).toEqual([10001])
    expect(calls.pocketFollow).toEqual([])
  })

  it('未登录：只操作本地，不双写', async () => {
    const { actions, calls } = await setup({ loggedIn: false })
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(calls.pocketFollow).toEqual([])
  })

  it('双写失败静默降级：本地状态已生效，不向调用方抛错', async () => {
    const { actions, calls } = await setup({ loggedIn: true, followWriteFails: true })
    await expect(actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))).resolves.toBeUndefined()
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(ElMessageMock).toHaveBeenCalled()
  })

  it('点关注顺带解除屏蔽（唯一保留的互斥方向：用户在表达「我要看 TA」）', async () => {
    const { store, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    // 先造成「已屏蔽」状态，再关注应解除屏蔽
    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toContainEqual(['blocked', 10001])
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.removeMemberFlag).toContainEqual(['blocked', 10001])
    expect(calls.pocketFollow).toEqual([10001])
    expect(store.isFollowed(10001)).toBe(true)
  })
})

describe('屏蔽与关注正交（屏蔽不再连带取关）', () => {
  it('屏蔽已关注成员：关注名单原样保留，也不向账号取关', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.addMemberFlag).toEqual([['blocked', 10001]])
    // 屏蔽只动屏蔽名单。若这里删了本地关注，下一次 mergeFromPocket 会把账号关注并回
    // 本地（只增不删），形成「既屏蔽又关注」；而账号取关更是用户没点过的操作
    expect(calls.removeMemberFlag).toEqual([])
    expect(calls.pocketUnfollow).toEqual([])
    expect(store.isFollowed(10001)).toBe(true)
    expect(blockedStore.isBlocked(10001)).toBe(true)
  })

  it('已屏蔽且账号侧已关注：点关注只解屏蔽，不重复写名单、不双写', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(calls.addMemberFlag).toEqual([])
    expect(calls.pocketFollow).toEqual([])
    expect(calls.pocketUnfollow).toEqual([])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })

  it('已屏蔽且未关注：点关注解屏蔽并关注，照常双写口袋', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(calls.pocketFollow).toEqual([10001])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })

  it('解除屏蔽同样不动关注名单（关注始终由账号维度决定）', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })
})
