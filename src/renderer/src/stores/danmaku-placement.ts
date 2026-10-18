import type { DanmakuPlacement } from '@common/app-config'
import { debugLog } from '@renderer/utils/debug'
import { ref } from 'vue'

/**
 * 弹幕摆放偏好（模块级单例，与 stores/member-flags.ts 同一模式）。
 * 存的是「偏好」不是「生效值」：左侧黑边不够宽时由 useDanmakuLayer 回落画面内，
 * 但偏好本身保持不变——转个身（旋转 / 退出全屏）回来还要按用户选的那样摆。
 */
export const danmakuPlacement = ref<DanmakuPlacement>('video')

/** 首次读取的 Promise：两个播放器并发调用共用一次 IPC */
let pending: Promise<void> | null = null

/** 读取偏好；失败按画面内处理，不值得打扰用户 */
export function ensureDanmakuPlacement(): Promise<void> {
  pending ??= window.mainAPI.getConfig('danmakuPlacement')
    .then((value) => {
      // 旧库 / 手改配置里的未知取值一律当未设置
      danmakuPlacement.value = value === 'left' ? 'left' : 'video'
    })
    .catch((error) => {
      debugLog('live', '弹幕摆放偏好读取失败，按画面内处理', error)
    })
  return pending
}

/** 写入偏好：先改内存让按钮立刻跟手，写盘失败再回滚（否则下次启动会悄悄变回旧值） */
export async function setDanmakuPlacement(next: DanmakuPlacement): Promise<void> {
  const previous = danmakuPlacement.value
  if (previous === next)
    return
  danmakuPlacement.value = next
  try {
    await window.mainAPI.setConfig('danmakuPlacement', next)
  }
  catch (error) {
    danmakuPlacement.value = previous
    debugLog('live', `弹幕摆放偏好写入失败：${next}`, error)
  }
}
