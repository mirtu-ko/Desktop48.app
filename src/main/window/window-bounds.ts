/** 主窗口几何：基准 1400×900，按工作区等比放大、夹住小屏长宽比、居中，显示器变化后收回可见区。 */

export interface WorkAreaSize {
  width: number
  height: number
}

export interface WorkArea extends WorkAreaSize {
  x: number
  y: number
}

export interface WindowRect extends WorkAreaSize {
  x: number
  y: number
}

export interface WindowSizeSpec {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 期望尺寸；minWidth/minHeight 是 Electron 会强行抻到的下限 */
export const WINDOW_PREFERRED: WindowSizeSpec = {
  width: 1400,
  height: 900,
  minWidth: 720,
  minHeight: 560,
}

/** 大屏放大判定：窗口最多占工作区任一轴的 65%，两轴各自换算倍率后取小者 */
export const WIDE_SCREEN_RATIO = 0.65

/** 相对基准尺寸的最大放大倍率；宽高共用同一倍率，保持基准长宽比 */
export const WIDE_SCREEN_MAX_SCALE = 1.2

/** 窗口四边与工作区之间的留白 */
export const WINDOW_EDGE_GAP = 32

/** 高度被工作区压低时，窗口宽不超过这个长宽比；宽屏按比例放大的尺寸不受约束 */
export const WINDOW_MAX_ASPECT = 1.7

/** 单边收敛：按工作区放大（倍率封顶）→ 让出留白 → 夹到 [下限, 工作区]；工作区小于下限时放弃留白 */
function fitEdge(area: number, preferred: number, min: number): number {
  const threshold = preferred / WIDE_SCREEN_RATIO
  const scale = Math.min(WIDE_SCREEN_MAX_SCALE, area / threshold)
  const wanted = Math.max(preferred, Math.round(preferred * scale))
  const withGap = area - 2 * WINDOW_EDGE_GAP
  return Math.min(wanted, Math.min(area, Math.max(withGap, min)))
}

/** 大屏等比放大：两轴倍率取小者并封顶，宽高共用，长宽比恒为基准；未超过基准时返回 null 交给收敛路径 */
function fitWideScreen(workArea: WorkAreaSize, preferred: WindowSizeSpec): WindowSizeSpec | null {
  const scale = Math.min(
    workArea.width / (preferred.width / WIDE_SCREEN_RATIO),
    workArea.height / (preferred.height / WIDE_SCREEN_RATIO),
  )
  if (scale <= 1)
    return null
  const capped = Math.min(WIDE_SCREEN_MAX_SCALE, scale)
  const width = Math.round(preferred.width * capped)
  const height = Math.round(preferred.height * capped)
  return {
    width,
    height,
    minWidth: Math.min(preferred.minWidth, width),
    minHeight: Math.min(preferred.minHeight, height),
  }
}

/** 下限必须跟着收敛：Electron 会把小于下限的初始尺寸强行抻大 */
export function computeWindowBounds(
  workArea: WorkAreaSize,
  preferred: WindowSizeSpec = WINDOW_PREFERRED,
): WindowSizeSpec {
  const wide = fitWideScreen(workArea, preferred)
  if (wide)
    return wide
  const height = fitEdge(workArea.height, preferred.height, preferred.minHeight)
  const rawWidth = fitEdge(workArea.width, preferred.width, preferred.minWidth)
  const aspectCap = Math.max(preferred.minWidth, Math.round(height * WINDOW_MAX_ASPECT))
  const width = height < preferred.height ? Math.min(rawWidth, aspectCap) : rawWidth
  return {
    width,
    height,
    minWidth: Math.min(preferred.minWidth, width),
    minHeight: Math.min(preferred.minHeight, height),
  }
}

/** 显式给坐标：不传 x/y 时 Windows 从左上角层叠，各平台行为不一致 */
export function centerWindow(
  workArea: WorkArea,
  size: Pick<WindowSizeSpec, 'width' | 'height'>,
): { x: number, y: number } {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round((workArea.height - size.height) / 2),
  }
}

/** 显示器参数变化后把窗口收回新工作区；只在越界时动，不覆盖用户手动调过的尺寸 */
export function fitWindowToWorkArea(bounds: WindowRect, area: WorkArea): WindowRect {
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}
