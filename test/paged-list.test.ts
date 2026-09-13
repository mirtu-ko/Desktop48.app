import type { PagedPage } from '../src/renderer/src/composables/use-paged-list'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePagedList } from '../src/renderer/src/composables/use-paged-list'

// 被测的是「数据怎么进列表」，与日志无关；真身 verbose 打开后会刷屏
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface Item {
  id: string
}

function item(id: string): Item {
  return { id }
}

function page(ids: string[], next = '0'): PagedPage<Item> {
  return { next, items: ids.map(item) }
}

function deferred<T>() {
  let resolve!: (_value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 等一个微任务批次，直到条件成立（避免用固定次数的 Promise.resolve 猜调度层数） */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++)
    await Promise.resolve()
}

beforeEach(() => {
  // 失败分支会 console.error；用例只关心状态，别把错误刷到测试输出里
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('usePagedList 分页加载', () => {
  it('首屏加载：追加条目、更新游标、loading 同步升起后回落', async () => {
    const list = usePagedList<Item>({ loadPage: () => page(['a', 'b'], '2') })

    const pending = list.getList()
    // loading 在首个 await 之前置位，UI 才能立刻转圈
    expect(list.loading.value).toBe(true)

    await expect(pending).resolves.toBe(true)
    expect(list.list.value.map(i => i.id)).toEqual(['a', 'b'])
    expect(list.listNext.value).toBe('2')
    expect(list.noMore.value).toBe(false)
    expect(list.loading.value).toBe(false)
    expect(list.loadFailed.value).toBe(false)
  })

  it('next 为 0（或空页）即判为无更多，触底加载随之禁用', async () => {
    const byNext = usePagedList<Item>({ loadPage: () => page(['a'], '0') })
    await byNext.getList()
    expect(byNext.noMore.value).toBe(true)
    expect(byNext.disabled.value).toBe(true)

    const byEmpty = usePagedList<Item>({ loadPage: () => page([], '5') })
    await byEmpty.getList()
    // 游标还有值但这一页是空的：同样不再往下请求，否则会一直空转
    expect(byEmpty.noMore.value).toBe(true)
  })

  it('翻页去重：接口分页边界返回重复项时不出现重复卡片', async () => {
    const pages = [page(['a', 'b'], '2'), page(['b', 'c'], '0')]
    let call = 0
    const list = usePagedList<Item>({ loadPage: () => pages[call++], itemKey: i => i.id })

    await list.getList()
    await list.getList()

    // 第二页的 'b' 与已加载的重复，只补进 'c'
    expect(list.list.value.map(i => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('itemKey 默认取 liveId：跨页返回同一场直播时只保留一条', async () => {
    const pages = [
      { next: '2', items: [{ liveId: 'a' }, { liveId: 'b' }] },
      { next: '0', items: [{ liveId: 'b' }, { liveId: 'c' }] },
    ]
    let call = 0
    const list = usePagedList<{ liveId: string }>({ loadPage: () => pages[call++] })

    await list.getList()
    await list.getList()

    expect(list.list.value.map(i => i.liveId)).toEqual(['a', 'b', 'c'])
  })

  it('条目没有 liveId 时必须显式指定 itemKey，否则翻页新数据会被整片丢弃', async () => {
    const pages = [page(['a', 'b'], '2'), page(['c', 'd'], '0')]
    // 默认 itemKey 取不到 liveId，两页条目的 key 全是 undefined：第二页会被判为"全是重复"
    let call = 0
    const withDefault = usePagedList<Item>({ loadPage: () => pages[call++] })
    await withDefault.getList()
    await withDefault.getList()
    expect(withDefault.list.value.map(i => i.id)).toEqual(['a', 'b'])

    call = 0
    const withCustom = usePagedList<Item>({ loadPage: () => pages[call++], itemKey: i => i.id })
    await withCustom.getList()
    await withCustom.getList()
    expect(withCustom.list.value.map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('过期响应整体丢弃：并发请求只有最新一次写列表', async () => {
    const first = deferred<PagedPage<Item>>()
    const second = deferred<PagedPage<Item>>()
    let call = 0
    const list = usePagedList<Item>({
      loadPage: () => (++call === 1 ? first.promise : second.promise),
    })

    const p1 = list.getList()
    const p2 = list.getList()

    second.resolve(page(['fresh'], '9'))
    await expect(p2).resolves.toBe(true)

    // 慢请求此时才回来：序号已过期，整页丢弃而不是追加
    first.resolve(page(['stale'], '1'))
    await expect(p1).resolves.toBe(false)

    expect(list.list.value.map(i => i.id)).toEqual(['fresh'])
    expect(list.listNext.value).toBe('9')
  })

  it('补全信息期间来了更新请求：本次结果整体丢弃，不写入列表', async () => {
    const gate = deferred<void>()
    let processed = 0
    let call = 0
    const list = usePagedList<Item>({
      loadPage: () => (++call === 1 ? page(['a'], '1') : page(['b'], '0')),
      processItem: () => {
        processed += 1
        return processed === 1 ? gate.promise : undefined
      },
    })

    const p1 = list.getList()
    await until(() => processed > 0)

    // 更新请求（第二轮 loadPage）在第一条补全完成前发出并写列表：refresh 先清空再重拉，
    // 关键是把 listRequestId 顶到最新，使第一条挂起补全的回包整体作废
    await list.refresh()
    expect(list.list.value.map(i => i.id)).toEqual(['b'])

    gate.resolve()
    await expect(p1).resolves.toBe(false)
    expect(list.list.value.map(i => i.id)).toEqual(['b'])
  })

  it('filterItems 先于 processItem 执行，补全只作用于过滤后的条目', async () => {
    const order: string[] = []
    const list = usePagedList<Item>({
      loadPage: () => page(['a', 'b'], '0'),
      filterItems: (items) => {
        order.push('filter')
        return items.filter(i => i.id !== 'a')
      },
      processItem: (i) => {
        order.push(`process:${i.id}`)
      },
    })

    await list.getList()

    expect(order).toEqual(['filter', 'process:b'])
    expect(list.list.value.map(i => i.id)).toEqual(['b'])
  })

  it('loadPage 抛错不冒泡：以 false 返回并置 loadFailed', async () => {
    const list = usePagedList<Item>({
      loadPage: () => {
        throw new Error('boom')
      },
    })

    await expect(list.getList()).resolves.toBe(false)
    expect(list.loadFailed.value).toBe(true)
    expect(list.loading.value).toBe(false)
    // 失败不等于「没有更多」：直播页要允许用户继续触底重试
    expect(list.noMore.value).toBe(false)
  })

  it('stopOnError=true 时失败即封死触底重试（回放页口径）', async () => {
    const list = usePagedList<Item>({
      loadPage: () => {
        throw new Error('boom')
      },
      stopOnError: true,
    })

    await list.getList()
    expect(list.loadFailed.value).toBe(true)
    expect(list.noMore.value).toBe(true)
    expect(list.disabled.value).toBe(true)
  })

  it('响应缺失 items 时以失败返回，不把垃圾写进列表', async () => {
    // 注：条目数日志 `page.items.length` 排在数组校验之前，items 缺失会先在日志处抛错、
    // 落到 catch 分支，因此这里的 noMore 取决于 stopOnError，而不是守卫里那个 noMore = true
    const list = usePagedList<Item>({ loadPage: () => ({ next: '1' }) as unknown as PagedPage<Item> })
    await expect(list.getList()).resolves.toBe(false)
    expect(list.list.value).toEqual([])
    expect(list.loadFailed.value).toBe(true)

    const strict = usePagedList<Item>({
      loadPage: () => ({ next: '1' }) as unknown as PagedPage<Item>,
      stopOnError: true,
    })
    await strict.getList()
    expect(strict.noMore.value).toBe(true)
  })

  it('items 是非数组脏值（如对象）时走数组校验分支并封死触底重试', async () => {
    const list = usePagedList<Item>({
      loadPage: () => ({ next: '1', items: {} }) as unknown as PagedPage<Item>,
    })

    await expect(list.getList()).resolves.toBe(false)
    expect(list.loadFailed.value).toBe(true)
    expect(list.noMore.value).toBe(true)
    expect(list.list.value).toEqual([])
  })
})

describe('usePagedList 刷新语义（refresh / reset）', () => {
  it('refresh 清空列表后重拉第一页（手动刷新 / 下架重载）', async () => {
    let call = 0
    const list = usePagedList<Item>({
      loadPage: () => (++call === 1 ? page(['a'], '2') : page(['fresh'], '0')),
    })
    await list.getList()
    list.listNext.value = '9'

    await list.refresh()

    expect(list.list.value.map(i => i.id)).toEqual(['fresh'])
    expect(list.listNext.value).toBe('0')
    expect(list.noMore.value).toBe(true)
  })

  it('reset 只清状态、不发请求（多列表联动的刷新序列里使用）', async () => {
    const loadPage = vi.fn(() => page(['a'], '2'))
    const list = usePagedList<Item>({ loadPage })
    await list.getList()
    loadPage.mockClear()

    list.reset()

    expect(loadPage).not.toHaveBeenCalled()
    expect(list.list.value).toEqual([])
    expect(list.listNext.value).toBe('0')
    expect(list.noMore.value).toBe(false)
    expect(list.loadFailed.value).toBe(false)
  })
})
