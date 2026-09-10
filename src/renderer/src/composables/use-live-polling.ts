import Apis from '@renderer/services/apis'
import { formatMediaTime } from '@renderer/utils/time-format'
import { computed, ref } from 'vue'

/**
 * 直播轮询：
 * - 已播时长：每秒刷新，基于开播时间戳（毫秒）累加，启动时立即算一次避免首秒显示 0
 * - 在线人数：每 30 秒拉一次详情；开放公演接口无此字段，跳过轮询
 */
export function useLivePolling(options: {
  startTime: () => number
  liveId: () => string
  /** source === 'open' 时为 true */
  skipOnlineNum: () => boolean
}) {
  const elapsedTime = ref(0)
  const onlineNum = ref(0)

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let onlineNumTimer: ReturnType<typeof setInterval> | null = null

  function startElapsedTimer() {
    stopElapsedTimer()
    elapsedTime.value = Date.now() - options.startTime()
    elapsedTimer = setInterval(() => {
      elapsedTime.value = Date.now() - options.startTime()
    }, 1000)
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  function updateOnlineNum() {
    if (options.skipOnlineNum())
      return
    Apis.live(options.liveId()).then((data) => {
      onlineNum.value = data.onlineNum ?? 0
    }).catch((error: any) => {
      console.error(error)
    })
  }

  function startOnlineNumTimer() {
    stopOnlineNumTimer()
    updateOnlineNum()
    onlineNumTimer = setInterval(() => {
      updateOnlineNum()
    }, 30000)
  }

  function stopOnlineNumTimer() {
    if (onlineNumTimer) {
      clearInterval(onlineNumTimer)
      onlineNumTimer = null
    }
  }

  const liveElapsedText = computed(() => {
    const totalSeconds = Math.max(0, Math.floor(elapsedTime.value / 1000))
    return formatMediaTime(totalSeconds)
  })

  function stopAll() {
    stopElapsedTimer()
    stopOnlineNumTimer()
  }

  return {
    elapsedTime,
    onlineNum,
    liveElapsedText,
    startElapsedTimer,
    stopElapsedTimer,
    startOnlineNumTimer,
    stopOnlineNumTimer,
    stopAll,
  }
}
