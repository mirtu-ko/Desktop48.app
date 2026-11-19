import type { FloatTopmost } from '@common/app-config'
import { isFloatTopmost } from '@common/app-config'
import { debugLog } from '@renderer/utils/debug'
import { ref } from 'vue'

/**
 * 独立播放窗的置顶**默认策略**（模块级单例，与 stores/danmaku-placement.ts 同一模式）。
 * 只归设置页所有；播放窗标题栏的图钉改的是那一扇窗自己的策略，不回写这里。
 */
export const floatTopmost = ref<FloatTopmost>('playing')

/** 首次读取的 Promise：并发调用共用一次 IPC */
let pending: Promise<void> | null = null

/** 读取偏好；失败按「仅播放时」处理，不值得打扰用户 */
export function ensureFloatTopmost(): Promise<void> {
  pending ??= window.mainAPI.getConfig('floatTopmost')
    .then((value) => {
      // 旧库 / 手改配置里的未知取值一律当未设置
      if (isFloatTopmost(value))
        floatTopmost.value = value
    })
    .catch((error) => {
      debugLog('live', '置顶偏好读取失败，按仅播放时处理', error)
    })
  return pending
}

/** 写入偏好：先改内存让按钮立刻跟手，写盘失败再回滚（否则下次启动会悄悄变回旧值） */
export async function setFloatTopmost(next: FloatTopmost): Promise<void> {
  const previous = floatTopmost.value
  if (previous === next)
    return
  floatTopmost.value = next
  try {
    // 走播放窗通道而非裸 setConfig：主进程要顺手把新策略作用到已打开的窗
    await window.mainAPI.floatWindowSetTopmostPreference(next)
  }
  catch (error) {
    floatTopmost.value = previous
    debugLog('live', `置顶偏好写入失败：${next}`, error)
  }
}
