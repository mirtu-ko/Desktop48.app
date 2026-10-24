import { useIntervalFn } from '@vueuse/core'
import { watch } from 'vue'

/** 游客在线人数补拉间隔：一场直播 40 次上下，对详情接口无压力但足以避免数字长期停在首帧 */
export const ONLINE_POLL_INTERVAL = 90_000

/**
 * 游客在线人数轮询：未登录不建 IM 会话，拿不到 LIVEUPDATE 推送，
 * 人数会一直停在进房首帧，只能按固定间隔补拉一次详情。
 *
 * 调用方用 enabled 组合「进行中的个人直播 + 游客 + 窗口可见 + 未进结束态」，
 * 本 composable 只管计时与取数，不管播放（详情里的 playStreamPath 一旦应用就是重建流）。
 */
export function useOnlinePoll(options: {
  /** 是否该跑：条件翻转时自动启停计时 */
  enabled: () => boolean
  /** 拉一次在线人数；undefined 表示上游没带该字段（公演 / 详情缺省） */
  fetchOnline: () => Promise<number | undefined>
  /** 采纳新值 */
  onOnline: (num: number) => void
  intervalMs?: number
  /** 失败回调（轮询失败必须静默，不能弹窗） */
  onError?: (error: unknown) => void
}) {
  /** 单次补拉：进入与回包各判一次 enabled，隐藏 / 登录 / 结束 / 卸载后的在途回包一律丢弃 */
  async function poll() {
    if (!options.enabled())
      return
    try {
      const num = await options.fetchOnline()
      if (!options.enabled())
        return
      // 0 视为无效值不采纳，与 LIVEUPDATE 同一口径
      if (num !== undefined && num > 0)
        options.onOnline(num)
    }
    catch (error) {
      options.onError?.(error)
    }
  }

  const timer = useIntervalFn(() => void poll(), options.intervalMs ?? ONLINE_POLL_INTERVAL, { immediate: false })

  watch(() => options.enabled(), (on) => {
    if (on)
      timer.resume()
    else
      timer.pause()
  }, { immediate: true })

  return { poll, isActive: timer.isActive }
}
