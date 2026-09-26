import type { FloatFitState } from '../src/common/float-window'
import { describe, expect, it } from 'vitest'
import { computeInitialWindowSize, decideAutoFit, fitAspectInBox, FLOAT_BAR_HEIGHT, FLOAT_CASCADE_STEP, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, FLOAT_RADIO_WINDOW_SIZE, resolveFloatWindowPosition } from '../src/common/float-window'

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
    // maxW = 864，但 9:16 下高度会到 1536 > 1080*0.7-36 = 720 → 回缩到 405x720
    expect(computeInitialWindowSize(9 / 16, HD)).toEqual({ w: 405, h: 720 + FLOAT_BAR_HEIGHT })
  })

  it('横屏视频不会被竖屏兜底比例压成窄窗', () => {
    // 回归：兜底 9:16 的宽度是 405，真实 16:9 若只保宽度就会得到 405x264 的小窗
    const portrait = computeInitialWindowSize(9 / 16, HD)
    const landscape = computeInitialWindowSize(16 / 9, HD)
    expect(portrait.w).toBe(405)
    expect(landscape.w).toBe(864)
    expect(landscape.w).toBeGreaterThan(portrait.w * 2)
  })

  it('两个方向各自的比例都不受对方影响', () => {
    // 横屏吃宽度上限，竖屏吃高度上限；同一块屏幕上两者互不干扰
    const small = { width: 1366, height: 768 }
    // 竖屏：高度封顶 502，宽度回缩到 282
    expect(computeInitialWindowSize(9 / 16, small)).toEqual({ w: 282, h: 502 + FLOAT_BAR_HEIGHT })
    // 横屏：宽度 615 未被高度封顶，直接铺满
    expect(computeInitialWindowSize(16 / 9, small)).toEqual({ w: 615, h: 346 + FLOAT_BAR_HEIGHT })
  })

  it('分辨率翻倍时窗口同步翻倍，占屏比保持一致', () => {
    const uhd = computeInitialWindowSize(9 / 16, { width: 3840, height: 2160 })
    expect(uhd.h).toBe(2 * (720 + FLOAT_BAR_HEIGHT))
    // 宽度取整会带来零点几个百分点的偏差，占屏比应当基本重合
    const hdRatio = 405 / HD.width
    const uhdRatio = uhd.w / 3840
    expect(Math.abs(uhdRatio - hdRatio)).toBeLessThan(0.02)
  })

  it('横屏占屏宽比在各分辨率下恒定', () => {
    expect(computeInitialWindowSize(16 / 9, HD).w / HD.width).toBeCloseTo(0.45, 2)
    expect(computeInitialWindowSize(16 / 9, { width: 3840, height: 2160 }).w / 3840).toBeCloseTo(0.45, 2)
  })

  it('小屏不会占掉半个屏幕', () => {
    const small = computeInitialWindowSize(9 / 16, { width: 1366, height: 768 })
    expect(small.h).toBeLessThanOrEqual(Math.round(768 * 0.7))
    expect(small.w).toBeLessThan(small.h)
  })

  it('极小工作区退化为最小尺寸而非负数', () => {
    expect(computeInitialWindowSize(9 / 16, { width: 200, height: 100 })).toEqual({ w: 240, h: 160 })
  })
})

describe('fLOAT_RADIO_WINDOW_SIZE', () => {
  it('竖屏：高度大于宽度', () => {
    expect(FLOAT_RADIO_WINDOW_SIZE.h).toBeGreaterThan(FLOAT_RADIO_WINDOW_SIZE.w)
  })

  it('不小于窗口最小尺寸（否则会被 BrowserWindow 的 minWidth / minHeight 顶回去）', () => {
    expect(FLOAT_RADIO_WINDOW_SIZE.w).toBeGreaterThanOrEqual(FLOAT_MIN_WIDTH)
    expect(FLOAT_RADIO_WINDOW_SIZE.h).toBeGreaterThanOrEqual(FLOAT_MIN_HEIGHT)
  })

  it('扣掉标题栏后视频区仍留有高度', () => {
    expect(FLOAT_RADIO_WINDOW_SIZE.h - FLOAT_BAR_HEIGHT).toBeGreaterThan(0)
  })

  it('比同屏横屏视频窗更窄（电台不该占得比视频还宽）', () => {
    expect(FLOAT_RADIO_WINDOW_SIZE.w).toBeLessThan(computeInitialWindowSize(16 / 9, HD).w)
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
