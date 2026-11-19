/** 密度档判据是视口内容高度：无边框窗口下等于 BrowserWindow.height，不是工作区高度。 */
export const DENSITY_BREAKPOINT = 760

export type Density = 'regular' | 'compact'

/** 断点值只在这里定义一次；样式侧只读 html[data-density]，不再各自写媒体查询。 */
export function resolveDensity(viewportHeight: number): Density {
  return viewportHeight <= DENSITY_BREAKPOINT ? 'compact' : 'regular'
}
