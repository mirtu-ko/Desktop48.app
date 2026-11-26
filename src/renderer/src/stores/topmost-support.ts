import { debugLog } from '@renderer/utils/debug'
import { ref } from 'vue'

/**
 * 本平台的窗口管理器是否采信置顶请求（模块级单例）。
 *
 * ChromeOS 的 Linux 容器（Crostini）里窗口由 Ash 托管，置顶请求会被静默忽略
 * （判据见 main/window/topmost-support.ts）。这类环境下图钉与设置项要降级成说明态，
 * 否则用户只会看到「点了没反应」。默认 true：能力查询是异步的，未查完前按可用渲染，
 * 避免设置页 / 播放窗闪一下禁用态。
 */
export const topmostSupported = ref(true)

/** 首次查询的 Promise：并发调用共用一次 IPC */
let pending: Promise<void> | null = null

/** 查询置顶能力；失败按可用处理（宁可多显示一个按钮，也不要误把正常环境锁死） */
export function ensureTopmostSupport(): Promise<void> {
  pending ??= window.mainAPI.windowTopmostSupported()
    .then((value) => {
      topmostSupported.value = value
    })
    .catch((error) => {
      debugLog('live', '置顶能力查询失败，按可用处理', error)
    })
  return pending
}
