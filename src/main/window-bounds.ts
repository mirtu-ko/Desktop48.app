/**
 * 主窗口初始尺寸：基准 1400×900。窄屏按可用工作区收敛并让出一圈留白，
 * 宽屏（工作区宽 >1944）按比例放大，避免在超宽屏上只占中间一小块。
 */

export interface WorkAreaSize {
  width: number
  height: number
}

export interface WorkArea extends WorkAreaSize {
  x: number
  y: number
}

export interface WindowSizeSpec {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 期望尺寸。宽度 1400 是详情卡双栏的舒服档，高度 900 是常规 16:10 屏的常见值 */
export const WINDOW_PREFERRED: WindowSizeSpec = {
  width: 1400,
  height: 900,
  minWidth: 720,
  minHeight: 560,
}

/**
 * 宽屏放大比例：期望值同时是「下限基准」，实际取 `max(期望值, 工作区 × 比例)`。
 * 工作区宽 ≤1944（1400 / 0.65）时比例值小于期望值，窗口与旧版逐像素一致——1920 及以下不受影响；
 * 2560×1080 / 2560×1440 上则是 1664 宽，不再在两侧各空出 580px 的桌面。
 */
export const WIDE_SCREEN_RATIO = 0.65

/**
 * 窗口四边与工作区之间的留白。不留边时窗口会贴着屏幕边缘：1280×800 上四边全贴（看着像被裁掉），
 * 1080p@125%（工作区 1536×832）上更怪——高度方向贴死、宽度方向留空。
 */
export const WINDOW_EDGE_GAP = 32

/**
 * 单边收敛：先按宽屏比例放大期望值，再让出两侧留白，最后夹到 [下限, 工作区]。
 * 夹工作区是保命用的：工作区小到连下限都放不下时（如 533 高的可用区与 560 的 minHeight），
 * 只能放弃留白、退回工作区尺寸，绝不让窗口超出屏幕。
 */
function fitEdge(area: number, preferred: number, min: number): number {
  const wanted = Math.max(preferred, Math.round(area * WIDE_SCREEN_RATIO))
  const withGap = area - 2 * WINDOW_EDGE_GAP
  return Math.min(wanted, Math.min(area, Math.max(withGap, min)))
}

/**
 * 宽屏按比例放大、窄屏按工作区收敛，两种路径都让出留白。下限必须一并收敛：Electron 会把
 * 小于 minWidth/minHeight 的初始尺寸强行抻到下限，1366×768@125%（工作区约 1093×589）下
 * 560 的 minHeight 才不会再撑出屏幕。
 */
export function computeWindowBounds(
  workArea: WorkAreaSize,
  preferred: WindowSizeSpec = WINDOW_PREFERRED,
): WindowSizeSpec {
  const width = fitEdge(workArea.width, preferred.width, preferred.minWidth)
  const height = fitEdge(workArea.height, preferred.height, preferred.minHeight)
  return {
    width,
    height,
    minWidth: Math.min(preferred.minWidth, width),
    minHeight: Math.min(preferred.minHeight, height),
  }
}

/** 在工作区内居中。显式给坐标：不传 x/y 时 Windows 会从左上角层叠，各平台行为不一致 */
export function centerWindow(
  workArea: WorkArea,
  size: Pick<WindowSizeSpec, 'width' | 'height'>,
): { x: number, y: number } {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round((workArea.height - size.height) / 2),
  }
}
