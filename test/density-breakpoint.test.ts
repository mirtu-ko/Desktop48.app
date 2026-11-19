import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 紧凑档断点只有一个出口：全仓 renderer 里的 max-height 媒体查询必须同为 760px。
// 散落的数值不会报错、也不会被 typecheck 发现，只会在某个页面悄悄不跟随密度档。

const SRC_ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const DENSITY_BREAKPOINT = '760px'

/** 收集所有 max-height 媒体查询：文件 → 断点值列表 */
function collectBreakpoints(): Array<{ file: string, value: string }> {
  const files = readdirSync(SRC_ROOT, { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.vue') || file.endsWith('.scss'))
  const found: Array<{ file: string, value: string }> = []
  for (const file of files) {
    const source = readFileSync(join(SRC_ROOT, file), 'utf8')
    for (const match of source.matchAll(/@media\s*\(\s*max-height:\s*(\d+px)/g))
      found.push({ file, value: match[1].trim() })
  }
  return found
}

describe('紧凑档断点', () => {
  it('所有 max-height 媒体查询都是同一个值', () => {
    const breakpoints = collectBreakpoints()
    expect(breakpoints.length).toBeGreaterThan(0)
    expect(breakpoints.filter(item => item.value !== DENSITY_BREAKPOINT)).toEqual([])
  })

  it('app.scss 里定义了密度 token 的紧凑覆盖，但不碰卡片列宽', () => {
    const source = readFileSync(join(SRC_ROOT, 'assets/css/app.scss'), 'utf8')
    const block = source.slice(source.indexOf(`@media (max-height: ${DENSITY_BREAKPOINT})`))
    expect(block).toContain('--dock-reserve:')
    expect(block).toContain('--tabbar-offset-top:')
    // 卡宽只由窗口宽度决定：紧凑档改它，同一宽度换个窗口高度就会换一套列数
    expect(block).not.toContain('--card-min:')
    expect(block).not.toContain('--card-gap:')
  })
})
