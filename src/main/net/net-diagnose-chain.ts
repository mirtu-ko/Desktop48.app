/**
 * 网络诊断的主备链结论合成（纯函数，不依赖 electron，便于单测）。
 *
 * 成员名单有两套同构来源：静态快照为主、jsonp 接口为备。诊断按主→备的顺序探测，
 * 任意一条拿到 < 400 即视为该行正常——这与业务 `apis.ts` 的取数顺序一致；
 * 只有全部来源都失败才判该行不可用，并把各源状态折进说明，避免"备源顶上了却报红"。
 */

/** 单条来源的探测结果（`net-diagnose.ts` 的 NetDiagnoseItem 是它的超集） */
export interface SourceOutcome {
  label: string
  url: string
  status: number | null
  ms: number
  error?: string
  detail?: string
}

/** 状态码 / 错误文案的可读摘要，用于拼接多源说明 */
function describe(source: SourceOutcome): string {
  return source.status === null ? (source.error || '无响应') : `HTTP ${source.status}`
}

/**
 * 把一条链的探测结果折叠成一行诊断。
 * @param label 链的展示名（各行结果是具体来源名，这里统一成链名）
 * @param results 按主→备顺序的探测结果，至少一条；短路探测时只含已尝试的来源
 */
export function resolveSources<T extends SourceOutcome>(label: string, results: T[]): T {
  const hit = results.find(result => result.status !== null && result.status < 400)
  if (hit) {
    // 主源可用时不追加任何说明（单源目标也走这里，保持原样返回）
    if (results.length === 1)
      return hit
    return { ...hit, label, detail: `主源不可用（${describe(results[0])}），已由备源接通` }
  }

  const summary = results
    .map((result, index) => `${index === 0 ? '主源' : `备源${index}`} ${describe(result)}`)
    .join('；')
  // 结论字段沿用主源：状态码 / 错误描述都指向"最该修的那条"
  if (results.length === 1)
    return results[0]
  return { ...results[0], label, detail: `主备全部不可用：${summary}` }
}
