import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Constants from '../src/renderer/src/utils/constants'

/**
 * 常量表的契约测试：这些表被多个页面共用，改错一个键就会静默失效
 * （菜单高亮不上、主题色丢失、状态标签空缺），运行时不会抛错。
 */
describe('constants.Menu 与路由表', () => {
  it('值都是带前导斜杠的路径', () => {
    for (const path of Object.values(Constants.Menu))
      expect(path).toMatch(/^\/[a-z]+$/)
  })

  it('与 routes.ts 的路径集合一一对应（新增页面漏配菜单在这里报错）', () => {
    // 只做文本比对，不 import routes.ts：那会把 6 个 .vue 组件连同播放器依赖
    // 一起拉进 Node 测试环境，收益不抵成本
    const source = readFileSync(new URL('../src/renderer/src/routes.ts', import.meta.url), 'utf-8')
    const routePaths = [...source.matchAll(/path: '([^']+)'/g)]
      .map(match => match[1])
      .filter(path => path !== '/') // 根路径是 redirect，不对应菜单项

    expect(new Set(routePaths)).toEqual(new Set(Object.values(Constants.Menu)))
  })
})

describe('app.scss 语义主题色', () => {
  const source = readFileSync(new URL('../src/renderer/src/assets/css/app.scss', import.meta.url), 'utf-8')
  const matches = [...source.matchAll(/--color-([a-z]+):\s*(#[0-9a-f]{6})\b/gi)]
  const themeColors = new Map(matches.map(match => [match[1].toLowerCase(), match[2]]))

  it('覆盖每个 Menu 页面和 FOLLOW 语义色，且键不重复', () => {
    const expectedKeys = [...Object.keys(Constants.Menu).map(key => key.toLowerCase()), 'follow'].sort()
    expect(themeColors.size).toBe(matches.length)
    expect([...themeColors.keys()].sort()).toEqual(expectedKeys)
  })

  it('值都是六位十六进制色（Dock / 任务分组 / 设置行共用同一份）', () => {
    for (const color of themeColors.values())
      expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('constants.MemberStatus / MemberStatusMeta', () => {
  it('元信息覆盖全部状态且无冗余键', () => {
    expect(Object.keys(Constants.MemberStatusMeta).map(Number).sort())
      .toEqual(Object.values(Constants.MemberStatus).sort())
  })

  it('每个状态都有可读标签与合法的 tag 类型', () => {
    for (const status of Object.values(Constants.MemberStatus)) {
      const meta = Constants.MemberStatusMeta[status]
      expect(meta.label).toBeTruthy()
      expect(['success', 'warning', 'info']).toContain(meta.tag)
    }
  })
})

describe('constants.GroupTabs', () => {
  it('key 唯一，首项为「全部」且不带主题色 / 分团 logo', () => {
    const keys = Constants.GroupTabs.map(tab => tab.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(Constants.GroupTabs[0]).toEqual({ label: '全部', key: '0', color: '', logoPng: '' })
  })

  it('每个分团的 label / key / color / logoPng 都不为空（除「全部」外）', () => {
    for (const tab of Constants.GroupTabs.slice(1)) {
      expect(tab.label).toBeTruthy()
      expect(tab.key).not.toBe('0')
      expect(tab.color).toMatch(/^#[0-9a-f]{6}$/i)
      // 分团官方 logo 一律是 snh48.com 的 about-logo-*.png（成员页队伍徽章缺失时拿它做标题图标）
      expect(tab.logoPng).toMatch(/^https:\/\/www\.snh48\.com\/images\/index\/about-logo-[a-z]+\.png$/)
    }
  })

  it('提供分团 logo 兜底地址：无官方 logo 的团体（IDFT / 燃烧吧团魂 等）与暂休退团分区共用它', () => {
    expect(Constants.GroupLogoFallback).toMatch(/^https:\/\/www\.snh48\.com\/images\/index\/about-logo-[a-z]+\.png$/)
    // 兜底图就是 SNH48 那张，避免两处各写一份地址
    expect(Constants.GroupLogoFallback).toBe(Constants.GroupTabs[1].logoPng)
  })
})
