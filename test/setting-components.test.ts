import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 设置页拆分后的两条结构性约束，两者都真实踩过，且 typecheck 拦不住。
 *
 * 1. composable 返回的是普通对象，里面的 ref / computed **不会**被模板自动解包
 *    （只有 setup 顶层绑定才会）。所以必须整体解构到顶层 —— 一旦退回 `account.xxx`
 *    写法，就会出现：插值渲染 [object Object]、布尔位恒真（发送验证码按钮永久禁用）、
 *    `v-model` 直接把这个 ref 属性替换成裸值、响应式当场丢失。
 * 2. 跨分组共用的样式必须由**非 scoped** 的 style 块引入。写进 `<style scoped>` 会被
 *    Vue 给整块规则加上页面 data-v，子组件里的元素匹配不上 —— 标题行会退化成块级堆叠。
 */
const SRC = new URL('../src/renderer/src/', import.meta.url)

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, SRC), 'utf8')
}

/**
 * 取 SFC 的模板段：必须按**最后一个** </template> 截断。
 * 模板里有 <template #header> 这类具名插槽，用第一个 </template> 会把扫描范围截在开头，
 * 后面的绑定全部漏检（这个坑让守卫测试一度形同虚设）。
 */
function templateOf(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  if (open < 0 || close < open)
    return ''
  return source.slice(open + '<template>'.length, close)
}

/** composable 返回的成员里，哪些是 ref / computed（模板顶层绑定会自动解包它们） */
function refMembers(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/const (\w+) = (?:ref|computed)(?:<[^>]*>)?\(/g))
    names.add(match[1])
  return names
}

/** 从组件脚本里读出 `const { ... } = props.<prop>` 的解构清单 */
function destructured(source: string, prop: string): string[] {
  const block = source.match(new RegExp(`const \\{([\\s\\S]*?)\\} = props\\.${prop}`))
  if (!block)
    return []
  return block[1]
    .split(',')
    .map(item => item.replace(/\/\/.*$/g, '').trim())
    .filter(Boolean)
}

interface Case {
  component: string
  prop: string
  composable: string
  /** 解构清单的下限：防止正则失灵导致断言空转 */
  minMembers: number
}

const CASES: Case[] = [
  { component: 'components/setting/SettingAccount.vue', prop: 'account', composable: 'composables/use-pocket-account.ts', minMembers: 20 },
  { component: 'components/setting/SettingMedia.vue', prop: 'ffmpeg', composable: 'composables/use-ffmpeg-setup.ts', minMembers: 10 },
  { component: 'components/setting/SettingMedia.vue', prop: 'appConfig', composable: 'composables/use-app-config.ts', minMembers: 3 },
  { component: 'components/setting/SettingApp.vue', prop: 'updater', composable: 'composables/use-updater.ts', minMembers: 4 },
]

describe('设置页组件：composable 结果必须解构到 setup 顶层', () => {
  for (const item of CASES) {
    it(`${item.component} 解构 props.${item.prop}，模板里不留该别名`, () => {
      const component = read(item.component)
      const names = destructured(component, item.prop)

      expect(names.length).toBeGreaterThanOrEqual(item.minMembers)
      // 留着别名就等于又回到「嵌套 ref 不自动解包」的坑
      expect(templateOf(component)).not.toMatch(new RegExp(`\\b${item.prop}\\.`))
    })

    it(`${item.component} 里 ${item.prop} 的 ref 成员在模板中不带 .value`, () => {
      const component = read(item.component)
      const refs = refMembers(read(item.composable))
      const template = templateOf(component)
      const destructuredRefs = destructured(component, item.prop).filter(name => refs.has(name))

      expect(destructuredRefs.length).toBeGreaterThan(0) // 断言非空转
      const withValue = destructuredRefs.filter(name => new RegExp(`\\b${name}\\s*\\.value`).test(template))
      expect(withValue).toEqual([])
    })
  }
})

describe('设置页共享样式：必须从非 scoped 块引入', () => {
  it('setting-shared.scss 由不带 scoped 的 style 块 @use', () => {
    const source = read('pages/Setting.vue')
    const blocks = [...source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)]
      .map(match => ({ attrs: match[1], body: match[2] }))

    const owners = blocks.filter(block => block.body.includes('setting-shared'))
    expect(owners).toHaveLength(1)
    expect(owners[0].attrs).not.toContain('scoped')
  })

  it('组间留白挂在结构关系上，而不是「第一个子元素」这类位置假设', () => {
    const scss = read('components/setting/setting-shared.scss')
    // 分组由 5 个组件各自渲染：谁先谁后、前面有没有别的节点都不该影响首组贴顶
    expect(scss).toContain('.setting-card + .setting-group-label')
    expect(scss).not.toMatch(/:first-child/)
  })

  it('图标磁贴尺寸不限定在 .setting-row 下（关于组用 <summary> 承载图标）', () => {
    const scss = read('components/setting/setting-shared.scss')
    expect(scss).not.toMatch(/\.setting-row\s+\.row-icon/)

    const about = read('components/setting/SettingAbout.vue')
    expect(templateOf(about)).toContain('class="row-icon')
  })
})
