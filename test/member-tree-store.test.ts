import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * stores/member-tree：成员树单例缓存的失效语义。
 *
 * 这条链路出的 bug 是「新增成员选不到」：成员同步完成后，被 keep-alive 缓存的回放页
 * 仍停在旧快照上。所以要盯住三件事：
 * - 并发读只发一次请求（成员页与回放页相继挂载）；
 * - 数据变更（members-updated）后作废重拉，且**紧接着的读方拿到的是新树**，不是失效前的旧值；
 * - 失败不留坏缓存，下一次读仍可重试。
 *
 * store 状态在模块作用域，每个用例都 resetModules 后重新 import，拿到干净的单例。
 */

type Tree = Array<{
  value: string
  children: Array<{ value: string, children: Array<{ label: string, value: string }> }>
}>

/** 造一棵最小可用的成员树：一个团体 → 一支队伍 → 一个成员 */
function treeOf(memberName: string): Tree {
  return [{
    value: '10',
    children: [{ value: '1001', children: [{ label: memberName, value: '9001' }] }],
  }]
}

/** 取叶子上的成员名，用来断言读到的是哪一版快照 */
function leafName(list: Tree): string {
  return list[0].children[0].children[0].label
}

async function setup(getMemberTree: () => Promise<unknown>) {
  vi.resetModules()
  const getMemberTreeMock = vi.fn(getMemberTree)
  vi.stubGlobal('window', { mainAPI: { getMemberTree: getMemberTreeMock } })
  // 同时 import：resetModules 之后两者拿到同一份新模块图，store 内订阅的就是这个 emitter
  const [{ useMemberTreeStore }, { default: EventBus }] = await Promise.all([
    import('@renderer/stores/member-tree'),
    import('@renderer/services/event-bus'),
  ])
  return { store: useMemberTreeStore(), EventBus, getMemberTreeMock }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('成员树 store 的读取与失效', () => {
  it('并发读只拉一次请求，两个读方拿到同一份树', async () => {
    const { store, getMemberTreeMock } = await setup(async () => treeOf('甲'))

    const [a, b] = await Promise.all([store.loadTree(), store.loadTree()])

    expect(getMemberTreeMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(store.memberTree.value).toBe(a)
  })

  it('缓存复用：未失效时第二次读不再发请求', async () => {
    const { store, getMemberTreeMock } = await setup(async () => treeOf('甲'))

    await store.loadTree()
    await store.loadTree()

    expect(getMemberTreeMock).toHaveBeenCalledTimes(1)
  })

  it('members-updated 后作废并重拉，紧接着的读方拿到新树（新增成员可被选中）', async () => {
    let round = 0
    const { store, EventBus, getMemberTreeMock } = await setup(async () => treeOf(round++ === 0 ? '旧成员' : '新成员'))

    await store.loadTree()
    expect(leafName(store.memberTree.value)).toBe('旧成员')

    // 主进程已落库新成员并广播；随后回放页马上读树
    EventBus.emit('members-updated')
    const fresh = await store.loadTree()

    expect(leafName(fresh)).toBe('新成员')
    expect(store.memberTree.value).toBe(fresh)
    expect(getMemberTreeMock).toHaveBeenCalledTimes(2)
  })

  it('失败不留坏缓存：调用方拿到错误，下一次读会重试成功', async () => {
    let calls = 0
    const { store } = await setup(async () => {
      if (calls++ === 0)
        throw new Error('IPC 挂了')
      return treeOf('甲')
    })

    await expect(store.loadTree()).rejects.toThrow('IPC 挂了')
    await expect(store.loadTree()).resolves.toBeTruthy()
    expect(leafName(store.memberTree.value)).toBe('甲')
  })

  it('事件触发的重拉失败只记录日志：没有发起方承接错误，不能变成未处理的拒绝', async () => {
    const { EventBus, getMemberTreeMock } = await setup(async () => {
      throw new Error('IPC 挂了')
    })

    EventBus.emit('members-updated')
    // 等重拉那次请求的 reject 走完 catch
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(getMemberTreeMock).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith('[member-tree]成员树重载失败:', expect.any(Error))
  })
})
