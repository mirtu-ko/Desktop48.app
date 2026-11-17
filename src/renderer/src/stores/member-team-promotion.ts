/**
 * 预备生的本地升格（模块级单例）：粉丝的个人配置，归属由主进程按登录凭证判定。
 *
 * 渲染层只持有「当前账号的升格」：登录 / 退出 / 换号自动重载，永不接触 ownerId。
 * 展示方调 displayTeamOf 派生展示队伍；成员官方升格后（不再是预备生）本地升格自动失效。
 */
import type { MemberTeamPromotion } from '@common/member-team-promotion'
import type { EffectScope } from 'vue'
import { resolveMemberTeam } from '@renderer/utils/member-team-promotion'
import Tools from '@renderer/utils/tools'
import { effectScope, ref, watch } from 'vue'
import { pocketAuthState } from './pocket-auth'

/** 带 code 的错误：调用方按类型提示，不靠 message 字符串猜 */
export class MemberTeamPromotionError extends Error {
  constructor(
    public code: 'not-logged-in' | 'invalid-user',
    message: string,
  ) {
    super(message)
    this.name = 'MemberTeamPromotionError'
  }
}

const promotions = ref<MemberTeamPromotion[]>([])

let loadedKey = ''
let inflightKey = ''
let inflight: Promise<void> | null = null
let watchScope: EffectScope | null = null

/** 账号身份指纹：只用于判断「要不要重拉」，真正的归属判定在主进程 */
function identityKey(): string {
  const state = pocketAuthState.value
  return `${state.loggedIn}|${state.userId}|${state.mobileMasked}`
}

async function refresh(key: string) {
  const list = await window.mainAPI.getMemberTeamPromotions()
  if (key !== identityKey())
    return
  // 本地升格是登录用户的个人配置：未登录时一律不展示，不依赖主进程返回
  promotions.value = pocketAuthState.value.loggedIn ? (list || []) : []
  loadedKey = key
}

/** 按当前身份重拉；同一身份的并发调用共用同一次请求，身份变了旧结果直接丢弃 */
function reload(): Promise<void> {
  const key = identityKey()
  if (inflight && inflightKey === key)
    return inflight
  inflightKey = key
  inflight = refresh(key)
    .catch((error) => {
      console.error('[member-team-promotion]读取失败:', error)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 幂等首灌：失败不置位，下次调用仍会重试 */
function ensureLoaded(): Promise<void> {
  return loadedKey === identityKey() ? Promise.resolve() : reload()
}

/**
 * 账号一变就重拉：先清空再拉，换号 / 退出后不会短暂显示上一个账号的升格。
 *
 * 必须挂在自己的 detach scope 上：store 常在某个组件的 setup 里首次被调用，
 * 普通 watch 会登记进那个组件的 scope，组件一卸载订阅就停，之后再也不会重载。
 */
function ensureIdentityWatch() {
  if (watchScope)
    return
  watchScope = effectScope(true)
  watchScope.run(() => {
    watch(identityKey, () => {
      promotions.value = []
      void reload()
    })
  })
}

/** 取当前账号对某成员的升格 */
function promotionOf(userId: number | string | undefined | null): MemberTeamPromotion | null {
  const id = Tools.normalizeUserId(userId)
  if (!Number.isFinite(id))
    return null
  return promotions.value.find(item => Number(item.userId) === id) ?? null
}

/** 展示用队伍：仍是预备生且有本地升格时覆盖，否则原样返回服务端队伍 */
function displayTeamOf(
  userId: number | string | undefined | null,
  teamName: string | undefined,
  teamColor: string | undefined,
): { teamName: string, teamColor: string } {
  return resolveMemberTeam({ teamName, teamColor }, promotionOf(userId))
}

/** 写入 / 覆盖升格；未登录直接拒绝，失败抛出由调用方提示 */
async function setPromotion(promotion: MemberTeamPromotion): Promise<void> {
  if (!pocketAuthState.value.loggedIn)
    throw new MemberTeamPromotionError('not-logged-in', '登录口袋账号后才能设置升格')
  const id = Tools.normalizeUserId(promotion.userId)
  if (!Number.isFinite(id))
    throw new MemberTeamPromotionError('invalid-user', `无效的成员 userId：${String(promotion.userId)}`)
  const next = { ...promotion, userId: id }
  await window.mainAPI.setMemberTeamPromotion(next)
  promotions.value = [...promotions.value.filter(item => Number(item.userId) !== id), next]
}

/** 取消升格：只删当前账号的记录 */
async function clearPromotion(userId: number | string): Promise<void> {
  const id = Tools.normalizeUserId(userId)
  if (!pocketAuthState.value.loggedIn || !Number.isFinite(id))
    return
  await window.mainAPI.removeMemberTeamPromotion(id)
  promotions.value = promotions.value.filter(item => Number(item.userId) !== id)
}

export function useMemberTeamPromotionStore() {
  ensureIdentityWatch()
  return { ensureLoaded, promotionOf, displayTeamOf, setPromotion, clearPromotion }
}
