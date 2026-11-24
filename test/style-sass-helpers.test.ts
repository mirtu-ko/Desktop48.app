import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 样式里用了项目自定义 Sass 函数（fluid / fp）就必须 @use 对应 partial。
 *
 * 漏了 @use 时 Sass **不会报错**：不认识的函数按原生 CSS 函数原样输出，
 * 浏览器把 `width: fluid(36px, 42px)` 当非法声明整条丢掉 —— 构建照样成功，
 * 只在界面上表现为「尺寸/间距全没生效」。设置页拆分时就因此把左列头像撑成了整屏宽。
 */
const SRC_ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/** 项目自定义的 Sass 函数名（见 assets/css/_fluid.scss） */
const PROJECT_FUNCTIONS = ['fluid', 'fp']

/** 去掉注释：文档里会写到 `fluid(…)` 这种示例，不算真实调用 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

interface StyleBlock {
  file: string
  body: string
}

function collectVueStyleBlocks(): StyleBlock[] {
  const blocks: StyleBlock[] = []
  for (const file of readdirSync(SRC_ROOT, { recursive: true })) {
    const name = String(file)
    if (!name.endsWith('.vue'))
      continue
    const source = readFileSync(join(SRC_ROOT, name), 'utf8')
    for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
      blocks.push({ file: name.replaceAll('\\', '/'), body: stripComments(match[1]) })
  }
  return blocks
}

describe('自定义 Sass 函数的 @use 引入', () => {
  it('用到 fluid / fp 的样式块都 import 了 assets/css/fluid', () => {
    const missing: string[] = []

    for (const block of collectVueStyleBlocks()) {
      const used = PROJECT_FUNCTIONS.filter(fn => new RegExp(`\\b${fn}\\(`).test(block.body))
      if (used.length === 0)
        continue
      if (!/assets\/css\/fluid/.test(block.body))
        missing.push(`${block.file}：用了 ${used.join('/')} 但没有 @use assets/css/fluid`)
    }

    expect(missing).toEqual([])
  })

  it('扫描本身有效：确实扫到了用 fluid 的样式块', () => {
    const using = collectVueStyleBlocks().filter(block => /\bfluid\(/.test(block.body))
    expect(using.length).toBeGreaterThan(0)
  })
})
