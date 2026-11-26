/**
 * 置顶能力判定：Linux 桌面的窗口置顶由系统窗口菜单（如 GNOME/KDE 右键 Always on Top）承担，
 * 应用内不提供置顶功能（Wayland 协议不支持、Crostini Ash 忽略、各合成器行为不一致）；
 * Windows 与 macOS 原生支持并保留。
 */
export function computeTopmostSupported(platform: string): boolean {
  return platform !== 'linux'
}

/** 当前平台是否支持应用内窗口置顶 */
export function isTopmostSupported(): boolean {
  return computeTopmostSupported(process.platform)
}
