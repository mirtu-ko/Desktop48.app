import { useLiveDanmakuOverlay } from '@renderer/composables/use-danmaku-overlay'
import { debugLog } from '@renderer/utils/debug'
import { useIntervalFn } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import { onScopeDispose, watch } from 'vue'

/** 延迟补偿上限（秒）：画面比弹幕慢多少就把弹幕推后多少；反向（弹幕晚于画面）无从提前 */
export const DANMAKU_DELAY_LIMIT = 30
/** 默认补偿：48 的流要过 FFmpeg 转封装 + MSE 缓冲，通常落后 B 站弹幕数秒 */
export const DANMAKU_DELAY_DEFAULT = 5
/** 气泡回收节拍：展示时长是秒级，250ms 足够跟手 */
const OVERLAY_TICK_MS = 250

/**
 * 直播弹幕：订阅主进程下发的 B 站弹幕，按延迟补偿投放到左下角气泡层。
 * 延迟补偿是必需项 —— 画面过 FFmpeg 转封装 + MSE 缓冲会稳定落后，不补偿就「弹幕抢在画面之前」。
 * 失败一律静默降级：连不上只提示一次，不干扰直播播放。
 */
export function useLiveDanmaku(options: {
  /** B 站房间号；undefined 表示该直播没有对应房间（个人直播），不订阅 */
  roomId: () => number | undefined
  /** 是否开启弹幕 */
  enabled: () => boolean
  /** 延迟补偿秒数 */
  delaySeconds: () => number
}) {
  const { items: danmakuItems, push, tick, reset } = useLiveDanmakuOverlay()

  /** 会话起点（毫秒）：把墙钟折成引擎认得的秒数轴 */
  let originMs = 0
  /** 当前已订阅的房间号；undefined = 未订阅 */
  let activeRoomId: number | undefined
  let unsubscribe: (() => void) | null = null
  /** 累计收到条数：与主进程的同名计数对照，两个数不一致就说明丢在 IPC 或房间过滤上 */
  let receivedCount = 0

  const nowSeconds = () => (originMs === 0 ? 0 : (Date.now() - originMs) / 1000)

  const { pause: pauseOverlay, resume: resumeOverlay } = useIntervalFn(
    () => tick(nowSeconds()),
    OVERLAY_TICK_MS,
    { immediate: false },
  )

  function stop() {
    pauseOverlay()
    unsubscribe?.()
    unsubscribe = null
    if (activeRoomId !== undefined)
      void window.mainAPI.danmakuStop(activeRoomId)
    activeRoomId = undefined
    originMs = 0
    reset()
  }

  async function start(roomId: number) {
    originMs = Date.now()
    activeRoomId = roomId
    receivedCount = 0
    // 先订阅再握手，免得握手期间到达的弹幕被丢掉
    unsubscribe = window.mainAPI.danmakuBatch((batch) => {
      if (batch.roomId !== activeRoomId)
        return
      receivedCount += batch.items.length
      // 可见数取自上一次节拍：push 只入队，所以它反映的是「实际挂在层上的条数」
      debugLog(
        'live',
        `B站弹幕: 收到 ${batch.items.length} 条（累计 ${receivedCount}，可见 ${danmakuItems.value.length}）`,
        batch.items.map(item => `${item.username}: ${item.text}`),
      )
      // 整批共用同一投放时刻（批内先后由 push 顺序保证）；补偿加在这里：画面慢几秒就推后几秒
      const showAt = nowSeconds() + options.delaySeconds()
      for (const item of batch.items)
        push(item.text, item.username, showAt)
    })
    resumeOverlay()

    const ok = await window.mainAPI.danmakuStart(roomId)
    // 握手期间可能已切走 / 关窗：本次订阅已被 stop() 撤掉，得把刚登记的会话还回去，否则没人收
    if (activeRoomId !== roomId) {
      if (ok)
        void window.mainAPI.danmakuStop(roomId)
      return
    }
    if (!ok) {
      debugLog('live', `B站弹幕: 房间 ${roomId} 握手失败，关闭弹幕层（不影响直播播放）`)
      stop()
      ElMessage.warning('B 站弹幕暂时连不上，不影响直播播放')
      return
    }
    debugLog('live', `B站弹幕: 房间 ${roomId} 已订阅`)
  }

  /** 房间号或开关变化时对齐订阅状态；两者都没变则不动，避免无谓重连 */
  function sync() {
    const roomId = options.enabled() ? options.roomId() : undefined
    if (roomId === activeRoomId)
      return
    stop()
    if (roomId !== undefined)
      void start(roomId)
  }

  watch(() => [options.roomId(), options.enabled()] as const, sync)
  // onScopeDispose 而非 onUnmounted：组件作用域与裸 effectScope 都能清理，便于直接单测
  onScopeDispose(stop)

  sync()

  return { danmakuItems }
}
