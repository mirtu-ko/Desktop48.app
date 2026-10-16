/**
 * ⚠️ 全局单例（模块作用域缓存，不随任何组件卸载而销毁）
 *
 * 成员名录：starInfo + allmembers 合并后的成员详情（规则见 utils/member-merge.ts），按 userId 反查。
 * 直播 / 回放列表的条目只带 userId 与口袋昵称，点成员名开详情抽屉时抽屉要的是完整
 * MemberDetail（生日 / 写真 / 排名 / 经历…），故在这里合并一次并缓存。
 *
 * 同一份快照里另建一张官方账号索引（officialInfo）：官方号（袋王 / 各团官方号）字段与
 * 成员记录同构但**不是成员**，混进成员索引会被选举页 / 详情抽屉当成员渲染。它是房间页
 * 左列解析「用户关注的官方频道」时的取名与头像来源（见 findOfficialAccount）。
 *
 * 缓存的是请求 Promise：并发反查共享同一次请求；失败不留坏缓存。
 * members-updated 时只作废缓存，下一次反查才拉：不为未打开的抽屉发请求，也确保读到最新树。
 *
 * 不构造兼任记录（buildAdjuncts）：同一 userId 的兼任档案与本人档案详情字段一致，
 * 按 userId 反查只会互相覆盖；队伍归属是成员页卡片的事。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import EventBus from '@renderer/services/event-bus'
import { mergeMembers } from '@renderer/utils/member-merge'
import Tools from '@renderer/utils/tools'
import { useMemberTreeStore } from './member-tree'

/** userId → 详情：反查走 Map，不必每次线性扫全量名录 */
type DirectoryIndex = Map<number, MemberDetail>

/** 官方账号（officialInfo）：房间左列取名与头像用的轻量档案，字段不按成员建模 */
export interface OfficialAccount {
  userId: number
  /** 显示名（realName 优先，退 nickname） */
  name: string
  /** 已归一化为可直接 <img src> 的地址（原始值可能是 /mediasource/... 相对路径） */
  avatar: string
}

/** 一次请求拉到的目录快照：成员索引 + 官方账号索引 */
interface DirectorySnapshot {
  members: DirectoryIndex
  officials: Map<number, OfficialAccount>
}

let cache: Promise<DirectorySnapshot> | null = null

async function fetchIndex(): Promise<DirectorySnapshot> {
  try {
    const { loadTree } = useMemberTreeStore()
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    const [tree, payload] = await Promise.all([loadTree(), window.mainAPI.getAllMembers()])
    const members: DirectoryIndex = new Map()
    for (const member of mergeMembers(tree, payload?.allmembers)) {
      if (member.userId !== undefined)
        members.set(member.userId, member)
    }
    const officials = new Map<number, OfficialAccount>()
    for (const item of payload?.officials ?? []) {
      const userId = Tools.normalizeUserId(item?.userId)
      // 脏 userId 直接丢弃：宁可不显示，也不要挂到一个错误的账号上
      if (!Number.isFinite(userId))
        continue
      officials.set(userId, {
        userId,
        name: String(item.realName || item.nickname || ''),
        avatar: Tools.sourceUrl(String(item.avatar || '')),
      })
    }
    return { members, officials }
  }
  catch (error) {
    cache = null // 失败不留坏缓存，下次反查可重试
    throw error
  }
}

/** 按 userId 取成员详情；查不到返回 null（名录里没这个人：成员库未同步 / 官网独有的成员） */
async function findMemberByUserId(userId: number | string | undefined | null): Promise<MemberDetail | null> {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id))
    return null
  cache ??= fetchIndex()
  return (await cache).members.get(id) ?? null
}

/**
 * 按 userId 取官方账号（officialInfo）；查不到返回 null。
 * 只服务房间左列：成员名录查不到时回退到这里，官方频道才能显示真名与头像。
 */
async function findOfficialAccount(userId: number | string | undefined | null): Promise<OfficialAccount | null> {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id))
    return null
  cache ??= fetchIndex()
  return (await cache).officials.get(id) ?? null
}

let subscribed = false

/** 订阅一次：数据变更只作废缓存，下一次反查自然重拉 */
function ensureSubscribed() {
  if (subscribed)
    return
  subscribed = true
  EventBus.on('members-updated', () => {
    cache = null
  })
}

export function useMemberDirectoryStore() {
  ensureSubscribed()
  return { findMemberByUserId, findOfficialAccount }
}
