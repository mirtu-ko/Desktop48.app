/**
 * 保序有界并发映射：最多 limit 个任务在途，结果按输入顺序返回；
 * 任一任务抛错即整体拒绝（其余在途任务自然跑完，不取消）。
 * 主进程（pocket-unread 的解析/探测池）与渲染层共用这一份口径。
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
