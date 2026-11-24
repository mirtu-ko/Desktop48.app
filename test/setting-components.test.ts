import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 设置页拆分后的两条结构性约束，两者都真实踩过，且 typecheck 拦不住：
 *
 * 1. 组件从 composable 拿到的是一个普通对象，里面的 ref / computed **不会**被模板自动解包
 *    （只有 setup 顶层绑定才会）。写成 `account.xxx` 会把整只 ref 对象当值用：
 *    插值渲染出 [object Object]，布尔位恒真（发送验证码按钮永久禁用），
 *    `v-model` 更是直接把这个 ref 属性替换成裸值、响应式当场丢失。
 * 2. 跨分组共用的样式必须由**非 scoped** 的 style 块引入。写进 `<style scoped>` 会被
 *    Vue 给整块规则加上页面 data-v，子组件里的元素匹配不上 —— 标题行会退化成块级堆叠。
 */
const SETTING_VUE = new URL('../src/renderer/src/pages/Setting.vue', import.meta.url)
const ACCOUNT_COMPOSABLE = new URL('../src/renderer/src/composables/use-pocket-account.ts', import.meta.url)
const ACCOUNT_COMPONENT = new URL('../src/renderer/src/components/setting/SettingAccount.vue', import.meta.url)
const SHARED_SCSS = new URL('../src/renderer/src/components/setting/setting-shared.scss', import.meta.url)

function read(url: URL): string {
  return readFileSync(url, 'utf8')
}

/** composable 返回的成员里，哪些是 ref / computed（模板里必须 .value） */
function refMembers(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/const (\w+) = (?:ref|computed)(?:<[^>]*>)?\(/g))
    names.add(match[1])
  return names
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

describe('设置页组件：composable 返回的 ref 必须显式 .value', () => {
  it('settingAccount 模板里没有裸用的 ref / computed', () => {
    const refs = refMembers(read(ACCOUNT_COMPOSABLE))
    const template = templateOf(read(ACCOUNT_COMPONENT))
    expect(refs.size).toBeGreaterThan(10) // 防止解析失灵导致断言空转

    const bare = [...template.matchAll(/account\.(\w+)(?!\.value)/g)]
      .map(match => match[1])
      .filter(name => refs.has(name))

    expect([...new Set(bare)]).toEqual([])
  })

  it('没有对非 ref 成员误加 .value', () => {
    const refs = refMembers(read(ACCOUNT_COMPOSABLE))
    const template = templateOf(read(ACCOUNT_COMPONENT))

    const wrong = [...template.matchAll(/account\.(\w+)\.value/g)]
      .map(match => match[1])
      .filter(name => !refs.has(name))

    expect([...new Set(wrong)]).toEqual([])
  })
})

describe('设置页共享样式：必须从非 scoped 块引入', () => {
  it('setting-shared.scss 由不带 scoped 的 style 块 @use', () => {
    const source = read(SETTING_VUE)
    const blocks = [...source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)]
      .map(match => ({ attrs: match[1], body: match[2] }))

    const owners = blocks.filter(block => block.body.includes('setting-shared'))
    expect(owners).toHaveLength(1)
    expect(owners[0].attrs).not.toContain('scoped')
  })

  it('图标磁贴尺寸不限定在 .setting-row 下（关于组用 <summary> 承载图标）', () => {
    const scss = read(SHARED_SCSS)
    expect(scss).not.toMatch(/\.setting-row\s+\.row-icon/)

    const account = read(ACCOUNT_COMPONENT)
    expect(templateOf(account)).toContain('class="row-icon')
  })
})
