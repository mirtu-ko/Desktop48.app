import { checkInPocket, pocketAuthErrorMessage } from '@renderer/stores/pocket-auth'
import { ref } from 'vue'
import { trackEvent } from '../utils/umami'

/**
 * 口袋48账号签到。
 *
 * 奖励文案以服务端为准：重复签到由服务端判重，本模块只负责防连点、
 * 把结果拼成一句可读提示并上报一条 Umami 事件（不含任何账号信息）。
 *
 * 错误文案必须经 pocketAuthErrorMessage 转写：IPC 拒绝会把主进程的错误包成
 * `Error invoking remote method 'pocketCheckIn': Error: 今日已领取，明天再来`，
 * 直接取 error.message 会把这串包装原样甩给用户（曾因此在设置页回归过一次）。
 */
export function usePocketCheckIn() {
  const checkingIn = ref(false)

  /** 执行签到；成功返回奖励文案，失败返回已转写的可读提示 */
  async function checkIn(): Promise<{ ok: boolean, message: string }> {
    if (checkingIn.value)
      return { ok: false, message: '' }
    checkingIn.value = true
    try {
      const result = await checkInPocket()
      trackEvent('pocket:checkin', { result: 'ok' })
      const rewards = [`成长值 +${result.addExp}`, `鸡翅 +${result.addSupport}`]
      if (result.addMoney > 0)
        rewards.push(`鸡腿 +${result.addMoney}`)
      const days = result.days > 0 ? `，累计签到 ${result.days} 天` : ''
      return { ok: true, message: `签到成功：${rewards.join('，')}${days}` }
    }
    catch (error) {
      trackEvent('pocket:checkin', { result: 'fail' })
      return { ok: false, message: pocketAuthErrorMessage(error) }
    }
    finally {
      checkingIn.value = false
    }
  }

  return { checkingIn, checkIn }
}
