/**
 * 口袋48直播聊天室会话（渲染侧接线）。
 *
 * 连接在主进程（main/pocket48/pocket-danmaku.ts，自研云信 TCP 协议客户端——
 * 口袋的云信应用封禁 Web 端登录，官方 Web SDK 必然 403）。
 * 渲染层只做：起/停会话订阅 + 把主进程推来的原始消息归一后上抛。
 *
 * 会话按聊天室 ID 在册管理（entries）：同房间的重复 connect 复用在途/活跃会话，
 * 避免快速开关弹幕、换场重订阅时出现双订阅（消息重复推送）。
 * destroy 幂等，且仅当自己仍是该房间在册会话时才向主进程发退订——
 * 被同房间新一代会话顶替后，主进程侧连接归新会话所有，误停会杀死新会话。
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

/**
 * 在册会话记录。destroyed 用于识别「起会话在途时就被销毁」的情况：
 * 此时 destroy 发出的退订可能早于主进程登记会话（凭据获取是异步的），
 * 起会话回包后需要补一次退订，否则主进程侧连接永驻。
 */
interface ChatroomEntry {
  session: PocketChatSession
  destroyed: boolean
}

/** 按聊天室 ID 在册的会话；渲染进程内每个聊天室最多一条订阅 */
const entries = new Map<string, ChatroomEntry>()

/** 断开某聊天室的渲染侧会话（在途/已建均可）；无在册会话时 no-op */
export function disconnectPocketChatroom(chatroomId: string): void {
  entries.get(chatroomId)?.session.destroy()
}

/**
 * 建立聊天室会话。任何一步失败都走 onStatus('disconnected')，
 * 不抛错 —— 调用方无需 try/catch，弹幕失败不该打扰直播播放。
 * 同房间已有活跃/在途会话时直接复用（不重连、不双订阅）。
 */
export async function connectPocketChatroom(options: PocketChatSessionOptions): Promise<PocketChatSession> {
  const existing = entries.get(options.chatroomId)
  if (existing && !existing.destroyed)
    return existing.session

  let active = true

  /** 诊断用计数：主进程推来多少条 / 归一后存活多少条，两个数差多少就丢在哪 */
  let rawCount = 0
  let normalizedCount = 0

  // 先订阅再起会话，免得起会话初期到达的状态/消息被丢掉
  const unsubscribe = window.mainAPI.pocketDanmakuBatch((batch) => {
    if (!active || batch.chatroomId !== options.chatroomId)
      return
    if (batch.kind === 'status') {
      options.onStatus?.(batch.status ?? 'connecting', batch.message)
      return
    }
    for (const raw of batch.items ?? []) {
      rawCount++
      const normalized = normalizePocketChatMessage(raw as unknown as Record<string, unknown>, options.liveId)
      if (normalized) {
        normalizedCount++
        options.onMessage(normalized)
      }
      else if (import.meta.env.DEV && rawCount <= 5) {
        debugLog('live', `口袋弹幕: 归一丢弃第 ${rawCount} 条`, raw)
      }
    }
    if (import.meta.env.DEV)
      debugLog('live', `口袋弹幕: 批次 ${batch.items?.length ?? 0} 条（累计原始 ${rawCount}，归一存活 ${normalizedCount}）`)
  })

  const entry: ChatroomEntry = { session: null as unknown as PocketChatSession, destroyed: false }
  const session: PocketChatSession = {
    destroy: () => {
      if (!active)
        return
      active = false
      entry.destroyed = true
      unsubscribe()
      // 仅当自己仍是该房间在册会话时才退订：被新一代顶替后连接归新会话所有，误停会杀死新会话。
      // 刻意不从此处删除在册记录——「起会话在途时被销毁」的后置补退订要靠在册状态判断
      if (entries.get(options.chatroomId) === entry)
        void window.mainAPI.pocketDanmakuStop(options.chatroomId)
    },
  }
  entry.session = session
  entries.set(options.chatroomId, entry)

  try {
    const ok = await window.mainAPI.pocketDanmakuStart(options.chatroomId, options.liveId)
    if (!active) {
      // 等待起会话期间已被销毁（快速开关/换场）：destroy 发出的退订可能早于主进程
      // 登记会话（凭据获取是异步的，与 B 站弹幕同款竞态），补一次退订收回连接。
      // 已被同房间新一代顶替则绝不能补——那会杀死新会话
      if (entries.get(options.chatroomId) === entry)
        void window.mainAPI.pocketDanmakuStop(options.chatroomId)
      return session
    }
    if (!ok) {
      options.onStatus?.('disconnected', '未登录或登录已过期，无法接收互动消息')
      session.destroy()
    }
  }
  catch (error) {
    if (!active) {
      if (entries.get(options.chatroomId) === entry)
        void window.mainAPI.pocketDanmakuStop(options.chatroomId)
      return session
    }
    options.onStatus?.('disconnected', error instanceof Error ? error.message : String(error))
    session.destroy()
  }
  return session
}
