import type { PocketDisableNotice, PocketRankUser } from '@renderer/utils/pocket-chat-message'
import { useLiveDanmakuOverlay } from '@renderer/composables/use-danmaku-overlay'
import { connectPocketChatroom, disconnectPocketChatroom } from '@renderer/services/pocket-chatroom'
import { ensurePocketAuthState, pocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'
import { useIntervalFn } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import { onScopeDispose, watch } from 'vue'

/** 气泡回收节拍：展示时长是秒级，250ms 足够跟手 */
const OVERLAY_TICK_MS = 250

/**
 * 直播弹幕：订阅主进程下发的 B 站弹幕与口袋48聊天室消息，统一投放到左下角气泡层。
 * 不做延迟补偿 —— 48 官方源的画面比 B 站的弹幕推送更早，弹幕到手即投放才是对齐的。
 * 失败一律静默降级：连不上只提示一次，不干扰直播播放。
 */
export function useLiveDanmaku(options: {
  /** B 站房间号；undefined 表示该直播没有对应房间（个人直播），不订阅 */
  roomId: () => number | undefined
  /** 直播 ID（非聊天室 ID）：口袋消息扩展里的 liveId 串扰过滤要用真值 */
  liveId?: () => string
  /** 口袋聊天室 ID（getLiveOne 详情）；undefined/空串表示无口袋弹幕源（未登录 / 公演 / 回放） */
  pocketRoomId?: () => string | undefined
  /** 是否开启弹幕 */
  enabled: () => boolean
  /** 互动榜单更新（LIVEUPDATE 消息）：路由到右上角榜单面板，不进气泡层；空数组 = 清空 */
  onRank?: (users: PocketRankUser[]) => void
  /** LIVEUPDATE 实时字段（在线人数 / 累计礼物流水）：与榜单同报文，可独立于榜单变化 */
  onLiveUpdate?: (update: { online?: number, allMoney?: number }) => void
  /** 被禁言/拉黑（DISABLE_SPEAK）：宿主门控后按 op 动作（禁言重取详情 / 拉黑关播） */
  onDisableSpeak?: (notice: PocketDisableNotice) => void
  /** 主播下播（CLOSELIVE）：宿主立即关播（官方同构），不进气泡层 */
  onLiveEnd?: () => void
  /** 连麦/PK 换流信号（INFORM_PULL_STREAM）：宿主拉详情重建流，不进气泡层 */
  onLiveRestream?: () => void
}) {
  const { items: danmakuItems, push, tick, reset } = useLiveDanmakuOverlay()

  /** 会话起点（毫秒）：把墙钟折成引擎认得的秒数轴 */
  let originMs = 0
  /** 当前已订阅的房间号；undefined = 未订阅 */
  let activeRoomId: number | undefined
  /** 当前已连接的口袋聊天室 ID；空串 = 未连接 */
  let activePocketRoomId = ''
  let unsubscribe: (() => void) | null = null
  // 口袋会话的生命周期归 service 层按聊天室在册管理（connect/disconnect 配对），
  // 这里不持会话句柄——曾因持句柄 + 异步建立竞态出现双订阅与永驻连接
  /** 累计收到条数：与主进程的同名计数对照，两个数不一致就说明丢在 IPC 或房间过滤上 */
  let receivedCount = 0
  let pocketReceivedCount = 0

  const nowSeconds = () => (originMs === 0 ? 0 : (Date.now() - originMs) / 1000)

  const { pause: pauseOverlay, resume: resumeOverlay } = useIntervalFn(
    () => tick(nowSeconds()),
    OVERLAY_TICK_MS,
    { immediate: false },
  )

  /** 口袋弹幕的降级提示只弹一次：重连是常态，反复打扰没有信息量 */
  let pocketWarned = false

  function stopPocket() {
    // 按当前房间断开：在途/已建会话都由 service 层在册管理，destroy 幂等
    if (activePocketRoomId)
      disconnectPocketChatroom(activePocketRoomId)
    activePocketRoomId = ''
    pocketReceivedCount = 0
    // 重新起会话时重置提示：用户手动重开值得再被告知一次
    pocketWarned = false
    // 榜单跟着口袋会话走：会话停了榜单面板清空，避免换场显示上一场的榜单
    options.onRank?.([])
  }

  function startPocket(roomId: string) {
    // 未登录不开口袋弹幕：IM 凭据接口在主进程必失败，先省一次无谓往返
    if (!ensurePocketAuthState().loggedIn)
      return
    stopPocket()
    activePocketRoomId = roomId
    pocketReceivedCount = 0
    // 同房间重建由 service 层复用在册会话（fan-out，不双订阅）；失败只走 onStatus，不抛错
    connectPocketChatroom({
      chatroomId: roomId,
      // 串扰过滤锚点必须是真 liveId：传聊天室 ID 会和消息扩展里的 liveId 比对失败，整条流被丢光
      liveId: options.liveId?.() || '',
      onStatus: (status, message) => {
        if (import.meta.env.DEV)
          debugLog('live', `口袋弹幕: ${status}`, message || '')
        if (status === 'disconnected' && !pocketWarned && pocketReceivedCount === 0) {
          pocketWarned = true
          ElMessage.warning('口袋互动消息暂时连不上，不影响直播播放')
        }
      },
      onMessage: (message) => {
        // 榜单消息单独路由：右上角榜单面板，不进气泡层。
        // 实时字段与榜单同报文但可独立变化：无榜单时也要下发在线人数
        if (message.kind === 'rank') {
          if (message.rankUsers?.length)
            options.onRank?.(message.rankUsers)
          if (message.liveOnline !== undefined || message.liveAllMoney !== undefined)
            options.onLiveUpdate?.({ online: message.liveOnline, allMoney: message.liveAllMoney })
          return
        }
        // 禁言/拉黑：宿主门控后提示并按 op 动作，气泡层不展示
        if (message.kind === 'system' && message.disableSpeak) {
          options.onDisableSpeak?.(message.disableSpeak)
          return
        }
        // 下播 / 换流信号：宿主关播或重建流，气泡层不展示
        if (message.kind === 'system' && (message.liveEnd || message.liveRestream)) {
          if (message.liveEnd)
            options.onLiveEnd?.()
          else
            options.onLiveRestream?.()
          return
        }
        pocketReceivedCount++
        if (import.meta.env.DEV)
          debugLog('live', `口袋弹幕: 投放 #${pocketReceivedCount} [${message.kind}] Lv${message.level ?? '?'} ${message.nick}: ${message.text}`)
        // 所有互动消息统一「作者前缀 + 动作正文」款式；礼物/系统的作者名按类型着色，等级随作者名显示
        push(message.text, message.nick, nowSeconds(), {
          tone: message.kind === 'gift' ? 'gift' : message.kind === 'system' ? 'system' : undefined,
          level: message.level,
        })
      },
    })
  }

  function stop() {
    pauseOverlay()
    unsubscribe?.()
    unsubscribe = null
    stopPocket()
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
      if (batch.roomId !== activeRoomId) {
        if (import.meta.env.DEV)
          debugLog('live', `B站弹幕: 丢弃批次 roomId=${batch.roomId}（当前 activeRoomId=${activeRoomId}，换场残留）`)
        return
      }
      receivedCount += batch.items.length
      // 可见数取自上一次节拍：push 只入队，所以它反映的是「实际挂在层上的条数」。
      // 热路径，先看门控再拼字符串
      if (import.meta.env.DEV) {
        debugLog(
          'live',
          `B站弹幕: 收到 ${batch.items.length} 条（累计 ${receivedCount}，可见 ${danmakuItems.value.length}）`,
          batch.items.map(item => `${item.username}: ${item.text}${item.emots ? ` [emots×${Object.keys(item.emots).length}]` : ''}`),
        )
      }
      // 整批共用同一投放时刻（批内先后由 push 顺序保证），下一个节拍一起投放
      const showAt = nowSeconds()
      for (const item of batch.items)
        push(item.text, item.username, showAt, { emots: item.emots })
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
    const enabled = options.enabled()
    const roomId = enabled ? options.roomId() : undefined
    if (roomId !== activeRoomId) {
      // stop() 会一并清掉口袋会话与气泡层（换场语义）；下方 pocket 分支随后重建
      stop()
      if (roomId !== undefined)
        void start(roomId)
    }
    // 口袋弹幕源独立对齐：B 站源缺失（个人直播）时口袋会话仍要建立，故不并入 stop()。
    // 登录态是前置条件：未登录不起会话；退出登录时停掉旧会话（watch 里 loggedIn 变化触发）
    const pocketRoomId = enabled && pocketAuthState.value.loggedIn ? (options.pocketRoomId?.() || '') : ''
    if (pocketRoomId !== activePocketRoomId) {
      stopPocket()
      if (pocketRoomId)
        startPocket(pocketRoomId)
    }
    // 气泡层时钟与节拍跟着「任一弹幕源是否活跃」走，不能只跟 B 站源：
    // 个人直播没有 B 站房间，start() 不会执行——此前 tick 一直暂停、originMs 恒 0，
    // 口袋消息全部堆在 pending 队列里永不上屏（表现为「已连接但看不到气泡」）
    if (roomId !== undefined || pocketRoomId) {
      if (originMs === 0)
        originMs = Date.now()
      resumeOverlay()
    }
    else {
      pauseOverlay()
      reset()
    }
  }

  watch(
    () => [options.roomId(), options.pocketRoomId?.() || '', options.enabled(), pocketAuthState.value.loggedIn] as const,
    sync,
  )
  // onScopeDispose 而非 onUnmounted：组件作用域与裸 effectScope 都能清理，便于直接单测
  onScopeDispose(stop)

  sync()

  return { danmakuItems }
}
