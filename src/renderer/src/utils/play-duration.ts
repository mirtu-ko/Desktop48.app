// 播放时长上报。
//
// 关闭独立播放窗会销毁渲染进程，Vue 的 onUnmounted 不会执行（页面卸载不触发组件卸载钩子），
// 时长因此不能挂在卸载时机上。改为三段式：播放窗打开时登记类型、首次出画时记起点、
// 窗口即将消失时上报一次分桶。
//
// 窗口消失的两条路径：应用自带关闭按钮（先上报再关）与 pagehide（Alt+F4 / 任务栏关闭）。
// 应用整体退出走 destroy()，不触发任何渲染端回调，该场景的时长会丢失。
import { DURATION_BUCKET_FAILED, durationBucket, trackEvent } from '@renderer/utils/umami'

export type PlayDurationKind = 'live' | 'playback'

// 枚举下沉到事件名：事件名不占配额，属性每条另算一条。
// 该事件此前从未成功上报过，改名没有历史序列要迁移。
const EVENT_NAMES: Record<PlayDurationKind, string> = {
  live: 'live:duration',
  playback: 'playback:duration',
}

let kind: PlayDurationKind | null = null
let started = false
let startedAt = 0
let reported = false

/** 播放窗打开时登记类型（kind 来自 URL，早于播放器挂载），此刻尚未出画 */
export function openPlayDuration(next: PlayDurationKind): void {
  kind = next
  started = false
  startedAt = 0
  reported = false
}

/** 首次出画：记录观看起点 */
export function markPlayDurationStarted(): void {
  if (started)
    return
  started = true
  startedAt = Date.now()
}

/** 窗口即将消失：上报一次观看时长。重复调用只生效一次 */
export function flushPlayDuration(): void {
  if (reported || !kind)
    return
  reported = true
  const bucket = started ? durationBucket((Date.now() - startedAt) / 1000) : DURATION_BUCKET_FAILED
  trackEvent(EVENT_NAMES[kind], { bucket })
}
