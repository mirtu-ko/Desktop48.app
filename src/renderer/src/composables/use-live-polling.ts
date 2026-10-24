import { formatMediaTime } from '@renderer/utils/time-format'
import { useIntervalFn } from '@vueuse/core'
import { computed, ref } from 'vue'

/**
 * 直播已播时长：每秒刷新，基于开播时间戳（毫秒）累加，启动时立即算一次避免首秒显示 0。
 *
 * 在线人数不在这里轮询：首帧来自会话详情（use-live-session 的 onOnlineNum），
 * 实时值走云信 LIVEUPDATE 推送（与官方 App 同构，见 pocket-chat-message 的 liveOnline），
 * 无 IM 会话（未登录 / 开放公演）时保持首帧值不再变化。
 *
 * immediateCallback 让 resume 时立即执行一拍（时长首拍不为 0），
 * scope dispose 时 useIntervalFn 自动暂停，不需要手动清理。
 */
export function useLivePolling(options: {
  startTime: () => number
}) {
  const elapsedTime = ref(0)

  const elapsedTimer = useIntervalFn(() => {
    elapsedTime.value = Date.now() - options.startTime()
  }, 1000, { immediate: false, immediateCallback: true })

  const liveElapsedText = computed(() => {
    const totalSeconds = Math.max(0, Math.floor(elapsedTime.value / 1000))
    return formatMediaTime(totalSeconds)
  })

  return {
    elapsedTime,
    liveElapsedText,
    startElapsedTimer: elapsedTimer.resume,
    stopAll: () => {
      elapsedTimer.pause()
    },
  }
}
