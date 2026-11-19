import type { Density } from '../src/common/density'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DENSITY_BREAKPOINT, resolveDensity } from '../src/common/density'
import { FLOAT_BAR_HEIGHT, FLOAT_BAR_HEIGHT_MIN } from '../src/common/float-window'
import { computeWindowBounds, WINDOW_MAX_ASPECT } from '../src/main/window-bounds'
import { applyDensity } from '../src/renderer/src/utils/apply-density'

// 密度轴只有一处判据、一个写入口；宽度轴另立断点表，两轴不改写对方的量。

const SRC_ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const APP_SCSS = 'assets/css/app.scss'
const COMPACT_MARKER = ':root[data-density=\'compact\']'
const HEIGHT_QUERY = /@media[^{]*max-height:\s*(\d+px)/g
const WIDTH_QUERY = /@(?:media|container)\s*\(\s*max-width:\s*(\d+px)/g

/** 宽度轴断点登记表：各处语义不同，新增或改值都要显式更新这里 */
const WIDTH_BREAKPOINTS = [
  'assets/css/app.scss:740px',
  'pages/Lives.vue:680px',
  'pages/Lives.vue:760px',
  'pages/Rooms.vue:960px',
  'pages/Setting.vue:1000px',
]

/** 工作区 → 初始窗口高 → 密度档；1080p@125% 落在 768，刻意留在常规档 */
const DISPLAY_CASES: Array<{ area: { width: number, height: number }, density: Density }> = [
  { area: { width: 1920, height: 1040 }, density: 'regular' },
  { area: { width: 1536, height: 832 }, density: 'regular' },
  { area: { width: 1366, height: 728 }, density: 'compact' },
  { area: { width: 1280, height: 705 }, density: 'compact' },
  { area: { width: 1440, height: 805 }, density: 'compact' },
  { area: { width: 853, height: 533 }, density: 'compact' },
  { area: { width: 2560, height: 1346 }, density: 'regular' },
]

interface Card {
  name: string
  minVar: string
  gapVar: string
  floor: number
}

const LIVE: Card = { name: '直播', minVar: '--card-min', gapVar: '--card-gap', floor: 200 }
const SHOW: Card = { name: '公演', minVar: '--show-min', gapVar: '--show-gap', floor: 230 }
const ALBUM: Card = { name: '专辑', minVar: '--album-min', gapVar: '--card-gap', floor: 215 }

/** 改动前的固定常量，用来证明 1400 及以上逐像素不变 */
interface LegacySpec {
  min: number
  floor: number
  gap: number
}

const LEGACY: Record<'live' | 'show' | 'album', LegacySpec> = {
  live: { min: 225, floor: 0, gap: 16 },
  show: { min: 300, floor: 260, gap: 20 },
  album: { min: 265, floor: 240, gap: 16 },
}

/** 卡片尺寸变量清单：新增变量要同步进求值守卫 */
const CARD_SIZE_VARS = [
  '--space-page-x',
  '--card-min',
  '--show-min',
  '--album-min',
  '--card-gap',
  '--show-gap',
  '--album-cover',
  '--album-vinyl',
  '--album-label',
  '--album-inner-gap',
  '--album-inset',
]

const WIDTHS = [720, 900, 1000, 1090, 1216, 1260, 1306, 1400, 1460, 1700, 1920, 2560]
const BASE_WIDTHS = [1400, 1460, 1664, 1700, 1920, 2496, 2560]
const SMALL_WIDTHS = [1090, 1129, 1260, 1306]

interface Ctx {
  win: number
  content: number
  vars: Map<string, string>
}

function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.vue') || file.endsWith('.scss'))
    .sort()
}

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

/** 取标记所在选择器块的完整文本；按花括号计数，SCSS 嵌套同样适用 */
function cssBlock(text: string, start: number): string {
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{')
      depth++
    else if (text[i] === '}' && --depth === 0)
      return text.slice(start, i + 1)
  }
  return text.slice(start)
}

function compactBlock(rel = APP_SCSS): string {
  const text = read(rel)
  const start = text.indexOf(COMPACT_MARKER)
  return start < 0 ? '' : cssBlock(text, start)
}

function compactOverrides(): string[] {
  return [...compactBlock().matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])
}

/** 收集自定义属性声明；compact 时用紧凑档的同名声明覆盖 */
function declarations(compact = false): Map<string, string> {
  const vars = new Map<string, string>()
  const collect = (text: string, overwrite: boolean): void => {
    for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) {
      if (overwrite || !vars.has(match[1])) {
        const start = (match.index ?? 0) + match[0].length
        const end = text.indexOf(';', start)
        if (end >= 0) {
          vars.set(match[1], text.slice(start, end)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\s+/g, ' ')
            .trim())
        }
      }
    }
  }
  collect(read(APP_SCSS), false)
  if (compact)
    collect(compactBlock(), true)
  return vars
}

/** 按顶层逗号拆分函数参数，嵌套 min/max/clamp/calc 不切断 */
function splitArgs(source: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') {
      depth++
    }
    else if (source[i] === ')') {
      depth--
    }
    else if (source[i] === ',' && depth === 0) {
      parts.push(source.slice(start, i))
      start = i + 1
    }
  }
  parts.push(source.slice(start))
  return parts
}

/** 求值 app.scss 里用到的长度表达式，值直接来自源码而非测试里的副本 */
function evalCss(expr: string, ctx: Ctx): number {
  const source = expr.trim()
  const fn = /^(min|max|clamp|calc)\(([\s\S]*)\)$/.exec(source)
  if (fn) {
    // app.scss 只用到两种 calc；遇到新写法直接报错，避免静默算错
    if (fn[1] === 'calc') {
      const even = /^\(\s*100%\s*-\s*3\s*\*\s*var\((--[\w-]+)\)\s*\)\s*\/\s*4\s*$/.exec(fn[2])
      if (even) {
        return (ctx.content - 3 * evalCss(`var(${even[1]})`, ctx)) / 4
      }
      const negHalf = /^var\((--[\w-]+)\)\s*\/\s*-2\s*$/.exec(fn[2])
      if (negHalf) {
        return evalCss(`var(${negHalf[1]})`, ctx) / -2
      }
      throw new Error(`不支持的 calc 表达式: ${fn[2]}`)
    }
    const args = splitArgs(fn[2]).map(arg => evalCss(arg, ctx))
    if (fn[1] === 'min')
      return Math.min(...args)
    if (fn[1] === 'max')
      return Math.max(...args)
    return Math.min(Math.max(args[0], args[1]), args[2])
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(source)
  if (ref) {
    const value = ctx.vars.get(ref[1])
    if (!value)
      throw new Error(`缺少自定义属性 ${ref[1]}`)
    return evalCss(value, ctx)
  }
  const num = /^(-?[\d.]+)(px|vw|%)?$/.exec(source)
  if (num) {
    const n = Number(num[1])
    if (num[2] === 'vw')
      return n * ctx.win / 100
    if (num[2] === '%')
      return n * ctx.content / 100
    return n
  }
  throw new Error(`无法求值 CSS 表达式: ${expr}`)
}

/** 按 auto-fill 规则算列数与单卡宽；100% 解析为网格容器内容宽 */
function grid(winWidth: number, compact: boolean, card: Card): { columns: number, card: number, gap: number } {
  const vars = declarations(compact)
  const ctx: Ctx = { win: winWidth, content: 0, vars }
  ctx.content = winWidth - 2 * evalCss('var(--space-page-x)', ctx)
  const gap = evalCss(`var(${card.gapVar})`, ctx)
  const min = evalCss(`var(${card.minVar})`, ctx)
  const columns = Math.floor((ctx.content + gap) / (min + gap))
  return { columns, card: (ctx.content - (columns - 1) * gap) / columns, gap }
}

/** 改动前的固定值公式 */
function legacyGrid(winWidth: number, spec: LegacySpec): { columns: number, card: number } {
  const content = winWidth - 2 * Math.min(32, Math.max(12, winWidth * 0.01))
  const even = (content - 3 * spec.gap) / 4
  const min = Math.min(spec.min, Math.max(spec.floor, even))
  const columns = Math.floor((content + spec.gap) / (min + spec.gap))
  return { columns, card: (content - (columns - 1) * spec.gap) / columns }
}

/** 专辑卡内部尺寸与由它们决定的卡片高度 */
function albumParts(winWidth: number): { cover: number, vinyl: number, label: number, innerGap: number, inset: number, height: number } {
  const ctx: Ctx = { win: winWidth, content: 0, vars: declarations() }
  const value = (name: string): number => evalCss(`var(${name})`, ctx)
  const cover = value('--album-cover')
  return {
    cover,
    vinyl: value('--album-vinyl'),
    label: value('--album-label'),
    innerGap: value('--album-inner-gap'),
    inset: value('--album-inset'),
    height: cover + 2 * value('--album-inset'),
  }
}

function collectWidthBreakpoints(): string[] {
  const found: string[] = []
  for (const file of sourceFiles()) {
    for (const match of read(file).matchAll(WIDTH_QUERY))
      found.push(`${file}:${match[1]}`)
  }
  return found.sort()
}

describe('密度信号', () => {
  it('断点只在一处定义，样式侧不再有 max-height 媒体查询', () => {
    expect(DENSITY_BREAKPOINT).toBe(760)
    const leftover = sourceFiles().flatMap(file =>
      [...read(file).matchAll(HEIGHT_QUERY)].map(() => file),
    )
    expect(leftover).toEqual([])
  })

  it('媒体查询扫描能覆盖 and 连接的复合条件', () => {
    const values = [...'@media (max-width: 900px) and (max-height: 760px) {'.matchAll(HEIGHT_QUERY)]
      .map(match => match[1])
    expect(values).toEqual(['760px'])
  })

  it('紧凑样式只挂在 html[data-density] 上，且只剩 app.scss 一处', () => {
    const files = sourceFiles().filter(file => read(file).includes(COMPACT_MARKER))
    expect(files).toEqual(['assets/css/app.scss'])
  })

  it('入口在首次渲染前安装密度信号', () => {
    const main = read('main.ts')
    expect(main).toContain('installDensitySignal()')
    expect(main.indexOf('installDensitySignal()')).toBeLessThan(main.indexOf('app.mount'))
  })

  it('applyDensity 是唯一写入口，同值不重复写', () => {
    let writes = 0
    let value: string | undefined
    const root = {
      dataset: {
        get density(): string | undefined { return value },
        set density(next: string | undefined) {
          writes++
          value = next
        },
      },
    }
    applyDensity(root, 700)
    applyDensity(root, 720)
    expect(writes).toBe(1)
    expect(value).toBe('compact')
    applyDensity(root, 900)
    expect(writes).toBe(2)
    expect(value).toBe('regular')
  })

  it('边界值两侧分档正确', () => {
    expect(resolveDensity(DENSITY_BREAKPOINT)).toBe('compact')
    expect(resolveDensity(DENSITY_BREAKPOINT + 1)).toBe('regular')
  })

  it('工作区经窗口高换算出的密度档与登记一致', () => {
    for (const { area, density } of DISPLAY_CASES) {
      const height = computeWindowBounds(area).height
      expect({ area, height, density: resolveDensity(height) })
        .toEqual({ area, height, density })
    }
  })

  it('小屏窗口收到 1.7 长宽比，宽屏放大不受约束', () => {
    expect(computeWindowBounds({ width: 1280, height: 705 })).toMatchObject({ width: 1090, height: 641 })
    expect(computeWindowBounds({ width: 1440, height: 805 })).toMatchObject({ width: 1260, height: 741 })
    expect(computeWindowBounds({ width: 1920, height: 1040 }).width / 900).toBeLessThan(WINDOW_MAX_ASPECT)
    expect(computeWindowBounds({ width: 2560, height: 1346 }).width / 900).toBeGreaterThan(WINDOW_MAX_ASPECT)
  })

  it('宽度轴断点与登记表一致', () => {
    expect(collectWidthBreakpoints()).toEqual([...WIDTH_BREAKPOINTS].sort())
  })

  it('宽度断点扫描能覆盖复合条件', () => {
    const values = [...'@media (max-width: 900px) and (max-height: 700px) {'.matchAll(WIDTH_QUERY)]
      .map(match => match[1])
    expect(values).toEqual(['900px'])
  })
})

describe('表达式求值', () => {
  it('能求值嵌套 min/max/clamp/calc 与负号', () => {
    const ctx: Ctx = { win: 1400, content: 1372, vars: new Map([['--g', 'clamp(12px, 1.15vw, 16px)']]) }
    expect(evalCss('min(225px, calc((100% - 3 * var(--g)) / 4))', ctx)).toBe(225)
    expect(evalCss('clamp(200px, 16.1vw, 225px)', ctx)).toBe(225)
    expect(evalCss('calc(var(--g) / -2)', ctx)).toBe(-8)
  })

  it('app.scss 里所有卡片尺寸变量都可求值', () => {
    const ctx: Ctx = { win: 1400, content: 1372, vars: declarations() }
    for (const name of CARD_SIZE_VARS) {
      expect(evalCss(`var(${name})`, ctx)).toBeGreaterThan(0)
    }
  })
})

describe('紧凑档布局不变量', () => {
  it('紧凑档不再覆盖任何自定义属性：留白已交给曲线', () => {
    expect(compactOverrides()).toEqual([])
  })

  /* 高度轴改成连续后，两端的取值就是唯一还钉得住的东西：
   * 641 高必须逐像素等于原紧凑档，900 高必须逐像素等于基准档。
   * 声明里除 fluid() 之外不允许出现别的数值，否则这条轴又断了。 */
  it('高度轴曲线两端仍落在原档位值上', () => {
    const vars = declarations()
    const step = /^calc\(\(100vh - (\d+)px\) \/ (\d+)\)$/.exec(vars.get('--vh-step') ?? '')
    expect(step).not.toBeNull()
    const [, floor, span] = step!.map(Number)
    expect(floor).toBe(641)
    expect(floor + span).toBe(900)

    const call = /fluid\((-?[\d.]+)px, (-?[\d.]+)px\)/g
    const pairs: Record<string, Array<[number, number]>> = {
      '--tabbar-offset-top': [[50, 64]],
      '--float-top': [[8, 12]],
      '--dock-reserve': [[80, 96]],
      '--radius-card': [[16, 20]],
      '--dock-item-w': [[46, 56]],
      '--dock-icon': [[32, 40]],
      '--dock-gap': [[5, 8]],
      '--card-body-pad': [[7, 10], [9, 12], [9, 12]],
    }
    for (const [name, expected] of Object.entries(pairs)) {
      const raw = vars.get(name) ?? ''
      const found = [...raw.matchAll(call)].map(match => [Number(match[1]), Number(match[2])] as [number, number])
      expect({ name, found }).toEqual({ name, found: expected })
      // 整条声明只由这些 fluid 组成：多写一个硬编码值就说明这条轴又断了
      expect({ name, rest: raw.replace(call, '').replace(/[#{}]/g, '').trim() }).toEqual({ name, rest: '' })
    }
  })

  it('fluid() 只有一份实现，两端不能相等（相等的曲线是死的）', () => {
    const owners = sourceFiles().filter(file => read(file).includes('@function fluid'))
    expect(owners).toEqual(['assets/css/_fluid.scss'])
    for (const file of sourceFiles()) {
      for (const match of read(file).matchAll(/fluid\((-?[\d.]+)px, (-?[\d.]+)px\)/g))
        expect({ file, ok: Number(match[1]) !== Number(match[2]) }).toEqual({ file, ok: true })
    }
  })

  it('这四个垂直量已连续，紧凑档不再按档覆盖', () => {
    for (const name of ['--card-body-pad', '--dock-item-w', '--dock-icon', '--dock-gap'])
      expect(compactOverrides()).not.toContain(name)
  })

  it('水平内距只有一个定义，紧凑档不覆盖', () => {
    expect([...read(APP_SCSS).matchAll(/--space-page-x\s*:/g)]).toHaveLength(1)
    expect(compactOverrides()).not.toContain('--space-page-x')
  })

  it('同一宽度下切换高度档不改变列数与单卡宽', () => {
    for (const width of WIDTHS) {
      for (const card of [LIVE, SHOW, ALBUM]) {
        const regular = grid(width, false, card)
        const compact = grid(width, true, card)
        expect({ width, name: card.name, ...compact }).toEqual({ width, name: card.name, ...regular })
      }
    }
  })

  it('既有列宽基准不回退', () => {
    expect(grid(1216, false, LIVE).columns).toBe(5)
    expect(grid(1400, false, LIVE).columns).toBe(5)
    expect(grid(1400, false, SHOW).columns).toBe(4)
    expect(grid(1400, false, ALBUM).columns).toBe(4)
    expect(grid(1920, false, LIVE).columns).toBe(7)
    expect(grid(1920, false, SHOW).columns).toBe(5)
    expect(grid(1920, false, ALBUM).columns).toBe(6)
  })
})

describe('独立播放窗浮层尺寸轴', () => {
  /* 播放窗（独立 BrowserWindow）的浮层按本窗窗口宽插值，与主窗口的高度轴互不相干。
   * 两端不许相等：写成固定值就等于把这条轴拔了，而浮层只是看起来「没那么大」不报错，
   * 靠肉眼很难发现，故在此钉住。 */
  const FP_TOKENS = [
    '--fp-btn',
    '--fp-capsule-btn',
    '--fp-capsule-pad',
    '--fp-icon',
    '--fp-font',
    '--fp-font-sm',
    '--fp-gap',
    /* 控制条悬空量：弹幕避让量按它算，掉出曲线会让气泡与胶囊对不上 */
    '--fp-control-gap',
    /* 浮层贴边量：互动榜 / 右上角动作钮 / 弹幕层共用 */
    '--fp-inset',
  ]

  it('步长锚在 320 → 900，各 token 都挂在这条曲线上', () => {
    const vars = declarations()
    const step = /^calc\(\(100vw - (\d+)px\) \/ (\d+)\)$/.exec(vars.get('--fp-step') ?? '')
    expect(step).not.toBeNull()
    const [, floor, span] = step!.map(Number)
    expect(floor).toBe(320)
    expect(floor + span).toBe(900)

    const call = /^clamp\(([\d.]+)px, calc\(([\d.]+)px \+ ([\d.]+) \* var\(--fp-step\)\), ([\d.]+)px\)$/
    for (const name of FP_TOKENS) {
      const raw = vars.get(name) ?? ''
      const parsed = call.exec(raw)
      expect(parsed, `${name} 没挂在 --fp-step 曲线上：${raw}`).not.toBeNull()
      const [low, base, , high] = parsed!.slice(1, 5).map(Number)
      // 起点 = 下限，且两端不等（相等的 clamp 是死曲线，浮层只会「没那么大」而不会报错）
      expect({ name, startsAtMin: base === low, alive: low !== high })
        .toEqual({ name, startsAtMin: true, alive: true })
    }
  })

  /* 栏高是唯一跨进程的尺寸：CSS 决定渲染层实际条高，主进程 floatBarHeight() 决定
   * 窗口总高，两边漂了不会报错，只表现为视频区比预期高/矮几像素。 */
  it('浮窗标题栏高度与主进程 floatBarHeight 同一条曲线', () => {
    const vue = read('components/floats/FloatWindowApp.vue')
    expect(vue).toMatch(/height:\s*var\(--bar-h\)/)

    const raw = /--bar-h:([^;]+);/.exec(vue)?.[1].replace(/\s+/g, ' ').trim() ?? ''
    const parsed = /^clamp\((\d+)px, calc\((\d+)px \+ ([\d.]+) \* var\(--fp-step\)\), (\d+)px\)$/.exec(raw)
    expect(parsed, `--bar-h 不是 --fp-step 曲线：${raw}`).not.toBeNull()

    const [low, base, , high] = parsed!.slice(1, 5).map(Number)
    expect({ low, base, high })
      .toEqual({ low: FLOAT_BAR_HEIGHT_MIN, base: FLOAT_BAR_HEIGHT_MIN, high: FLOAT_BAR_HEIGHT })
  })
})

describe('卡片宽度轴', () => {
  it('1400 及以上与改动前的固定常量逐像素一致', () => {
    const specs = [[LIVE, LEGACY.live], [SHOW, LEGACY.show], [ALBUM, LEGACY.album]] as const
    for (const width of BASE_WIDTHS) {
      for (const [card, spec] of specs) {
        const now = grid(width, false, card)
        const old = legacyGrid(width, spec)
        expect({ width, name: card.name, columns: now.columns, card: now.card })
          .toEqual({ width, name: card.name, ...old })
      }
    }
  })

  it('≥1400 时网格间距与专辑内部尺寸回到基准值', () => {
    for (const width of BASE_WIDTHS) {
      expect(grid(width, false, LIVE).gap).toBe(16)
      expect(grid(width, false, SHOW).gap).toBe(20)
      expect(albumParts(width)).toEqual({ cover: 96, vinyl: 82, label: 34, innerGap: 32, inset: 12, height: 120 })
    }
  })

  it('小屏卡片与网格间距都比基准小', () => {
    for (const width of SMALL_WIDTHS) {
      for (const card of [LIVE, SHOW, ALBUM])
        expect(grid(width, false, card).card).toBeLessThan(grid(1400, false, card).card)
      expect(grid(width, false, LIVE).gap).toBeLessThan(16)
      expect(grid(width, false, SHOW).gap).toBeLessThan(20)
    }
  })

  it('窗口按 1.7 收窄后列数不比原窗口少', () => {
    for (const [before, after] of [[1216, 1090], [1302, 1129], [1376, 1260], [1400, 1306]]) {
      for (const card of [LIVE, SHOW, ALBUM])
        expect(grid(after, false, card).columns).toBeGreaterThanOrEqual(grid(before, false, card).columns)
    }
  })

  it('专辑卡随卡宽一起收窄，卡高从 120 降下来', () => {
    const base = albumParts(1400)
    for (const width of SMALL_WIDTHS) {
      const parts = albumParts(width)
      expect(parts.height).toBeLessThan(base.height)
      expect(parts.cover).toBeLessThan(base.cover)
      expect(parts.vinyl).toBeLessThan(base.vinyl)
      expect(parts.innerGap).toBeLessThan(base.innerGap)
      expect(parts.inset).toBeLessThan(base.inset)
    }
  })

  it('窄窗下公演 / 专辑单卡不低于收窄地板', () => {
    for (const width of [720, 900, 1000]) {
      for (const card of [SHOW, ALBUM])
        expect(grid(width, false, card).card).toBeGreaterThanOrEqual(card.floor)
    }
  })
})
