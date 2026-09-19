/**
 * ⚠️ 全局单例（模块作用域缓存，不随任何组件卸载而销毁）
 *
 * 成员名录：starInfo + allmembers 合并后的成员详情（规则见 utils/member-merge.ts），按 userId 反查。
 * 直播 / 回放列表的条目只带 userId 与口袋昵称，点成员名开详情抽屉时抽屉要的是完整
 * MemberDetail（生日 / 写真 / 排名 / 经历…），故在这里合并一次并缓存。
 *
 * 缓存的是请求 Promise：并发反查共享同一次请求；失败不留坏缓存。
 * members-updated（成员同步落库）时只**作废**、不立刻重拉 —— 下一次反查才拉。
 * 既不为没人看的抽屉白跑请求，也避开与 stores/member-tree 的监听顺序耦合：
 * 立刻重拉会在 member-tree 作废之前读走旧树，名录里就少了刚同步进来的新成员。
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

let cache: Promise<DirectoryIndex> | null = null

async function fetchIndex(): Promise<DirectoryIndex> {
  try {
    const { loadTree } = useMemberTreeStore()
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    const [tree, payload] = await Promise.all([loadTree(), window.mainAPI.getAllMembers()])
    const index: DirectoryIndex = new Map()
    for (const member of mergeMembers(tree, payload?.allmembers)) {
      if (member.userId !== undefined)
        index.set(member.userId, member)
    }
    return index
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
  return (await cache).get(id) ?? null
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
  return { findMemberByUserId }
}
