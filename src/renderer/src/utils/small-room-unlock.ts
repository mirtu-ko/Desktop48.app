/**
 * 小房间暗号的解锁态（模块级单例，按 channelId 记「本进程已验过」）。
 *
 * 状态必须放模块作用域，不能挂在 usePocketRooms() 里：那份状态跟着 Rooms.vue 实例走，
 * 而 App.vue 捕获到渲染错误时会 pageLayerKey += 1 重建整棵 <KeepAlive>（页面自己刷新一下），
 * 实例重挂载 = 解锁表清零，用户刚输过的暗号白输。
 *
 * 只活到进程结束、刻意不落盘：与既定策略「重启应用后重新校验一次」一致，
 * 免得把门禁权限写进 userData。
 *
 * 换账号 / 退出必须 clearSmallRoomUnlocks()（唯一调用方 stores/pocket-auth.ts）：
 * channelId 跨账号稳定，留着等于把上一个账号的门禁权限直接交给新账号
 * ——小房间消息列表接口本身不带暗号，渲染层这道锁是唯一防线。
 */
import { reactive } from 'vue'

/** 本进程内已验证通过暗号的频道（channelId）。必须是 reactive 集合：判定式 computed 靠 has() 收集依赖，裸 Set 增删不触发重算 */
const unlockedChannels = reactive(new Set<string>())

/** 该频道是否已解锁（在 computed 里调用可建立响应依赖） */
export function isSmallRoomUnlocked(channelId: string): boolean {
  return unlockedChannels.has(channelId)
}

/** 记一次解锁：只在服务端（或万能密码）校验通过后调用 */
export function markSmallRoomUnlocked(channelId: string): void {
  unlockedChannels.add(channelId)
}

/** 作废全部解锁态：账号变化时由登录态 store 调用 */
export function clearSmallRoomUnlocks(): void {
  unlockedChannels.clear()
}
