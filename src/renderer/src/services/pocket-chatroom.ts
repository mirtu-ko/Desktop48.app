/**
 * 口袋48直播聊天室会话（渲染侧接线）。
 *
 * 连接在主进程（main/pocket48/pocket-danmaku.ts，自研云信 TCP 协议客户端——
 * 口袋的云信应用封禁 Web 端登录，官方 Web SDK 必然 403）。
 * 渲染层只做：起/停会话订阅 + 把主进程推来的原始消息归一后上抛。
 *
 * 会话按聊天室 ID 在册管理（entries），与主进程「会话 + 订阅者」同构：
 * 同一聊天室的多个消费者（如直播页与浮窗同时播放同一场）共用一条连接，
 * 各自持独立订阅与 destroy，消息与状态 fan-out 给所有订阅者；
 * 最后一个订阅者离开才向主进程退订。同房间并发 connect 复用在途/活跃会话，
 * 避免快速开关、换场重订阅时出现双订阅（消息重复推送）与双 TCP 连接。
 *
 * 失败一律静默降级：连接不上只回调 status，不影响直播播放（与 B 站弹幕同一策略）。
 */
import type { PocketChatMessage } from '@renderer/utils/pocket-chat-message'
import { debugLog } from '@renderer/utils/debug'
import { normalizePocketChatMessage } from '@renderer/utils/pocket-chat-message'

export type PocketChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface PocketChatSessionOptions {
  /** 聊天室 ID（getLiveOne 详情的 chatroomId） */
  chatroomId: string
  /** 直播 ID：消息串扰过滤 + 日志 */
  liveId: string
  /** 归一后的消息回调 */
  onMessage: (message: PocketChatMessage) => void
  /** 连接状态回调；disconnected 为终态（初连失败不自动重试） */
  onStatus?: (status: PocketChatStatus, message?: string) => void
}

export interface PocketChatSession {
  destroy: () => void
}

/** 单个订阅者：一次 connectPocketChatroom 对应一个，destroy 只摘掉自己 */
interface ChatroomSubscriber {
  onMessage: (_message: PocketChatMessage) => void
  onStatus?: (_status: PocketChatStatus, _message?: string) => void
}

/**
 * 在册会话记录。
 * - starting：起会话在途标记，同房间并发 connect 只发一次 start；
 * - unsubscribe：每房一条的批次订阅，fan-out 给 subscribers；
 * - dead：墓碑——订阅者已清空但记录仍在册，唯一用途是让在途 start 回包时
 *   能区分「已被同房新会话顶替」（绝不能补退订，会杀死新会话）与
 *   「拆掉后无人重建」（必须补退订，否则主进程连接永驻）。
 */
interface ChatroomEntry {
  chatroomId: string
  liveId: string
  subscribers: Set<ChatroomSubscriber>
  starting: boolean
  unsubscribe: (() => void) | null
  dead: boolean
}

/** 按聊天室 ID 在册的会话；渲染进程内每个聊天室最多一条连接 */
const entries = new Map<string, ChatroomEntry>()

/** 摘掉一个订阅者；订阅者清空即转墓碑（退批次订阅 + 通知主进程退订） */
function removeSubscriber(entry: ChatroomEntry, subscriber: ChatroomSubscriber): void {
  entry.subscribers.delete(subscriber)
  if (entry.subscribers.size > 0 || entry.dead)
    return
  entry.dead = true
  entry.unsubscribe?.()
  entry.unsubscribe = null
  void window.mainAPI.pocketDanmakuStop(entry.chatroomId)
}

/** 起会话失败（未登录/凭据失效）：广播终态给所有订阅者并摘掉在册记录，之后可重连 */
function failEntry(entry: ChatroomEntry, message: string): void {
  for (const subscriber of [...entry.subscribers])
    subscriber.onStatus?.('disconnected', message)
  if (entries.get(entry.chatroomId) === entry)
    entries.delete(entry.chatroomId)
  entry.unsubscribe?.()
  entry.unsubscribe = null
}

/**
 * 起会话（在途/已建由 entry.starting 收敛，同房间只发一次 start）。
 * 回包时若已转墓碑且无人顶替（entries 里仍是自己）：补一次退订才收得回连接
 * （与 B 站弹幕同款竞态）；已被新会话顶替则绝不能补——那会杀死新会话。
 */
async function startEntry(entry: ChatroomEntry): Promise<void> {
  try {
    const ok = await window.mainAPI.pocketDanmakuStart(entry.chatroomId, entry.liveId)
    entry.starting = false
    if (entries.get(entry.chatroomId) !== entry)
      return
    if (!ok) {
      failEntry(entry, '未登录或登录已过期，无法接收互动消息')
      return
    }
    if (entry.dead)
      void window.mainAPI.pocketDanmakuStop(entry.chatroomId)
  }
  catch (error) {
    entry.starting = false
    if (entries.get(entry.chatroomId) !== entry)
      return
    failEntry(entry, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 建立聊天室会话（订阅）。任何一步失败都走 onStatus('disconnected')，
 * 不抛错 —— 调用方无需 try/catch，弹幕失败不该打扰直播播放。
 * 同房间已有活跃/在途会话时直接复用（fan-out 给新订阅者，不重连、不双订阅）。
 */
export function connectPocketChatroom(options: PocketChatSessionOptions): PocketChatSession {
  let entry = entries.get(options.chatroomId)
  // 墓碑不复用：顶替在册记录，重起一条新会话（主进程侧按 chatroomId 去重，不会双连接）
  if (!entry || entry.dead) {
    entry = {
      chatroomId: options.chatroomId,
      liveId: options.liveId,
      subscribers: new Set(),
      starting: false,
      unsubscribe: null,
      dead: false,
    }
    entries.set(options.chatroomId, entry)
  }

  const subscriber: ChatroomSubscriber = {
    onMessage: options.onMessage,
    onStatus: options.onStatus,
  }
  entry.subscribers.add(subscriber)

  // 每房一条批次订阅：先订阅再起会话，免得起会话初期到达的状态/消息被丢掉
  if (!entry.unsubscribe) {
    const current = entry
    current.unsubscribe = window.mainAPI.pocketDanmakuBatch((batch) => {
      if (batch.chatroomId !== current.chatroomId)
        return
      if (batch.kind === 'status') {
        for (const subscriber of [...current.subscribers])
          subscriber.onStatus?.(batch.status ?? 'connecting', batch.message)
        return
      }
      for (const raw of batch.items ?? []) {
        // 归一只做一次（同房间 liveId 一致，结果相同），再 fan-out
        const normalized = normalizePocketChatMessage(raw as unknown as Record<string, unknown>, current.liveId)
        if (!normalized) {
          if (import.meta.env.DEV)
            debugLog('live', '口袋弹幕: 归一丢弃', raw)
          continue
        }
        for (const subscriber of [...current.subscribers])
          subscriber.onMessage(normalized)
      }
      if (import.meta.env.DEV)
        debugLog('live', `口袋弹幕: 批次 ${batch.items?.length ?? 0} 条 → ${current.subscribers.size} 个订阅者`)
    })
  }

  // 起会话在途/已建都不重复发 start；失败由 startEntry 广播终态
  if (!entry.starting) {
    entry.starting = true
    void startEntry(entry)
  }

  return {
    destroy: () => removeSubscriber(entry!, subscriber),
  }
}

/** 退订本渲染进程某聊天室的全部订阅者（最后一个离开时停主进程会话）；无在册会话时 no-op */
export function disconnectPocketChatroom(chatroomId: string): void {
  const entry = entries.get(chatroomId)
  if (!entry || entry.dead)
    return
  // 拷贝后再遍历：removeSubscriber 会改 subscribers
  for (const subscriber of [...entry.subscribers])
    removeSubscriber(entry, subscriber)
}
