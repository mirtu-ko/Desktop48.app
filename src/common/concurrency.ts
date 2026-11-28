/**
 * 保序有界并发映射：最多 limit 个任务在途，结果按输入顺序返回。
 * 任一任务抛错即整体拒绝：在途任务不取消、照常跑完，排队中的不再开始。
 * 抛错必须 `return` 收尾——直接 await 抛错会让 worker 结束，排队条目再没人取。
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length })
  let cursor = 0
  let failed = false
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = cursor++
      if (index >= items.length)
        return
      try {
        results[index] = await task(items[index])
      }
      catch (error) {
        failed = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}
