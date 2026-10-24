import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 模板里的 el-* 与 plugins/element-plus.ts 的注册清单必须一一对应：
// 少注册只会在运行时冒「Failed to resolve component」并渲染成空标签，
// 而 el-* 不走 strictTemplates，typecheck 拦不住，只能靠这里守。
// 清单从源码文本里读，不 import 那个模块——它带一串 element-plus 的 .css 副作用，
// 在 node 环境下加载会直接抛 Unknown file extension。

const PLUGIN_FILE = fileURLToPath(new URL('../src/renderer/src/plugins/element-plus.ts', import.meta.url))
const SRC_ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/** el-tab-pane → ElTabPane */
function toComponentName(tag: string): string {
  return tag
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** ElTabPane → tab-pane，即 element-plus 的样式目录名 */
function toStyleDir(name: string): string {
  return name.replace(/^El/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** 从源码里取注册清单：只认 ELEMENT_COMPONENTS 对象字面量内部 */
function readRegisteredNames(source: string): Set<string> {
  const body = source.match(/export const ELEMENT_COMPONENTS = \{([\s\S]*?)\n\}/)?.[1] ?? ''
  return new Set(body.match(/El[A-Z][A-Za-z0-9]*/g) ?? [])
}

/** 扫全仓 .vue 的模板标签。注释先剔掉：注释里提到 <el-x> 不该算真用到 */
function collectTemplateTags(): Set<string> {
  const tags = new Set<string>()
  const files = readdirSync(SRC_ROOT, { recursive: true }).filter(file => String(file).endsWith('.vue'))
  for (const file of files) {
    const source = readFileSync(join(SRC_ROOT, String(file)), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    for (const match of source.matchAll(/<el-([a-z0-9-]+)/g))
      tags.add(`el-${match[1]}`)
  }
  return tags
}

const pluginSource = readFileSync(PLUGIN_FILE, 'utf8')
const registeredNames = readRegisteredNames(pluginSource)
const templateTags = collectTemplateTags()

describe('element-plus 按需注册清单', () => {
  it('清单非空（解析失败时上头两条断言会双双空过，这里兜住）', () => {
    expect(registeredNames.size).toBeGreaterThan(0)
    expect(templateTags.size).toBeGreaterThan(0)
  })

  it('模板里出现的每个 <el-x> 都已注册（漏注册 = 空标签 + 无样式）', () => {
    const missing = [...templateTags].map(toComponentName).filter(name => !registeredNames.has(name))
    expect(missing).toEqual([])
  })

  it('清单里没有模板用不到的组件（防死注册把体积长回去）', () => {
    const used = new Set([...templateTags].map(toComponentName))
    const unused = [...registeredNames].filter(name => !used.has(name))
    expect(unused).toEqual([])
  })

  it('每个注册组件都有配套的 style 引入（漏引 = 有组件无样式）', () => {
    const missing = [...registeredNames]
      .filter(name => !pluginSource.includes(`import 'element-plus/es/components/${toStyleDir(name)}/style/css'`))
    expect(missing).toEqual([])
  })
})
