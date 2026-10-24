/**
 * 直播结束复盘（live/result）：主播下播后浮窗结束卡的数据源——
 * 总观看 / 本场时长 / 礼河流水 / 榜单前三（与 LIVEUPDATE 榜单同构，头像等级贡献值可直接复用）。
 *
 * 数据经主进程带 token 的 pocketGetLiveResult 取回（渲染层直连缺 token 会 400）。
 *
 * ⚠️ 字段类型以实测报文为准：liveTime / totalMoney / liveId 等都是**字符串**数字，
 * 官方 bean 声明的 long/int 不可信，统一宽松解析（非数字按 0）。
 */
import { debugLog } from '@renderer/utils/debug'

/** 榜单条目里的用户（LIVEUPDATE topList 同款结构） */
export interface LiveResultUser {
  userId: string
  userName: string
  /** 头像（服务端相对路径，渲染时经 Tools.sourceUrl 归一） */
  userAvatar: string
  level: number
}

export interface LiveResultTopUser {
  user: LiveResultUser
  /** 该用户本场贡献（礼物值） */
  money: number
}

export interface LiveResultView {
  liveId: string
  /** 本场时长（毫秒） */
  liveTime: number
  /** 总观看（本场累计，下播时即终值） */
  liveOnline: number
  /** 总礼物流水 */
  totalMoney: number
  /** 主播名 */
  userName: string
  /** 榜单前三 */
  topUsers: LiveResultTopUser[]
}

/** 宽松计数：数字 / 数字字符串都认，负数与非数字按 0 */
function toCount(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
}

function toTopUser(raw: unknown): LiveResultTopUser | null {
  if (!raw || typeof raw !== 'object')
    return null
  const item = raw as Record<string, unknown>
  const user = (item.user && typeof item.user === 'object' ? item.user : {}) as Record<string, unknown>
  const userName = toText(user.userName)
  // 没有昵称的条目没有展示价值，整条丢弃
  if (!userName)
    return null
  return {
    user: {
      userId: toText(user.userId),
      userName,
      userAvatar: toText(user.userAvatar),
      level: toCount(user.level),
    },
    money: toCount(item.money),
  }
}

/** 把上游 content 归一问复盘视图；字段缺失按 0 / 空串，绝不抛错（结束卡要有降级展示） */
export function normalizeLiveResult(liveId: string, raw: Record<string, unknown>): LiveResultView {
  const list = Array.isArray(raw.topUserList) ? raw.topUserList : []
  return {
    liveId: toText(raw.liveId) || liveId,
    liveTime: toCount(raw.liveTime),
    liveOnline: toCount(raw.liveOnline),
    totalMoney: toCount(raw.totalMoney),
    userName: toText(raw.userName),
    topUsers: list.map(toTopUser).filter((item): item is LiveResultTopUser => item !== null),
  }
}

/** 拉复盘并归一；异常原样上抛（未登录 / 接口失败由调用方降级简版结束卡） */
export async function loadLiveResult(liveId: string): Promise<LiveResultView> {
  const raw = await window.mainAPI.pocketGetLiveResult(liveId)
  const view = normalizeLiveResult(liveId, raw || {})
  debugLog('live', `复盘: liveOnline=${view.liveOnline} liveTime=${view.liveTime} topUsers=${view.topUsers.length}`)
  return view
}
