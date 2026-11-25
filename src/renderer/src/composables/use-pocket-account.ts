import type { PocketClientProfileId, PocketVerifyResult } from '@preload/ipc-contract'
import { DEFAULT_POCKET_CLIENT_PROFILE, POCKET_CLIENT_PROFILE_OPTIONS, pocketClientProfileOption } from '@common/pocket-client-profile'
import {
  loginByPastedToken,
  loginBySmsCode,
  logoutPocket,
  notifyLoginSuccess,
  pocketAuthErrorMessage,
  pocketAuthState,
  refreshPocketAuthState,
  verifyPocketLogin,
} from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import { trackEvent } from '@renderer/utils/umami'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, getCurrentInstance, onBeforeUnmount, onScopeDispose, reactive, ref, watch } from 'vue'

/**
 * 口袋48账号卡：登录态展示、登录弹窗（短信 / Token 两条链路）、退出、
 * 登录有效性校验、签到触发。
 *
 * 登录与凭证存储在主进程（stores/pocket-auth.ts 接线）；这里只管表单与流程编排。
 * 签到按钮的防连点与文案在 use-pocket-checkin.ts。
 */

/** 登录身份档位的 APP 图标：与「推荐链接」里两个官方客户端的 logo 同源 */
const PROFILE_LOGOS: Record<PocketClientProfileId, string> = {
  pocket48: 'https://h5.48.cn/pocket48/image/logo.png',
  seine48: 'https://www.ckg48.cn/favicon.ico',
}

/** 支持的国家/地区区号：保持短列表，避免一个全量国家表喧宾夺主 */
const AREA_OPTIONS = [
  { label: '中国大陆 +86', value: '86' },
  { label: '中国香港 +852', value: '852' },
  { label: '中国澳门 +853', value: '853' },
  { label: '中国台湾 +886', value: '886' },
  { label: '新加坡 +65', value: '65' },
  { label: '日本 +81', value: '81' },
  { label: '韩国 +82', value: '82' },
  { label: '美国/加拿大 +1', value: '1' },
  { label: '英国 +44', value: '44' },
  { label: '澳大利亚 +61', value: '61' },
]

/** 发码节流窗口：与服务端一致，重开弹窗时据此恢复倒计时 */
const SMS_RESEND_MS = 60_000

/** 日志用：手机号脱敏，避免验证码链路打点泄露完整号码；海外号码位数不一，够长即按同规则脱敏并带区号前缀 */
function maskMobileForLog(mobile: string, area = '86'): string {
  const masked = area === '86'
    ? (mobile.length >= 7 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : '***')
    : (mobile.length >= 5 ? `${mobile.slice(0, 2)}****${mobile.slice(-2)}` : '***')
  return area === '86' ? masked : `+${area} ${masked}`
}

/**
 * @param onLoginSuccess 登录成功后的回调（设置页用它触发口袋关注同步）
 */
export function usePocketAccount(onLoginSuccess?: () => void) {
  // ===== 展示 =====

  /** 服务端返回的头像多为相对路径，归一成完整 URL 供展示 */
  const avatarUrl = computed(() => Tools.sourceUrl(pocketAuthState.value.avatar))

  /** 行标题：已登录且有昵称时用昵称，否则退回「口袋48账号」 */
  const rowTitle = computed(() => {
    const s = pocketAuthState.value
    return s.loggedIn && s.nickname ? s.nickname : '口袋48账号'
  })

  /** 已登录账号的身份标签：口袋48 / 塞纳河48 都展示当前登录档位 */
  const profileLabel = computed(() => {
    const s = pocketAuthState.value
    return s.loggedIn ? `${pocketClientProfileOption(s.clientProfile).label}身份` : ''
  })

  /** 当前登录档位的说明（徽标悬停提示）：与登录弹窗里选中档位的 hint 同一口径 */
  const currentProfileHint = computed(() => pocketClientProfileOption(pocketAuthState.value.clientProfile).hint)

  // ===== 登录弹窗 =====

  const loginDialogVisible = ref(false)
  const loginTab = ref<'sms' | 'token'>('sms')

  /**
   * 登录身份：本轮登录模拟哪个官方客户端（只影响请求头里的客户端身份）。
   * 档位随凭证落盘并对之后所有请求生效；换档需退出后重新登录。
   */
  const loginProfile = ref<PocketClientProfileId>(DEFAULT_POCKET_CLIENT_PROFILE)
  /** 当前所选身份的说明文案（登录弹窗内随选择变化） */
  const loginProfileHint = computed(() => pocketClientProfileOption(loginProfile.value).hint)

  /** 上次成功发码时刻（ms）；0 = 本次会话还没发过 */
  const smsSentAt = ref(0)

  /** 短信登录表单状态 */
  const smsForm = reactive({
    area: '86',
    mobile: '',
    code: '',
    sending: false,
    loggingIn: false,
    countdown: 0,
    /**
     * 验证码发出后锁定区号：服务端按 (区号+手机号) 存码，发码后切换区号会导致
     * 登录双键失配（报「验证码错误」且烧按号计的 5 次预算）。手机号不锁——
     * 改手机号即换服务端计数器，用户重发即可，无失配风险。
     */
    areaLocked: false,
    /** 反爬问答题：发送命中 2001 时置位，用户作答后随下一次发送提交 */
    captcha: null as null | { question: string, options: string[], answer: string },
  })
  /** token 粘贴登录表单状态 */
  const tokenForm = reactive({
    token: '',
    mobile: '',
    loggingIn: false,
  })

  /**
   * 反爬问答题待作答：不允许重发（不带答案必然再回同一道题）。
   * 前提是有选项——题目解析失败时 options 为空，用户无从作答，不能因此禁用按钮。
   */
  const captchaPending = computed(() =>
    !!smsForm.captcha && smsForm.captcha.options.length > 0 && !smsForm.captcha.answer,
  )

  /** 手机号是否可发送验证码：中国大陆仍按 11 位校验，其他区号只要求数字主体有效 */
  const smsSendable = computed(() => {
    // 与主进程同口径（sendSms 会 trim）：粘贴带空格的号码不该被判成无效
    const mobile = smsForm.mobile.trim()
    return smsForm.area === '86' ? /^\d{11}$/.test(mobile) : /^\d{4,15}$/.test(mobile)
  })

  /** 验证码登录按钮可用性 */
  const smsLoginable = computed(() => smsSendable.value && smsForm.code.trim().length > 0)
  /** token 登录按钮可用性 */
  const tokenLoginable = computed(() => tokenForm.token.trim().length > 0)

  function openLoginDialog() {
    smsForm.code = ''
    smsForm.captcha = null
    // 重开一律回到短信页：@opened 只自动聚焦短信页手机号，停在 Token 页聚焦会落空
    loginTab.value = 'sms'
    tokenForm.token = ''
    clearCountdown()
    // 服务端发码节流按 60s 计：重开弹窗时按剩余时间续上倒计时并保持区号锁定，
    // 否则用户会被允许立刻重发，拿到「发送过于频繁」这类与操作无关的报错
    const remaining = Math.ceil((SMS_RESEND_MS - (Date.now() - smsSentAt.value)) / 1000)
    if (smsSentAt.value && remaining > 0)
      startCountdown(remaining)
    else
      smsForm.areaLocked = false
    loginDialogVisible.value = true
  }

  /** 发送验证码；命中反爬问答题时展示题目，作答后可重发 */
  async function sendCode() {
    if (smsForm.sending || smsForm.countdown > 0)
      return
    // 问答题未作答就重发必然再吃一次 2001：直接挡在本地，别让用户以为按钮坏了
    if (captchaPending.value) {
      ElMessage.warning('请先完成下方验证')
      return
    }
    smsForm.sending = true
    debugLog('pocket-auth', '发送验证码：', JSON.stringify({
      profile: loginProfile.value,
      mobile: maskMobileForLog(smsForm.mobile, smsForm.area),
      hasCaptchaAnswer: !!smsForm.captcha?.answer,
    }))
    try {
      const result = await window.mainAPI.pocketSendSms(
        smsForm.mobile,
        smsForm.area,
        smsForm.captcha?.answer || undefined,
        loginProfile.value,
      )
      debugLog('pocket-auth', '发送验证码结果：', JSON.stringify({
        needCaptcha: result.needCaptcha,
        optionCount: result.options.length,
        message: result.message,
      }))
      if (result.needCaptcha) {
        // 选项为空 = 题目解析失败，用户无从作答：清掉，让重发按钮可点
        const answerable = result.options.length > 0
        smsForm.captcha = answerable ? { question: result.question, options: result.options, answer: '' } : null
        ElMessage.warning(answerable ? '需要先完成下方验证' : '验证题目未取到，请稍后重试')
        return
      }
      smsForm.captcha = null
      ElMessage.success('验证码已发送，请留意短信')
      smsForm.areaLocked = true
      smsSentAt.value = Date.now()
      startCountdown()
    }
    catch (error) {
      debugLog('pocket-auth', '发送验证码失败：', error)
      ElMessage.error(pocketAuthErrorMessage(error))
    }
    finally {
      smsForm.sending = false
    }
  }

  /** 验证码倒计时定时器：弹窗关闭 / 组件卸载必须清，否则空转着改响应式状态 */
  let countdownTimer: ReturnType<typeof setInterval> | null = null

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    smsForm.countdown = 0
  }

  function startCountdown(seconds = 60) {
    clearCountdown()
    smsForm.countdown = seconds
    countdownTimer = setInterval(() => {
      smsForm.countdown--
      if (smsForm.countdown <= 0)
        clearCountdown()
    }, 1000)
  }

  // 弹窗关闭即停表（倒计时期间关窗是常态）；组件销毁 / 副作用域结束时兜底清理。
  // 用 effectScope 而非裸 onBeforeUnmount：本 composable 要在单测的裸调用下也不报错
  watch(loginDialogVisible, visible => visible || clearCountdown())
  if (getCurrentInstance()) {
    onBeforeUnmount(clearCountdown)
    onScopeDispose(clearCountdown)
  }

  /** 登录成功后共用的收尾：关弹窗、回读登录态、同步关注 */
  async function afterLogin(state: Parameters<typeof notifyLoginSuccess>[0]) {
    loginDialogVisible.value = false
    notifyLoginSuccess(state)
    onLoginSuccess?.()
  }

  async function submitSmsLogin() {
    if (smsForm.loggingIn)
      return
    smsForm.loggingIn = true
    debugLog('pocket-auth', '提交验证码登录：', JSON.stringify({
      profile: loginProfile.value,
      mobile: maskMobileForLog(smsForm.mobile, smsForm.area),
      codeLength: smsForm.code.trim().length,
    }))
    try {
      const state = await loginBySmsCode(smsForm.mobile, smsForm.code, smsForm.area, loginProfile.value)
      // Umami 事件：口袋登录成功率（不带任何账号信息）
      trackEvent('pocket:login', { method: 'sms', profile: loginProfile.value, result: 'ok' })
      await afterLogin(state)
    }
    catch (error) {
      trackEvent('pocket:login', { method: 'sms', profile: loginProfile.value, result: 'fail' })
      debugLog('pocket-auth', '验证码登录失败：', error)
      ElMessage.error(pocketAuthErrorMessage(error))
    }
    finally {
      smsForm.loggingIn = false
    }
  }

  async function submitTokenLogin() {
    if (tokenForm.loggingIn)
      return
    tokenForm.loggingIn = true
    debugLog('pocket-auth', '提交 token 登录：', JSON.stringify({
      profile: loginProfile.value,
      mobile: maskMobileForLog(tokenForm.mobile),
      tokenLength: tokenForm.token.trim().length,
    }))
    try {
      const state = await loginByPastedToken(tokenForm.token, tokenForm.mobile, loginProfile.value)
      // Umami 事件：口袋登录成功率（不带任何账号信息）
      trackEvent('pocket:login', { method: 'token', profile: loginProfile.value, result: 'ok' })
      await afterLogin(state)
    }
    catch (error) {
      trackEvent('pocket:login', { method: 'token', profile: loginProfile.value, result: 'fail' })
      debugLog('pocket-auth', 'token 登录失败：', error)
      ElMessage.error(pocketAuthErrorMessage(error))
    }
    finally {
      tokenForm.loggingIn = false
    }
  }

  async function confirmLogout() {
    try {
      await ElMessageBox.confirm('退出后直播互动消息将不可用，确定退出？', '退出登录', {
        type: 'warning',
        customClass: 'app-confirm',
        modalClass: 'detail-card-overlay',
        confirmButtonText: '退出',
        cancelButtonText: '取消',
      })
    }
    catch {
      return
    }
    try {
      await logoutPocket()
      // 登录有 pocket:login，登出同样要有：否则账号留存 / 主动登出率永远算不出来
      trackEvent('pocket:logout', { result: 'ok' })
      ElMessage.success('已退出登录')
    }
    catch (error) {
      trackEvent('pocket:logout', { result: 'fail' })
      debugLog('pocket-auth', '退出登录失败：', error)
      ElMessage.error(pocketAuthErrorMessage(error))
    }
  }

  // ===== 登录有效性验证（点击已登录头像触发） =====

  const verifying = ref(false)
  const verifyDialogVisible = ref(false)
  /** 最近一次验证结果；null = 尚未验证 */
  const verifyResult = ref<PocketVerifyResult | null>(null)
  /** 验证过程中的网络异常（与「服务端判定失效」分开呈现） */
  const verifyError = ref('')

  /** 验证失败：网络异常，或服务端明确判定登录失效 */
  const verifyFailed = computed(() => !verifying.value && (!!verifyError.value || (!!verifyResult.value && !verifyResult.value.valid)))
  const verifyFailedMessage = computed(() => verifyError.value || verifyResult.value?.message || '登录已失效，请重新登录')

  /** 凭证在本机的保存天数（savedAt 为 0 时不展示） */
  const savedDays = computed(() => {
    const savedAt = pocketAuthState.value.savedAt
    if (!savedAt)
      return 0
    return Math.max(0, Math.floor((Date.now() - savedAt) / 86_400_000))
  })

  /**
   * 真实请求需登录的接口（token 校验 + IM 凭据 + 口袋钱包）验证登录态：
   * 有效时展示从服务端取回的资料与余额（本地存的只是上次登录的快照），
   * 失效时在结果弹窗里给出重新登录入口。
   */
  async function verifyLogin() {
    if (verifying.value)
      return
    verifying.value = true
    verifyError.value = ''
    verifyResult.value = null
    verifyDialogVisible.value = true
    try {
      const result = await verifyPocketLogin()
      verifyResult.value = result
      if (result.valid) {
        // 服务端资料可能比本地快照新（改过头像/昵称）：主进程已回写，这里回读刷新展示
        await refreshPocketAuthState()
      }
    }
    catch (error) {
      verifyError.value = pocketAuthErrorMessage(error)
    }
    finally {
      verifying.value = false
    }
  }

  /** 验证失败后直接从结果弹窗跳转登录弹窗，少一次关闭操作 */
  function reloginFromVerify() {
    verifyDialogVisible.value = false
    openLoginDialog()
  }

  return {
    // 展示
    avatarUrl,
    rowTitle,
    profileLabel,
    currentProfileHint,
    // 登录弹窗
    loginDialogVisible,
    loginTab,
    loginProfile,
    loginProfileHint,
    profileLogos: PROFILE_LOGOS,
    profileOptions: POCKET_CLIENT_PROFILE_OPTIONS,
    areaOptions: AREA_OPTIONS,
    smsForm,
    tokenForm,
    smsSendable,
    smsLoginable,
    tokenLoginable,
    captchaPending,
    openLoginDialog,
    sendCode,
    submitSmsLogin,
    submitTokenLogin,
    confirmLogout,
    // 验证
    verifying,
    verifyDialogVisible,
    verifyResult,
    verifyFailed,
    verifyFailedMessage,
    savedDays,
    verifyLogin,
    reloginFromVerify,
  }
}
