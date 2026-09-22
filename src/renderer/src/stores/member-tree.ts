/**
 * ⚠️ 全局单例 store（模块作用域共享，不随任何组件卸载而销毁）
 *
 * ⚠️ 与 main/domain/member-tree.ts **同名但不同层**：那份是主进程的纯函数建树规则
 * （buildMemberTree，无状态、无 IO，可脱离 Electron 直接单测）；本文件是渲染端的
 * 共享状态单例（请求缓存 + 失效订阅），不参与建树。两者不可合并：渲染端 bundle
 * 无法引主进程模块，跨进程的类型只能声明在 preload/ipc-contract.d.ts。
 *
 * 成员树是主进程的**内存派生数据**（不落盘，见 main/database.ts 的 rebuildMemberTree），
 *
 * 作为全局唯一数据源：
 * - 读：消费方 `await loadTree()`，并发调用共享同一次请求；
 * - 写：数据库更新（services/apis.ts 的 syncInfo 落库后广播 members-updated）时
 *   由本文件作废缓存并立刻重拉 —— 订阅收在这里，消费方不必各自监听事件。
 */
import type { MemberTreeGroupPayload } from '../../../preload/ipc-contract'
import EventBus from '@renderer/services/event-bus'
import { ref } from 'vue'

/** 成员树（团体 → 队伍 → 成员）：唯一数据源，成员页与回放页读的是同一份 */
const memberTree = ref<MemberTreeGroupPayload[]>([])

/**
 * 缓存的是**请求 Promise** 而不是结果数组，两点都是必需的：
 * 1. 并发调用（两页相继挂载）只发一次请求；
 * 2. 「作废后立刻重拉」与「紧接着的读方」共享同一次飞行中的请求 ——
 *    成员同步成功后回放页马上读树时，拿到的必须重新拉过的新快照，而不是失效前的旧值。
 */
let cache: Promise<MemberTreeGroupPayload[]> | null = null

async function fetchTree(): Promise<MemberTreeGroupPayload[]> {
  try {
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts
    memberTree.value = (await window.mainAPI.getMemberTree()) || []
    return memberTree.value
  }
  catch (error) {
    cache = null // 失败不留坏缓存，下次调用可重试
    throw error
  }
}

/**
 * 取成员树：缓存未失效就直接复用，否则拉取一次
 * @param force 数据已变更时强制重拉（由内部事件调用，页面一般不用传）
 */
function loadTree(force = false): Promise<MemberTreeGroupPayload[]> {
  if (force)
    cache = null
  cache ??= fetchTree()
  return cache
}

let subscribed = false

/** 订阅一次：数据库变更后作废缓存并立刻重拉，被 keep-alive 缓存的页面也随之拿到新树 */
function ensureSubscribed() {
  if (subscribed)
    return
  subscribed = true
  EventBus.on('members-updated', () => {
    // 静默重拉：这里没有发起者承接错误，失败只记录；读方下一次 loadTree 仍会重试
    void loadTree(true).catch((error) => {
      console.error('[member-tree]成员树重载失败:', error)
    })
  })
}

export function useMemberTreeStore() {
  ensureSubscribed()
  return { memberTree, loadTree }
}
