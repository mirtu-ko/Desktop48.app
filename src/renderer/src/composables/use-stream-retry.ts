import type { Ref } from 'vue'
import { nextRetryAttempt } from '@renderer/utils/live-stream'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

/**
 * 直播断流重试状态机：
 * 统一重试节奏（定时器串行，避免并发重连），计满 maxRetries 次后
 * 走 onExhausted（提示直播结束 + 停流 + 关闭浮窗）。
 * 重试决策用纯函数 nextRetryAttempt，见 utils/live-stream.ts。
 */
export function useStreamRetry(options: {
  maxRetries?: number
  retryDelayMs?: number
  isDisposed: () => boolean
  mediaLoading: Ref<boolean>
  /** 单次恢复尝试：拉详情 → 重建流。抛错视为本次失败，进入下一次重试 */
  attempt: () => Promise<void>
  /** 重试耗尽：组件在此停流、广播下架、关闭浮窗 */
  onExhausted: () => void
}) {
  const maxRetries = options.maxRetries ?? 3
  const retryDelayMs = options.retryDelayMs ?? 2000

  const retryCount = ref(0)
  const isRecoveringStream = ref(false)

  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  /** 计数与恢复态全部复位（新会话开始时调用） */
  function reset() {
    clearTimer()
    retryCount.value = 0
    isRecoveringStream.value = false
  }

  /**
   * 安排一次恢复。网络抖动、链接过期等都走这里的统一节奏：
   * 未达上限 → 延迟 retryDelayMs 后执行 attempt；
   * 已达上限 → 走 onExhausted。
   */
  function schedule() {
    if (options.isDisposed() || isRecoveringStream.value)
      return

    const next = nextRetryAttempt(retryCount.value, maxRetries)
    if (next === null) {
      options.mediaLoading.value = false
      isRecoveringStream.value = false
      ElMessage.warning('直播已结束')
      options.onExhausted()
      return
    }

    retryCount.value = next
    isRecoveringStream.value = true
    options.mediaLoading.value = true
    clearTimer()
    retryTimer = setTimeout(async () => {
      try {
        await options.attempt()
        // attempt 成功路径下流仍在加载（mediaLoading=true），复位恢复态
        // 让后续错误可以再次触发重试。
        // 只能在成功路径复位：catch 里 schedule() 已重新置位重入守卫并安排了
        // 下一次重试，若放 finally 里无条件复位，会把等待期内的守卫提前撤销，
        // 重复错误事件会反复重入 schedule()，重试预算被加速耗尽
        if (options.mediaLoading.value)
          isRecoveringStream.value = false
      }
      catch (error) {
        console.error('[use-stream-retry] 重试恢复直播流失败:', error)
        schedule()
      }
    }, retryDelayMs)
  }

  return { retryCount, isRecoveringStream, schedule, reset, clearTimer }
}
