import type { FloatFitState } from '../src/common/float-window'
import { describe, expect, it } from 'vitest'
import { computeInitialWindowSize, decideAutoFit, fitAspectInBox, FLOAT_BAR_HEIGHT, FLOAT_BAR_HEIGHT_MIN, FLOAT_CASCADE_STEP, FLOAT_INITIAL_MIN_WIDTH_LANDSCAPE, FLOAT_MIN_WIDTH, floatBarHeight, initialFloatTopmost, isFloatTopmostPinned, nextFloatTopmost, resolveFloatTopmost, resolveFloatWindowPosition } from '../src/common/float-window'

/** 基准工作区：1080p @100%，原点在屏幕左上（workArea 是 DIP，缩放已折算，故 4K@200% 等价） */
const HD = { x: 0, y: 0, width: 1920, height: 1080 }

describe('fitAspectInBox', () => {
  it('宽屏比例受宽度约束时贴满宽度', () => {
    // 16:9 视频放进 800x450：800/1.7778 = 450，恰好铺满
    expect(fitAspectInBox(16 / 9, 800, 450)).toEqual({ w: 800, h: 450 })
  })

  it('竖屏比例受高度约束时贴满高度', () => {
    // 0.5（竖向）放进 800x450：w=800 → h=1600 超出 → h=450, w=225
    expect(fitAspectInBox(0.5, 800, 450)).toEqual({ w: 225, h: 450 })
  })

  it('结果四舍五入到整数像素', () => {
    // 100/1.7778 = 56.25 → 56
    expect(fitAspectInBox(16 / 9, 100, 100)).toEqual({ w: 100, h: 56 })
  })
})

describe('computeInitialWindowSize', () => {
  it('横屏视频：受宽度比例约束，占屏宽 45%', () => {
    // maxW = 1920*0.45 = 864；16:9 → 864x486；+36 标题栏
    expect(computeInitialWindowSize(16 / 9, HD)).toEqual({ w: 864, h: 486 + FLOAT_BAR_HEIGHT })
  })

  it('竖屏视频：受高度比例约束，回缩宽度以贴合 70% 高度上限', () => {
    // maxW = 864，但 9:16 下高度会到 1536 > 1080*0.7-31 = 725 → 回缩到 408x725
    expect(computeInitialWindowSize(9 / 16, HD)).toEqual({ w: 408, h: 725 + floatBarHeight(408) })
  })

  it('横屏视频不会被竖屏兜底比例压成窄窗', () => {
    // 回归：兜底 9:16 的宽度是 405，真实 16:9 若只保宽度就会得到 405x264 的小窗
    const portrait = computeInitialWindowSize(9 / 16, HD)
    const landscape = computeInitialWindowSize(16 / 9, HD)
    expect(portrait.w).toBe(408)
    expect(landscape.w).toBe(864)
    expect(landscape.w).toBeGreaterThan(portrait.w * 2)
  })

  it('紧凑屏不再直接套 1920 比例：1280 竖屏按 80% 高度，横屏落到兜底下限', () => {
    const compact = { x: 0, y: 0, width: 1280, height: 800 }
    // 标题栏只有 30：视频区从 604 涨到 610，宽度按 9:16 回到 343
    expect(computeInitialWindowSize(9 / 16, compact)).toEqual({ w: 343, h: 610 + floatBarHeight(343) })
    // 53% 算得 678，横屏仍由 FLOAT_INITIAL_MIN_WIDTH_LANDSCAPE 抬到 680
    expect(computeInitialWindowSize(16 / 9, compact)).toEqual({ w: FLOAT_INITIAL_MIN_WIDTH_LANDSCAPE, h: 383 + floatBarHeight(680) })
  })

  it('1440 在 1280 / 1920 之间连续放大，不会反向缩小', () => {
    const compact = { x: 0, y: 0, width: 1280, height: 800 }
    const mid = { x: 0, y: 0, width: 1440, height: 900 }
    const wider = { x: 0, y: 0, width: 1600, height: 900 }
    const portrait = computeInitialWindowSize(9 / 16, mid)
    const landscape = computeInitialWindowSize(16 / 9, mid)
    const portraitCompact = computeInitialWindowSize(9 / 16, compact)
    const landscapeCompact = computeInitialWindowSize(16 / 9, compact)
    const portraitRegular = computeInitialWindowSize(9 / 16, HD)
    const landscapeRegular = computeInitialWindowSize(16 / 9, HD)

    expect(portrait).toEqual({ w: 370, h: 657 + floatBarHeight(370) })
    expect(landscape).toEqual({ w: 734, h: 413 + floatBarHeight(734) })
    // 竖屏只看高度，同高更宽不会反而缩小；横屏只看宽度，只宽不高的屏幕也不会缩小
    expect(computeInitialWindowSize(9 / 16, wider)).toEqual(portrait)
    expect(computeInitialWindowSize(16 / 9, wider).w).toBeGreaterThan(landscape.w)
    // 两种方向都必须单调增长，避免再次出现「中间档比小屏还小」
    expect(portrait.w).toBeGreaterThan(portraitCompact.w)
    expect(portrait.h).toBeGreaterThan(portraitCompact.h)
    expect(landscape.w).toBeGreaterThan(landscapeCompact.w)
    expect(landscape.h).toBeGreaterThan(landscapeCompact.h)
    expect(portraitRegular.w).toBeGreaterThan(portrait.w)
    expect(portraitRegular.h).toBeGreaterThan(portrait.h)
    expect(landscapeRegular.w).toBeGreaterThan(landscape.w)
    expect(landscapeRegular.h).toBeGreaterThan(landscape.h)
  })

  it('下限只抬小屏，大屏仍按工作区比例', () => {
    // 1920 上竖屏 405 / 横屏 864，均高于下限，数值不受两个常量影响
    expect(computeInitialWindowSize(9 / 16, HD).w).toBe(408)
    expect(computeInitialWindowSize(16 / 9, HD).w).toBe(864)
  })

  it('工作区装不下下限时按可容纳范围回缩', () => {
    // 800x480：竖屏撑到下限需要更高，只留得下 480-30-48=402 → 高度封顶、宽度退回最小尺寸
    const tiny = { x: 0, y: 0, width: 800, height: 480 }
    const portrait = computeInitialWindowSize(9 / 16, tiny)
    expect(portrait.h).toBe(402 + floatBarHeight(FLOAT_MIN_WIDTH))
    expect(portrait.w).toBe(FLOAT_MIN_WIDTH)
    // 含 32px 边距也不出工作区
    expect(portrait.h + 32).toBeLessThanOrEqual(tiny.height)
  })

  it('分辨率翻倍时窗口同步翻倍，占屏比保持一致', () => {
    const uhd = computeInitialWindowSize(9 / 16, { x: 0, y: 0, width: 3840, height: 2160 })
    // 视频区 1477 + 栏高 35，正好是 HD 竖屏（725 + 31）的两倍
    expect(uhd.h).toBe(2 * 756)
    // 宽度取整会带来零点几个百分点的偏差，占屏比应当基本重合
    const hdRatio = 405 / HD.width
    const uhdRatio = uhd.w / 3840
    expect(Math.abs(uhdRatio - hdRatio)).toBeLessThan(0.02)
  })

  it('1920 及以上的横屏占屏宽比保持稳定', () => {
    expect(computeInitialWindowSize(16 / 9, HD).w / HD.width).toBeCloseTo(0.45, 2)
    expect(computeInitialWindowSize(16 / 9, { x: 0, y: 0, width: 3840, height: 2160 }).w / 3840).toBeCloseTo(0.45, 2)
  })

  it('小屏不会占掉半个屏幕', () => {
    const small = computeInitialWindowSize(9 / 16, { x: 0, y: 0, width: 1366, height: 768 })
    // 下限撑开后高度为 584，仍在工作区（留 32 边距）内
    expect(small.h).toBeLessThanOrEqual(768 - 32)
    expect(small.w).toBeLessThan(small.h)
  })

  it('极小工作区退化为最小尺寸而非负数', () => {
    expect(computeInitialWindowSize(9 / 16, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ w: 240, h: 160 })
  })
})

describe('floatBarHeight', () => {
  it('两端钳在 30 / 36，中间单调且逐档不跳变', () => {
    expect(floatBarHeight(240)).toBe(FLOAT_BAR_HEIGHT_MIN)
    expect(floatBarHeight(320)).toBe(FLOAT_BAR_HEIGHT_MIN)
    expect(floatBarHeight(900)).toBe(FLOAT_BAR_HEIGHT)
    expect(floatBarHeight(1600)).toBe(FLOAT_BAR_HEIGHT)

    let prev = floatBarHeight(300)
    for (let w = 300; w <= 950; w += 10) {
      const cur = floatBarHeight(w)
      expect(cur).toBeGreaterThanOrEqual(prev)
      expect(cur - prev).toBeLessThanOrEqual(1)
      prev = cur
    }
  })

  it('窄窗省下的栏高全部归视频区，窗口总高不变', () => {
    const compact = { x: 0, y: 0, width: 1280, height: 800 }
    const { w, h } = computeInitialWindowSize(9 / 16, compact)
    expect(floatBarHeight(w)).toBe(FLOAT_BAR_HEIGHT_MIN)
    // 总高仍贴着 80% 工作区高，栏矮 6px 则视频区高 6px
    expect(h).toBe(640)
    expect(h - floatBarHeight(w)).toBe(610)
  })
})

describe('decideAutoFit', () => {
  const EPSILON = 2
  // 已落定：首次定形完成，lastProgrammaticSize 是定形后的真实尺寸
  const settled = (over: Partial<FloatFitState> = {}): FloatFitState => ({
    userResized: false,
    autoFitSettled: true,
    lastProgrammaticSize: { w: 864, h: 522 },
    ...over,
  })

  it('未落定 → 无条件定形：横屏首次上报必须能纠正竖屏兜底尺寸', () => {
    // 回归：首次定形必须无条件执行，否则横屏会停在 9:16 兜底的窄窗上
    const state = settled({ autoFitSettled: false, lastProgrammaticSize: { w: 405, h: 756 } })
    expect(decideAutoFit(state, { w: 405, h: 756 }, EPSILON)).toEqual({ userResized: false, fit: true })
  })

  it('未落定 → 尺寸与建窗请求值对不上也照常定形（WM 取整 / DPI 偏差不是用户缩放）', () => {
    // Windows 的 per-monitor DPI 问题会让 getSize() 与请求值有偏差（见 electron#10862）
    const state = settled({ autoFitSettled: false, lastProgrammaticSize: { w: 405, h: 756 } })
    expect(decideAutoFit(state, { w: 411, h: 762 }, EPSILON)).toEqual({ userResized: false, fit: true })
  })

  it('未落定 → 无条件定形，并把误报的 userResized 清零（否则会永久禁掉后续定形）', () => {
    // will-resize 可能随建窗误报；若不清零，首次定形后旋屏重定形也会失效
    const state = settled({ autoFitSettled: false, userResized: true })
    expect(decideAutoFit(state, { w: 405, h: 756 }, EPSILON)).toEqual({ userResized: false, fit: true })
  })

  it('已落定 + 尺寸吻合 → 继续定形（重复上报是幂等的）', () => {
    expect(decideAutoFit(settled(), { w: 864, h: 522 }, EPSILON)).toEqual({ userResized: false, fit: true })
  })

  it('已落定 + 尺寸偏离超过容差 → 判定用户缩放，停止自动改尺寸', () => {
    expect(decideAutoFit(settled(), { w: 700, h: 522 }, EPSILON)).toEqual({ userResized: true, fit: false })
  })

  it('已落定 + 偏差在容差内 → 不算用户缩放（窗口管理器取整）', () => {
    expect(decideAutoFit(settled(), { w: 866, h: 520 }, EPSILON)).toEqual({ userResized: false, fit: true })
  })

  it('已标记用户接管 → 落定后一律不定形', () => {
    expect(decideAutoFit(settled({ userResized: true }), { w: 405, h: 756 }, EPSILON))
      .toEqual({ userResized: true, fit: false })
  })

  it('无程序设置尺寸记录 → 不做尺寸反推，照常定形', () => {
    expect(decideAutoFit(settled({ lastProgrammaticSize: null }), { w: 999, h: 999 }, EPSILON))
      .toEqual({ userResized: false, fit: true })
  })
})

describe('resolveFloatWindowPosition', () => {
  // 1080p 上 16:9 视频窗的初始尺寸（864x486 + 36 标题栏）
  const size = { w: 864, h: 522 }
  const first = resolveFloatWindowPosition(HD, size, 0)

  it('第一个窗贴工作区右上角并留白', () => {
    expect(first).toEqual({ x: 1920 - 864 - 24, y: 24 })
  })

  it('后续窗口沿对角向左下级联错开，不再完全重叠', () => {
    expect(resolveFloatWindowPosition(HD, size, 1))
      .toEqual({ x: first.x - FLOAT_CASCADE_STEP, y: first.y + FLOAT_CASCADE_STEP })
    expect(resolveFloatWindowPosition(HD, size, 2))
      .toEqual({ x: first.x - 2 * FLOAT_CASCADE_STEP, y: first.y + 2 * FLOAT_CASCADE_STEP })
  })

  it('级联步数用尽后回绕，不会把窗口推出工作区', () => {
    // 竖向可用 510px / 步长 28 → 19 档；第 19 个（index=19）回到第 0 档
    expect(resolveFloatWindowPosition(HD, size, 19)).toEqual(first)
    expect(resolveFloatWindowPosition(HD, size, 20))
      .toEqual({ x: first.x - FLOAT_CASCADE_STEP, y: first.y + FLOAT_CASCADE_STEP })
  })

  it('每档都在工作区内', () => {
    for (let index = 0; index < 40; index++) {
      const { x, y } = resolveFloatWindowPosition(HD, size, index)
      expect(x).toBeGreaterThanOrEqual(HD.x)
      expect(y).toBeGreaterThanOrEqual(HD.y)
      expect(x + size.w).toBeLessThanOrEqual(HD.x + HD.width)
      expect(y + size.h).toBeLessThanOrEqual(HD.y + HD.height)
    }
  })

  it('工作区比窗口还小：钉在工作区原点而不是负坐标', () => {
    expect(resolveFloatWindowPosition({ x: 0, y: 0, width: 200, height: 100 }, { w: 240, h: 160 }, 3))
      .toEqual({ x: 0, y: 0 })
  })
})

describe('resolveFloatTopmost', () => {
  it('always 与播放状态无关，恒置顶', () => {
    expect(resolveFloatTopmost('always', true)).toBe(true)
    expect(resolveFloatTopmost('always', false)).toBe(true)
  })

  it('playing 跟随播放状态：播放中置顶，暂停让出层级', () => {
    expect(resolveFloatTopmost('playing', true)).toBe(true)
    expect(resolveFloatTopmost('playing', false)).toBe(false)
  })

  it('never 恒不置顶', () => {
    expect(resolveFloatTopmost('never', true)).toBe(false)
    expect(resolveFloatTopmost('never', false)).toBe(false)
  })
})

describe('initialFloatTopmost', () => {
  // 建窗时还没有播放状态上报：playing 策略也必须先置顶，否则新窗一出现就被主窗口盖住
  it('非 never 都先置顶', () => {
    expect(initialFloatTopmost('always')).toBe(true)
    expect(initialFloatTopmost('playing')).toBe(true)
  })

  it('never 建窗即不置顶', () => {
    expect(initialFloatTopmost('never')).toBe(false)
  })
})

describe('isFloatTopmostPinned', () => {
  // 亮灭以「此刻是否真的置顶」为准：仅播放时策略在播放中也算点亮，暂停时熄灭
  it('always 恒点亮，never 恒熄灭', () => {
    for (const playing of [null, false, true] as const) {
      expect(isFloatTopmostPinned('always', playing)).toBe(true)
      expect(isFloatTopmostPinned('never', playing)).toBe(false)
    }
  })

  it('playing 随播放状态：播放中点亮，暂停熄灭', () => {
    expect(isFloatTopmostPinned('playing', true)).toBe(true)
    expect(isFloatTopmostPinned('playing', false)).toBe(false)
  })

  it('播放状态未上报时按建窗态算，免得首帧图钉与窗口层级相反', () => {
    expect(isFloatTopmostPinned('playing', null)).toBe(true)
  })
})

describe('nextFloatTopmost', () => {
  // 图钉是本窗二态开关：点亮 → 取消置顶；未点亮 → 始终置顶
  it('默认策略下播放中（点亮）第一击取消置顶，第二击改为始终置顶', () => {
    const first = nextFloatTopmost('playing', true)
    expect(first).toBe('never')
    expect(nextFloatTopmost(first, true)).toBe('always')
  })

  it('已暂停（未点亮）时点击改为始终置顶', () => {
    expect(nextFloatTopmost('playing', false)).toBe('always')
    expect(nextFloatTopmost('never', false)).toBe('always')
  })

  it('始终置顶（点亮）点击取消', () => {
    expect(nextFloatTopmost('always', true)).toBe('never')
    expect(nextFloatTopmost('always', false)).toBe('never')
  })
})
