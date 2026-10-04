import type { LiveListItem } from '../src/renderer/src/services/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import { enrichLiveItem, usePagedLiveList } from '../src/renderer/src/composables/use-paged-live-list'

vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

/** 只声明被测字段，其余留空；真实条目字段远多于此处 */
function liveItem(liveId: string, userId: string, extra: Record<string, unknown> = {}): LiveListItem {
  return { liveId, coverPath: '', ctime: '0', userInfo: { userId, nickname: '' }, ...extra } as unknown as LiveListItem
}

function blocked(userId: number) {
  return { userId, realName: `成员${userId}`, teamColor: '#f00' }
}

/** preload 暴露的 mainAPI 替身（Node 环境没有 window） */
function stubMainApi(api: { getMemberFlags?: (_kind: string) => Promise<any[]>, getMemberInfo?: (_userId: number) => Promise<any> }) {
  vi.stubGlobal('window', {
    mainAPI: {
      getMemberFlags: api.getMemberFlags ?? (async () => []),
      getMemberInfo: api.getMemberInfo ?? (async () => undefined),
    },
  })
}

beforeEach(() => {
  // 降级路径会 console.error；用例只关心状态
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('usePagedLiveList（{ next, liveList } 响应适配）', () => {
  it('把 liveList 适配成 items 并透传游标', async () => {
    stubMainApi({})
    const list = usePagedLiveList({ loadPage: () => ({ next: '2', liveList: [liveItem('a', '1')] }) })

    await expect(list.getList()).resolves.toBe(true)
    expect(list.list.value.map(i => i.liveId)).toEqual(['a'])
    expect(list.listNext.value).toBe('2')
    expect(list.noMore.value).toBe(false)
  })

  it('liveList 缺失按空页处理（无更多，不再往下请求）', async () => {
    stubMainApi({})
    const list = usePagedLiveList({
      loadPage: () => ({ next: '2' }) as unknown as { next: string, liveList: LiveListItem[] },
    })

    await list.getList()
    expect(list.list.value).toEqual([])
    expect(list.noMore.value).toBe(true)
  })
})

describe('usePagedLiveList 屏蔽成员过滤', () => {
  it('默认过滤掉被屏蔽的成员（userId 来自接口的字符串）', async () => {
    stubMainApi({ getMemberFlags: async () => [blocked(10)] })
    // 过滤读的是跨页共享的屏蔽 store，列表自身不再另建副本
    const { useBlockedMembersStore } = await import('../src/renderer/src/stores/member-flags')
    await useBlockedMembersStore().refreshBlockedMembers()

    const list = usePagedLiveList({
      loadPage: () => ({ next: '0', liveList: [liveItem('a', '10'), liveItem('b', '11')] }),
    })

    await list.getList()

    expect(list.list.value.map(i => i.liveId)).toEqual(['b'])
  })

  it('解除屏蔽后同一场直播立即重新出现（过滤读共享 store，翻页不额外拉名单）', async () => {
    // 名单由用例持有：解除屏蔽后重新 refresh 即可反映，不必依赖 removeMemberFlag 的副作用
    let blockedIds: number[] = [10]
    stubMainApi({ getMemberFlags: async () => blockedIds.map(blocked) })
    const { useBlockedMembersStore } = await import('../src/renderer/src/stores/member-flags')
    const store = useBlockedMembersStore()
    await store.refreshBlockedMembers()

    const pages = [
      { next: '2', liveList: [liveItem('a', '10')] },
      { next: '0', liveList: [liveItem('b', '10')] },
    ]
    let call = 0
    const list = usePagedLiveList({ loadPage: () => pages[call++] })

    await list.getList()
    expect(list.list.value).toEqual([])

    // 屏蔽解除只改 store 一份数据，下一页立刻反映，无需重新请求接口
    blockedIds = []
    await store.refreshBlockedMembers()
    await list.getList()
    expect(list.list.value.map(i => i.liveId)).toEqual(['b'])
  })

  it('filterBlocked=false 时完全不读屏蔽名单（成员页等非直播场景）', async () => {
    const getMemberFlags = vi.fn(async () => [blocked(10)])
    stubMainApi({ getMemberFlags })
    const list = usePagedLiveList({
      filterBlocked: false,
      loadPage: () => ({ next: '0', liveList: [liveItem('a', '10')] }),
    })

    await list.getList()

    expect(getMemberFlags).not.toHaveBeenCalled()
    expect(list.list.value.map(i => i.liveId)).toEqual(['a'])
  })
})

describe('enrichLiveItem（列表条目展示信息补全）', () => {
  const created = new Date(2026, 8, 5, 2, 3, 4).getTime()

  it('返回新对象：封面归一化、ctime 转可读日期、挂上成员，入参保持原样', async () => {
    stubMainApi({ getMemberInfo: async () => ({ userId: 1, realName: '成员一', teamColor: '#f00' }) })
    const item = liveItem('a', '1', {
      ctime: String(created),
      coverPath: '/cover/a.jpg,/cover/b.jpg',
    })
    item.userInfo.teamLogo = '/team/logo.png'

    const view = await enrichLiveItem(item)

    expect(view.cover).toEqual(['https://source.48.cn/cover/a.jpg', 'https://source.48.cn/cover/b.jpg'])
    expect(view.date).toBe('2026-09-05 02:03:04')
    expect(view.member).toEqual({ userId: 1, realName: '成员一', teamColor: '#f00' })
    // teamLogo 不再被归一化：卡片队伍徽章走 member.teamName，改它只会让接口模型失真
    expect(view.userInfo.teamLogo).toBe('/team/logo.png')
    // 入参是接口 payload，不得被塞进派生字段
    expect(item).not.toHaveProperty('cover')
    expect(item).not.toHaveProperty('date')
    expect(item).not.toHaveProperty('member')
  })

  it('同一条目重复补全结果一致（补全是纯函数，不因调用次数而抛错）', async () => {
    stubMainApi({ getMemberInfo: async () => undefined })
    const item = liveItem('a', '1', { ctime: String(created), coverPath: '/a.jpg' })

    const first = await enrichLiveItem(item)
    const second = await enrichLiveItem(item)

    expect(second).toEqual(first)
  })

  it('字段缺失时降级为空数组而不是抛错（列表不能因单条脏数据整页失败）', async () => {
    stubMainApi({})
    const item = liveItem('a', '1')

    const view = await enrichLiveItem(item)

    expect(view.cover).toEqual([])
    expect(view.member).toBeNull()
  })

  it('memberError=\'fallback\'：成员查询失败置 null 并继续（直播页逐条容错）', async () => {
    stubMainApi({
      getMemberInfo: async () => {
        throw new Error('boom')
      },
    })
    const item = liveItem('a', '1', { coverPath: '/a.jpg' })

    const view = await enrichLiveItem(item, 'fallback')
    expect(view.member).toBeNull()
    // 成员失败不影响其余字段补全
    expect(view.cover).toEqual(['https://source.48.cn/a.jpg'])
  })

  it('默认（throw）：成员查询失败向上抛，交由 usePagedList 的 stopOnError 接管', async () => {
    stubMainApi({
      getMemberInfo: async () => {
        throw new Error('boom')
      },
    })

    await expect(enrichLiveItem(liveItem('a', '1'))).rejects.toThrow('boom')
  })

  it('接入分页链路：processItem 抛错 + stopOnError=true 时整批停止（回放页口径）', async () => {
    stubMainApi({
      getMemberInfo: async () => {
        throw new Error('boom')
      },
    })
    const list = usePagedLiveList({
      stopOnError: true,
      loadPage: () => ({ next: '2', liveList: [liveItem('a', '1')] }),
      processItem: item => enrichLiveItem(item),
    })

    await expect(list.getList()).resolves.toBe(false)
    expect(list.loadFailed.value).toBe(true)
    expect(list.noMore.value).toBe(true)
    expect(list.list.value).toEqual([])
  })

  it('接入分页链路：processItem 返回的新对象会替换列表条目（cover/date/member 就绪）', async () => {
    stubMainApi({ getMemberInfo: async () => ({ userId: 1, realName: '成员一', teamColor: '#f00' }) })
    const raw = liveItem('a', '1', { ctime: String(created), coverPath: '/a.jpg' })
    const list = usePagedLiveList({
      loadPage: () => ({ next: '0', liveList: [raw] }),
      processItem: item => enrichLiveItem(item),
    })

    await list.getList()

    const entry = list.list.value[0]
    expect(entry.cover).toEqual(['https://source.48.cn/a.jpg'])
    expect(entry.member).toEqual({ userId: 1, realName: '成员一', teamColor: '#f00' })
    // 列表里存的是补全后的新对象，不是接口原对象
    expect(entry).not.toBe(raw)
  })

  it('processItem 什么都不返回时沿用原对象（就地修改的旧写法不被打破）', async () => {
    stubMainApi({})
    const raw = liveItem('a', '1')
    const list = usePagedLiveList({
      loadPage: () => ({ next: '0', liveList: [raw] }),
      // 有意返回 undefined：调用方只做副作用，不产出新对象
      processItem: (item) => {
        expect(item.liveId).toBe('a')
      },
    })

    await list.getList()

    // 没有派生字段被凭空写上去 → 说明列表元素就是接口原对象本身，没有被替换成副本
    expect(toRaw(list.list.value[0])).toBe(raw)
    expect(list.list.value[0]).not.toHaveProperty('cover')
  })
})

/**
 * 首灌保证（回归）：名单 store 是模块级单例，启动后若直奔直播页、从未访问过
 * 成员页 / 设置页，它仍是初始空名单 —— 此时直接过滤等于放行全部被屏蔽成员。
 * 过滤链路必须自己保证名单已加载过。
 *
 * ⚠️ 用 resetModules 取全新单例来复现"刚启动"状态，会重置整个模块注册表，
 * 故本 describe 必须留在文件末尾，否则会污染后续用例共享的 store 实例。
 */
describe('屏蔽名单首灌（启动后未预加载的场景）', () => {
  it('列表从未预加载也能正确过滤，且首灌只请求一次名单', async () => {
    vi.resetModules()
    const getMemberFlags = vi.fn(async () => [blocked(10)])
    stubMainApi({ getMemberFlags })

    const { usePagedLiveList: useFreshPagedLiveList } = await import('../src/renderer/src/composables/use-paged-live-list')
    const list = useFreshPagedLiveList({
      loadPage: () => ({ next: '0', liveList: [liveItem('a', '10'), liveItem('b', '11')] }),
    })

    await list.getList()

    expect(list.list.value.map(i => i.liveId)).toEqual(['b'])
    expect(getMemberFlags).toHaveBeenCalledTimes(1)
  })

  it('ensureBlockedLoaded 幂等：并发调用合并成一次 IPC，已加载后不再请求', async () => {
    vi.resetModules()
    const getMemberFlags = vi.fn(async () => [blocked(10)])
    stubMainApi({ getMemberFlags })

    const { useBlockedMembersStore } = await import('../src/renderer/src/stores/member-flags')
    const store = useBlockedMembersStore()

    // 未加载时名单为空 —— 这正是原缺陷的根因：isBlocked 恒为 false
    expect(store.isBlocked('10')).toBe(false)

    await Promise.all([store.ensureBlockedLoaded(), store.ensureBlockedLoaded()])

    expect(store.isBlocked('10')).toBe(true)
    expect(getMemberFlags).toHaveBeenCalledTimes(1)

    await store.ensureBlockedLoaded()
    expect(getMemberFlags).toHaveBeenCalledTimes(1)
  })
})
