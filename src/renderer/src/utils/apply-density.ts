import { DENSITY_BREAKPOINT, resolveDensity } from '@common/density'

interface DensityRoot {
  dataset: { density?: string }
}

/** 唯一写入口：同值不写，避免窗口尺寸抖动时反复触发样式重算。 */
export function applyDensity(root: DensityRoot, viewportHeight: number): void {
  const next = resolveDensity(viewportHeight)
  if (root.dataset.density !== next)
    root.dataset.density = next
}

/** 首帧同步写入；之后只在跨越断点时重算，阈值与 resolveDensity 同源。 */
export function installDensitySignal(root: DensityRoot = document.documentElement): void {
  const sync = () => applyDensity(root, window.innerHeight)
  sync()
  window.matchMedia(`(max-height: ${DENSITY_BREAKPOINT}px)`).addEventListener('change', sync)
}
