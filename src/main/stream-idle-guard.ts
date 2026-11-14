/**
 * FFmpeg 输出空闲守卫：上游 TCP 连接还活着但不再吐数据时（如本机断网），
 * FFmpeg 不会退出，本地 FLV 响应也永远不会结束，播放器会静默冻在最后一帧。
 * 到点主动结束响应，把「静默挂死」转成 mpegts 的 ended 信号，交给既有断流重试链。
 */
export const STREAM_IDLE_TIMEOUT_MS = 10_000

export interface StreamIdleGuard {
  /** 收到 stdout 数据时刷新计时 */
  touch: () => void
  /** 响应结束 / 进程退出时撤销，且此后不再触发 */
  dispose: () => void
}

/** 从创建起算（首帧迟迟不来也该重建），每次 touch 重新计时，只回调一次 */
export function createStreamIdleGuard(onIdle: () => void, timeoutMs = STREAM_IDLE_TIMEOUT_MS): StreamIdleGuard {
  let timer: ReturnType<typeof setTimeout> | null = null
  let fired = false
  let disposed = false

  function arm() {
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed || fired)
        return
      fired = true
      onIdle()
    }, timeoutMs)
  }

  arm()

  return {
    touch() {
      if (!disposed && !fired)
        arm()
    },
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
