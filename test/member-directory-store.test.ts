import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * stores/member-directory：成员名录（按 userId 反查合并详情）的缓存与失效语义。
 *
 * 盯住五件事：
 * - 并发反查只发一次请求（直播页与回放页相继点开抽屉）；
 * - members-updated 只**作废**、不立刻重拉 —— 没人开抽屉时不白跑请求，
 *   且下一次反查拿到的是新资料（立刻重拉会赶在 member-tree 作废之前读走旧树）；
 * - 失败不留坏缓存；
 * - 反查键归一化：列表接口给 string、成员树给 number，脏值（'123abc'）判无效而不是截断成 123 误命中；
 * - 官方账号索引（officialInfo）与成员名录互不污染：官方号（袋王）查得到且不进成员索引。
 *
 * store 状态在模块作用域，每个用例都 resetModules 后重新 import，拿到干净的单例。
 */

interface TreeMember {
  userId: number
  realName: string
}

/** 造一棵最小可用的成员树：一个团体 → 一支队伍 → 若干成员 */
function treeOf(members: TreeMember[]) {
  return [{
    groupName: 'SNH48',
    groupId: 10,
    children: [{
      teamName: 'TEAM SII',
      teamBadge: '',
      children: members.map(member => ({ ...member, avatar: '', nickname: '' })),
    }],
  }]
}

/** 造一条 allmembers 记录：靠 pocket_id 认领到树上的同名成员，带出官网独有的 ranking */
function record(userId: number, name: string, ranking: string) {
  return { sname: name, pocket_id: String(userId), ranking }
}

interface SetupOptions {
  getMemberTree: () => Promise<unknown>
  getAllMembers: () => Promise<unknown>
}

async function setup({ getMemberTree, getAllMembers }: SetupOptions) {
  vi.resetModules()
  const getMemberTreeMock = vi.fn(getMemberTree)
  const getAllMembersMock = vi.fn(getAllMembers)
  vi.stubGlobal('window', { mainAPI: { getMemberTree: getMemberTreeMock, getAllMembers: getAllMembersMock } })
  // 同时 import：resetModules 之后两者拿到同一份新模块图，store 内订阅的就是这个 emitter
  const [{ useMemberDirectoryStore }, { default: EventBus }] = await Promise.all([
    import('@renderer/stores/member-directory'),
    import('@renderer/services/event-bus'),
  ])
  return { store: useMemberDirectoryStore(), EventBus, getMemberTreeMock, getAllMembersMock }
}

/** 常规场景：树上一个人，官网那条记录带排名 */
function singleMember(ranking: string) {
  return {
    getMemberTree: async () => treeOf([{ userId: 9001, realName: '甲' }]),
    getAllMembers: async () => ({ allmembers: [record(9001, '甲', ranking)] }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('成员名录的读取与失效', () => {
  it('并发反查只拉一次请求（树与名单各一次）', async () => {
    const { store, getMemberTreeMock, getAllMembersMock } = await setup(singleMember('5'))

    const [a, b] = await Promise.all([store.findMemberByUserId('9001'), store.findMemberByUserId(9001)])

    expect(getMemberTreeMock).toHaveBeenCalledTimes(1)
    expect(getAllMembersMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('缓存复用：未失效时第二次反查不再发请求', async () => {
    const { store, getAllMembersMock } = await setup(singleMember('5'))

    await store.findMemberByUserId('9001')
    await store.findMemberByUserId('9001')

    expect(getAllMembersMock).toHaveBeenCalledTimes(1)
  })

  it('members-updated 只作废不立刻重拉：没人开抽屉不白跑请求，下一次反查拿到新资料', async () => {
    let round = 0
    const { store, EventBus, getAllMembersMock } = await setup({
      getMemberTree: async () => treeOf([{ userId: 9001, realName: '甲' }]),
      getAllMembers: async () => ({ allmembers: [record(9001, '甲', round++ === 0 ? '5' : '9')] }),
    })

    expect((await store.findMemberByUserId('9001'))?.ranking).toBe('5')

    // 主进程已落库新资料并广播
    EventBus.emit('members-updated')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(getAllMembersMock).toHaveBeenCalledTimes(1)
    expect((await store.findMemberByUserId('9001'))?.ranking).toBe('9')
    expect(getAllMembersMock).toHaveBeenCalledTimes(2)
  })

  it('失败不留坏缓存：调用方拿到错误，下一次反查会重试成功', async () => {
    let calls = 0
    const { store } = await setup({
      getMemberTree: async () => treeOf([{ userId: 9001, realName: '甲' }]),
      getAllMembers: async () => {
        if (calls++ === 0)
          throw new Error('IPC 挂了')
        return { allmembers: [] }
      },
    })

    await expect(store.findMemberByUserId('9001')).rejects.toThrow('IPC 挂了')
    expect((await store.findMemberByUserId('9001'))?.realName).toBe('甲')
  })
})

describe('成员名录的 userId 反查', () => {
  it('number / string 都能命中，且详情含 allmembers 独有的字段', async () => {
    const { store } = await setup(singleMember('5'))

    const fromString = await store.findMemberByUserId('9001')

    expect(fromString?.realName).toBe('甲')
    expect(fromString).toBe(await store.findMemberByUserId(9001))
    // 只读成员树的话这里恒为空串 —— 反证名录确实合并了 allmembers
    expect(fromString?.ranking).toBe('5')
  })

  it('脏值与空值判为无效，不截断成数字误命中别人', async () => {
    const { store } = await setup({
      getMemberTree: async () => treeOf([{ userId: 123, realName: '丙' }, { userId: 9001, realName: '甲' }]),
      getAllMembers: async () => ({ allmembers: [] }),
    })

    // parseInt('123abc') 会得到 123，命中「丙」——必须判为无效
    expect(await store.findMemberByUserId('123abc')).toBeNull()
    expect(await store.findMemberByUserId('')).toBeNull()
    expect(await store.findMemberByUserId('   ')).toBeNull()
    expect(await store.findMemberByUserId(undefined)).toBeNull()
    expect(await store.findMemberByUserId(null)).toBeNull()
    // 名录里查无此人（成员库未同步 / 官网独有的成员）
    expect(await store.findMemberByUserId('9002')).toBeNull()
  })
})

/**
 * 官方账号（officialInfo）是「用户关注的官方频道」的取名与头像来源：
 * 官方号字段与成员记录同构但不是成员，两张索引必须彼此独立。
 */
describe('官方账号索引', () => {
  it('官方号按 userId 反查，头像归一化为绝对地址，且不混进成员名录', async () => {
    const { store } = await setup({
      getMemberTree: async () => treeOf([{ userId: 9001, realName: '甲' }]),
      getAllMembers: async () => ({
        allmembers: [record(9001, '甲', '5')],
        officials: [{ userId: 63, realName: '袋王', nickname: '袋王', avatar: '/mediasource/avatar/daiwang.jpg' }],
      }),
    })

    // 原始头像是 /mediasource/... 相对路径，与成员头像同款归一化（空进空出，不拼垃圾 URL）
    expect(await store.findOfficialAccount(63)).toEqual({
      userId: 63,
      name: '袋王',
      avatar: 'https://source.48.cn/mediasource/avatar/daiwang.jpg',
    })
    // string 键同样命中：关注名单与接口给的类型不保证一致
    await expect(store.findOfficialAccount('63')).resolves.toBe(await store.findOfficialAccount(63))
    // 关键：官方号不进成员索引——选举页 / 详情抽屉不会把袋王当成员渲染
    expect(await store.findMemberByUserId(63)).toBeNull()
    // 反向同样成立：成员不会被官方索引认领
    expect(await store.findOfficialAccount(9001)).toBeNull()
  })

  it('显示名 realName 优先、退 nickname；脏 userId 丢弃而不是挂到别的账号上', async () => {
    const { store } = await setup({
      getMemberTree: async () => treeOf([]),
      getAllMembers: async () => ({
        allmembers: [],
        officials: [
          { userId: 5973, nickname: 'SNH48', avatar: '' },
          { userId: 'abc', realName: '脏值' },
        ],
      }),
    })

    expect((await store.findOfficialAccount(5973))?.name).toBe('SNH48')
    expect((await store.findOfficialAccount(5973))?.avatar).toBe('')
    expect(await store.findOfficialAccount('abc')).toBeNull()
    expect(await store.findOfficialAccount(null)).toBeNull()
    // 索引里没有的 id（普通成员的 userId）同样返回 null，由调用方降级
    expect(await store.findOfficialAccount(9001)).toBeNull()
  })

  it('载荷缺 officials（旧主进程 / 成员库未同步）不抛错：官方号查不到，成员照常', async () => {
    const { store } = await setup(singleMember('5'))

    expect(await store.findOfficialAccount(63)).toBeNull()
    expect((await store.findMemberByUserId('9001'))?.realName).toBe('甲')
  })
})
