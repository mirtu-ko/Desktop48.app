import type { LiveListItem } from '../src/renderer/src/services/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
function stubMainApi(api: { getBlockedMembers?: () => Promise<any[]>, getMemberInfo?: (_userId: number) => Promise<any> }) {
  vi.stubGlobal('window', {
    mainAPI: {
      getBlockedMembers: api.getBlockedMembers ?? (async () => []),
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
    stubMainApi({ getBlockedMembers: async () => [blocked(10)] })
    const list = usePagedLiveList({
      loadPage: () => ({ next: '0', liveList: [liveItem('a', '10'), liveItem('b', '11')] }),
    })

    await list.getList()

    expect(list.list.value.map(i => i.liveId)).toEqual(['b'])
  })

  it('取消屏蔽后同一场直播重新出现（每页都重拉名单，不吃缓存）', async () => {
    let blockedIds: number[] = [10]
    stubMainApi({ getBlockedMembers: async () => blockedIds.map(blocked) })

    const pages = [
      { next: '2', liveList: [liveItem('a', '10')] },
      { next: '0', liveList: [liveItem('b', '10')] },
    ]
    let call = 0
    const list = usePagedLiveList({ loadPage: () => pages[call++] })

    await list.getList()
    expect(list.list.value).toEqual([])

    blockedIds = []
    await list.getList()
    expect(list.list.value.map(i => i.liveId)).toEqual(['b'])
  })

  it('filterBlocked=false 时完全不拉屏蔽名单（成员页等非直播场景）', async () => {
    const getBlockedMembers = vi.fn(async () => [blocked(10)])
    stubMainApi({ getBlockedMembers })
    const list = usePagedLiveList({
      filterBlocked: false,
      loadPage: () => ({ next: '0', liveList: [liveItem('a', '10')] }),
    })

    await list.getList()

    expect(getBlockedMembers).not.toHaveBeenCalled()
    expect(list.list.value.map(i => i.liveId)).toEqual(['a'])
  })
})

describe('enrichLiveItem（列表条目展示信息补全）', () => {
  const created = new Date(2026, 8, 5, 2, 3, 4).getTime()

  it('封面 / 队伍 Logo 归一化，ctime 转可读日期，并挂上成员', async () => {
    stubMainApi({ getMemberInfo: async () => ({ userId: 1, realName: '成员一', teamColor: '#f00' }) })
    const item = liveItem('a', '1', {
      ctime: String(created),
      coverPath: '/cover/a.jpg,/cover/b.jpg',
    })
    item.userInfo.teamLogo = '/team/logo.png'

    await enrichLiveItem(item)

    expect(item.cover).toEqual(['https://source.48.cn/cover/a.jpg', 'https://source.48.cn/cover/b.jpg'])
    expect(item.userInfo.teamLogo).toEqual(['https://source.48.cn/team/logo.png'])
    expect(item.date).toBe('2026-09-05 02:03:04')
    expect(item.member).toEqual({ userId: 1, realName: '成员一', teamColor: '#f00' })
  })

  it('字段缺失时降级为空数组而不是抛错（列表不能因单条脏数据整页失败）', async () => {
    stubMainApi({})
    const item = liveItem('a', '1')

    await enrichLiveItem(item)

    expect(item.cover).toEqual([])
    expect(item.userInfo.teamLogo).toEqual([])
  })

  it('memberError=\'fallback\'：成员查询失败置 null 并继续（直播页逐条容错）', async () => {
    stubMainApi({
      getMemberInfo: async () => {
        throw new Error('boom')
      },
    })
    const item = liveItem('a', '1', { coverPath: '/a.jpg' })

    await expect(enrichLiveItem(item, 'fallback')).resolves.toBeUndefined()
    expect(item.member).toBeNull()
    // 成员失败不影响其余字段补全
    expect(item.cover).toEqual(['https://source.48.cn/a.jpg'])
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
})
