<script setup lang="ts">
import type { NetDiagnoseItem, PocketClientProfileId, PocketVerifyResult } from '@preload/ipc-contract'
import type { InputInstance } from 'element-plus'
import { DEFAULT_POCKET_CLIENT_PROFILE, POCKET_CLIENT_PROFILE_OPTIONS, pocketClientProfileOption } from '@common/pocket-client-profile'
import { Connection, Cpu, Document, Download, Folder, Hide, Lock, Refresh, Top, User, WarningFilled } from '@element-plus/icons-vue'
import { useAppConfig } from '@renderer/composables/use-app-config'
import { describeFfmpegProblem, useFfmpegSetup } from '@renderer/composables/use-ffmpeg-setup'
import { usePocketFollowSync } from '@renderer/composables/use-pocket-follow'
import { useUpdater } from '@renderer/composables/use-updater'
import { useBlockedMembersStore } from '@renderer/stores/member-flags'
import {
  checkInPocket,
  loginByPastedToken,
  loginBySmsCode,
  logoutPocket,
  notifyLoginSuccess,
  pocketAuthErrorMessage,
  pocketAuthState,
  refreshPocketAuthState,
  verifyPocketLogin,
} from '@renderer/stores/pocket-auth'
import Constants from '@renderer/utils/constants'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import { trackEvent } from '@renderer/utils/umami'
import { previewReleaseNotes } from '@renderer/utils/update-notes'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 下载目录的状态与读写集中在 use-app-config.ts
const {
  downloadDirectory,
  loadAppConfig,
  setDownloadDirectory,
  openDownloadDirectory,
} = useAppConfig()

// FFmpeg 环境：就绪状态、一键下载与选择修复集中在 use-ffmpeg-setup.ts
// （与启动门禁同一判定口径与文案，见 components/app/Initialize.vue）
const {
  status: ffmpegStatus,
  checking: ffmpegChecking,
  downloading: ffmpegDownloading,
  busy: ffmpegBusy,
  directory: ffmpegDirectory,
  copy: ffmpegCopy,
  downloadPercent: ffmpegDownloadPercent,
  downloadLabel: ffmpegDownloadLabel,
  refresh: refreshFfmpeg,
  download: downloadFfmpeg,
  choose: chooseFfmpegDir,
  openDirectory: openFfmpegDirectory,
} = useFfmpegSetup()

/** 屏蔽名单：模块级共享状态，机制见 stores/member-flags.ts */
const { blockedMembers, refreshBlockedMembers, unblockMember, clearBlockedMembers } = useBlockedMembersStore()

// 自动更新：状态镜像与操作集中在 use-updater.ts
const { state: updaterState, checking: updaterChecking, version: appVersion, check: checkUpdate, download: downloadUpdate, install: installUpdate } = useUpdater()

// 口袋关注拉取：启动/登录后把账号维度的关注合并进本地名单（use-pocket-follow.ts）
const {
  syncing: followSyncing,
  syncPulled: followSyncPulled,
  syncError: followSyncError,
  sync: syncPocketFollow,
  syncIfStale: syncPocketFollowIfStale,
} = usePocketFollowSync()

/**
 * 手动拉取口袋关注：结果用消息提示。失败原因来自 syncError（如未登录 / 网络错误），
 * 与启动时的静默拉取不同——用户主动点了按钮，就应得到明确反馈。
 */
async function handleSyncFollow() {
  const ok = await syncPocketFollow()
  if (ok) {
    ElMessage({ message: `口袋关注已拉取（${followSyncPulled.value} 人）`, type: 'success' })
    return
  }
  ElMessage.error(followSyncError.value || '拉取关注失败，请稍后重试')
}

const checkingIn = ref(false)

/** 每日签到：奖励文案以服务端返回为准，重复签到的提示也由服务端给出 */
async function handleCheckIn() {
  if (checkingIn.value)
    return
  checkingIn.value = true
  try {
    const result = await checkInPocket()
    const rewards = [`成长值 +${result.addExp}`, `鸡翅 +${result.addSupport}`]
    if (result.addMoney > 0)
      rewards.push(`鸡腿 +${result.addMoney}`)
    const days = result.days > 0 ? `，累计签到 ${result.days} 天` : ''
    ElMessage.success(`签到成功：${rewards.join('，')}${days}`)
  }
  catch (error) {
    debugLog('pocket-auth', '签到失败：', error)
    ElMessage.warning(pocketAuthErrorMessage(error))
  }
  finally {
    checkingIn.value = false
  }
}

onMounted(async () => {
  await loadAppConfig()
  // FFmpeg 就绪状态每次都重新判定：目录可能在应用之外被删除或移动
  await refreshFfmpeg()
  await refreshBlockedMembers()
  await refreshPocketAuthState()
  // 已登录则静默拉取一次口袋关注（friends/id 一次性返回，无分页成本）
  syncPocketFollowIfStale(5 * 60 * 1000)
})

/** FFmpeg 行状态徽章：可用 / 未配置 / 目录不存在 / 缺少 ffmpeg */
const ffmpegStateLabel = computed(() => {
  if (!ffmpegStatus.value)
    return ffmpegChecking.value ? '检测中…' : '状态未知'
  return ffmpegCopy.value.label
})

const ffmpegStateClass = computed(() => {
  if (!ffmpegStatus.value)
    return 'is-checking'
  return ffmpegStatus.value.ok ? 'is-ready' : 'is-broken'
})

/** 一键下载 FFmpeg：成功即已写入配置，无需再点保存 */
async function handleDownloadFfmpeg() {
  if (await downloadFfmpeg()) {
    ElMessage({ message: 'FFmpeg 已就绪', type: 'success' })
    return
  }
  ElMessage.error('下载 FFmpeg 失败：请检查网络后重试，或手动选择已有目录')
}

/** 手动选择目录：校验通过才落盘，校验失败说明错在哪（目录不存在 / 目录内缺 ffmpeg） */
async function handleChooseFfmpegDir() {
  const result = await chooseFfmpegDir()
  if (result.outcome === 'ok') {
    ElMessage({ message: '设置成功', type: 'success' })
    return
  }
  if (result.outcome === 'invalid') {
    ElMessage.error(describeFfmpegProblem(result.status.problem, result.status.directory).title)
    return
  }
  if (result.outcome === 'failed')
    ElMessage.error('设置 FFmpeg 目录失败，请重试')
}

// 网络诊断：对核心服务域名逐一探测连通性（主进程对端 main/net-diagnose.ts）。
// 用于接口报错（如 HTTP 403）时让用户自助定位：不可达 / 被拒 / 服务端异常一目了然。
const diagnosing = ref(false)
const diagnoseResults = ref<NetDiagnoseItem[]>([])

/** 发起诊断：结果整体替换而非追加，重复点击看到的是最新一轮 */
async function handleDiagnose() {
  if (diagnosing.value)
    return
  diagnosing.value = true
  try {
    diagnoseResults.value = await window.mainAPI.netDiagnose()
  }
  catch (e: any) {
    ElMessage.error(`网络诊断失败：${e?.message || '未知错误'}`)
  }
  finally {
    diagnosing.value = false
  }
}

/** 单条结果的结论徽标：按状态码分段给出结论与语义色 */
function diagnoseVerdict(item: NetDiagnoseItem): { label: string, type: 'success' | 'warning' | 'danger' | 'info' } {
  if (item.status === null)
    return { label: '不可达', type: 'danger' }
  if (item.status < 400)
    return { label: '正常', type: 'success' }
  if (item.status === 403)
    return { label: '拒绝访问', type: 'danger' }
  if (item.status < 500)
    return { label: `HTTP ${item.status}`, type: 'warning' }
  return { label: `HTTP ${item.status}`, type: 'danger' }
}

/** 单条结果的补充说明：解释这个状态码对排查意味着什么 */
function diagnoseNote(item: NetDiagnoseItem): string {
  if (item.status === null)
    return item.error || '连接失败'
  if (item.status === 403)
    return '服务端可达但拒绝访问：对比各身份行可区分地区策略与客户端身份限制'
  if (item.status >= 400 && item.status < 500)
    return '服务端可达（该状态码是探测路径的响应，不影响业务接口）'
  if (item.status >= 500)
    return '服务端异常，非本机网络问题'
  return ''
}

/** 复制诊断结果：随应用版本一起输出，方便用户直接粘贴反馈 */
async function handleCopyDiagnose() {
  const lines = diagnoseResults.value.map((item) => {
    const verdict = diagnoseVerdict(item)
    const status = item.status === null ? '无响应' : `HTTP ${item.status}`
    const note = diagnoseNote(item)
    // detail 可能是 4xx/5xx 的响应体摘要，也可能是多来源目标的主备说明，不额外加前缀
    return `${item.label}（${item.url}）: ${status} · ${item.ms}ms · ${verdict.label}${note ? ` · ${note}` : ''}${item.error ? ` · ${item.error}` : ''}${item.detail ? ` · ${item.detail}` : ''}`
  })
  const text = [
    `应用版本: ${appVersion.value}`,
    `诊断时间: ${new Date().toLocaleString()}`,
    ...lines,
  ].join('\n')
  await navigator.clipboard.writeText(text)
  ElMessage({ message: '诊断结果已复制，可粘贴发给开发者', type: 'success' })
}

/** 更新行的描述文案：一行说清当前处于什么状态、下一步该做什么 */
const updaterDesc = computed(() => {
  const s = updaterState.value
  switch (s.phase) {
    case 'checking':
      return '正在检查更新，请稍候…'
    case 'up-to-date':
      return '当前已是最新版本，无需更新'
    case 'available':
      return `发现新版本 v${s.version}`
    case 'downloading':
      return `正在下载新版本 v${s.version}…`
    case 'ready':
      return `新版本 v${s.version} 已下载完成，重启后生效`
    case 'error':
      return `检查更新失败：${s.message}`
    case 'unsupported':
      return s.reason
    default:
      return '检查是否有可用的新版本'
  }
})

/** available 态的描述切强调样式，与中性状态一眼区分 */
const updaterDescClass = computed(() =>
  updaterState.value.phase === 'available' ? 'is-update' : '')

/**
 * 新版本信息：仅 available 态非空。模板据此在标题行挂「有新版本」徽标、
 * 在卡片内展开提示块，并把主按钮切成「更新版本」。
 */
const availableUpdate = computed(() => {
  const s = updaterState.value
  return s.phase === 'available' ? s : null
})

/** 下载中信息：仅 downloading 态非空，提示块内的进度展示取自此状态 */
const downloadingUpdate = computed(() => {
  const s = updaterState.value
  return s.phase === 'downloading' ? s : null
})

/** 提示块标题：available / downloading 各一句；版本号在脚本侧拼接，模板不做类型收窄 */
const availableTitle = computed(() =>
  availableUpdate.value ? `发现新版本 v${availableUpdate.value.version}` : '')
const downloadingTitle = computed(() =>
  downloadingUpdate.value ? `正在下载新版本 v${downloadingUpdate.value.version}` : '')

/** 版本对比行：已知当前版本时给出「当前 vX → 最新 vY」，否则只报最新版本 */
const updateVersionLine = computed(() => {
  const next = availableUpdate.value
  if (!next)
    return ''
  return appVersion.value ? `当前 v${appVersion.value} → 最新 v${next.version}` : `最新版本 v${next.version}`
})

/**
 * 更新说明预览：GitHub releaseNotes 常为 markdown，剥掉标题 / 列表 / 链接 /
 * 加粗标记后按纯文本行展示，并过滤 Full Changelog 汇总行；最多 4 行。
 */
const releaseNotesPreview = computed(() =>
  previewReleaseNotes(availableUpdate.value?.releaseNotes ?? ''),
)

/** 字节数格式化：下载进度的已传 / 总量与速率 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 1024 ** exp
  return `${exp === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`
}

/** 下载进度文字：总量已知时给出「已传 / 总量 · 速率」，否则只报已传与速率 */
const downloadSizeText = computed(() => {
  const d = downloadingUpdate.value
  if (!d)
    return ''
  const speed = `${formatBytes(d.bytesPerSecond)}/s`
  return d.total > 0
    ? `${formatBytes(d.transferred)} / ${formatBytes(d.total)} · ${speed}`
    : `${formatBytes(d.transferred)} · ${speed}`
})

/** 手动下载兜底地址；正常情况下主进程会在 available 态带上 GitHub Release 地址。 */
const MANUAL_RELEASE_PAGE_URL = 'https://github.com/mirtu-ko/Desktop48.app/releases/latest'

/** available 态是否只能跳转 GitHub 手动下载（macOS 当前走该链路） */
const manualUpdateNotice = computed(() => availableUpdate.value?.manualUpdate ?? false)
/** available 态的手动下载地址，模板与操作按钮共用 */
const manualUpdateUrl = computed(() => availableUpdate.value?.url ?? MANUAL_RELEASE_PAGE_URL)

/** 主操作按钮：状态决定文案与语义；自动更新 available 态是「更新版本」，macOS 是「去下载」 */
const updaterAction = computed(() => {
  const s = updaterState.value
  if (s.phase === 'downloading')
    return { label: '下载中', disabled: true, loading: true, handler: () => {} }
  if (s.phase === 'ready')
    return { label: '立即重启', disabled: false, loading: false, handler: installUpdate }
  if (s.phase === 'available' && s.manualUpdate)
    return { label: '去下载', disabled: false, loading: false, handler: () => openReleasePage(manualUpdateUrl.value) }
  if (s.phase === 'available')
    return { label: '更新版本', disabled: false, loading: false, handler: downloadUpdate }
  // 免安装版等不支持自动更新的环境给出手工出路，别让用户对着禁用按钮无计可施
  if (s.phase === 'unsupported' && s.url)
    return { label: '去下载', disabled: false, loading: false, handler: () => openReleasePage(s.url!) }
  return { label: '检查更新', disabled: updaterChecking.value || s.phase === 'unsupported', loading: updaterChecking.value, handler: checkUpdate }
})

/**
 * 打开手工下载页。
 *
 * 经 `window.open` 触发主进程的 `setWindowOpenHandler`，转交系统浏览器
 * （与 use-album-player.ts 同一路径；主进程只放行 http/https）。
 */
function openReleasePage(url: string) {
  window.open(url, '_blank', 'noopener')
}

/** 下载进度百分比（提示块内的进度条与百分比文字共用） */
const updaterPercent = computed(() =>
  updaterState.value.phase === 'downloading' ? Math.min(100, updaterState.value.percent) : 0,
)

/** 清空名单前二次确认 */
async function confirmClearBlockedMembers() {
  try {
    await ElMessageBox.confirm(`确定清空全部 ${blockedMembers.value.length} 个屏蔽成员？`, '清空屏蔽名单', {
      type: 'warning',
      customClass: 'app-confirm',
      modalClass: 'detail-card-overlay',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  }
  catch {
    return // 用户取消
  }
  await clearBlockedMembers()
}

/** 屏蔽 / 解除成员的入口在成员页 */
function goMembers() {
  router.push('/members')
}

// ===== 口袋48账号登录 =====
// 登录与凭证存储在主进程（stores/pocket-auth.ts 接线）；这里只管表单与流程编排。

const loginDialogVisible = ref(false)
const loginTab = ref<'sms' | 'token'>('sms')

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

/**
 * 登录身份：本轮登录模拟哪个官方客户端（只影响请求头里的客户端身份）。
 * 档位随凭证落盘并对之后所有请求生效；换档需退出后重新登录。
 */
const loginProfile = ref<PocketClientProfileId>(DEFAULT_POCKET_CLIENT_PROFILE)
/** 登录身份档位的 APP 图标：与「推荐链接」里两个官方客户端的 logo 同源 */
const profileLogos: Record<PocketClientProfileId, string> = {
  pocket48: 'https://h5.48.cn/pocket48/image/logo.png',
  seine48: 'https://www.ckg48.cn/favicon.ico',
}
/** 当前所选身份的说明文案（登录弹窗内随选择变化） */
const loginProfileHint = computed(() => pocketClientProfileOption(loginProfile.value).hint)
/** 已登录账号的身份标签：口袋48 / 塞纳河48 都展示当前登录档位 */
const currentProfileLabel = computed(() => {
  const s = pocketAuthState.value
  return s.loggedIn ? `${pocketClientProfileOption(s.clientProfile).label}身份` : ''
})

/** 发码节流窗口：与服务端一致，重开弹窗时据此恢复倒计时 */
const SMS_RESEND_MS = 60_000
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

/** 反爬问答题待作答：此时不允许重发（不带答案必然再回同一道题） */
const captchaPending = computed(() => !!smsForm.captcha && !smsForm.captcha.answer)

/** 日志用：手机号脱敏，避免验证码链路打点泄露完整号码；海外号码位数不一，够长即按同规则脱敏并带区号前缀 */
function maskMobileForLog(mobile: string, area = '86'): string {
  const masked = area === '86'
    ? (mobile.length >= 7 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : '***')
    : (mobile.length >= 5 ? `${mobile.slice(0, 2)}****${mobile.slice(-2)}` : '***')
  return area === '86' ? masked : `+${area} ${masked}`
}

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
    ElMessage.success('已退出登录')
  }
  catch (error) {
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

/** 计数：千分位整数；非数字原样返回 */
function formatCount(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN') : value
}

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

/** 服务端返回的头像多为相对路径，归一成完整 URL 供展示 */
const authAvatarUrl = computed(() => Tools.sourceUrl(pocketAuthState.value.avatar))

/** 行标题：已登录且有昵称时用昵称，否则退回「口袋48账号」 */
const authRowTitle = computed(() => {
  const s = pocketAuthState.value
  return s.loggedIn && s.nickname ? s.nickname : '口袋48账号'
})

/** 发送验证码；命中反爬问答题时展示题目，作答后可重发 */
async function sendSmsCode() {
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
      smsForm.captcha = { question: result.question, options: result.options, answer: '' }
      ElMessage.warning('需要先完成下方验证')
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

// 弹窗关闭即停表（倒计时期间关窗是常态）；onBeforeUnmount 兜底组件直接销毁的场景
watch(loginDialogVisible, visible => visible || clearCountdown())
onBeforeUnmount(clearCountdown)

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
    loginDialogVisible.value = false
    notifyLoginSuccess(state)
    void syncPocketFollow()
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
    loginDialogVisible.value = false
    notifyLoginSuccess(state)
    void syncPocketFollow()
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

/** 手机号是否可发送验证码：中国大陆仍按 11 位校验，其他区号只要求数字主体有效 */
const smsSendable = computed(() => {
  // 与主进程同口径（sendSms 会 trim）：粘贴带空格的号码不该被判成无效
  const mobile = smsForm.mobile.trim()
  return smsForm.area === '86' ? /^\d{11}$/.test(mobile) : /^\d{4,15}$/.test(mobile)
})
/** 短信登录手机号输入框：弹窗打开后自动聚焦，省一次点击 */
const smsMobileRef = ref<InputInstance>()

function focusSmsMobile() {
  smsMobileRef.value?.focus()
}

/** 验证码登录按钮可用性 */
const smsLoginable = computed(() => smsSendable.value && smsForm.code.trim().length > 0)
/** token 登录按钮可用性 */
const tokenLoginable = computed(() => tokenForm.token.trim().length > 0)

/** 友情链接（logo 加载失败时回退为首字磁贴）；应用内主题色引用 app.scss 变量 */
interface FriendLink {
  name: string
  url: string
  abbr: string
  color: string
  logo?: string
  /** 内联品牌 SVG 图形（优先于 abbr 文本磁贴），viewBox 默认 0 0 24 24 */
  glyph?: string
  glyphBox?: string
}

const friendLinks: FriendLink[] = [
  { name: 'SNH48 官方网站', url: 'https://www.snh48.com/', abbr: 'SNH', color: Constants.GroupTabs[1].color },
  { name: 'SNH48 官方直播', url: 'https://live.48.cn/', abbr: 'Live', color: 'var(--color-setting)' },
  { name: '口袋48 APP', url: 'https://h5.48.cn/pocket48/index_pc.html', abbr: '48', color: 'var(--color-members)', logo: 'https://h5.48.cn/pocket48/image/logo.png' },
  { name: '塞纳河48 APP', url: 'https://www.ckg48.cn/', abbr: 'CKG', color: 'var(--color-shows)', logo: 'https://www.ckg48.cn/favicon.ico' },
  {
    name: '新浪微博',
    url: 'https://weibo.com/u/2689280541',
    abbr: '微博',
    color: '#e6162d',
    glyph: 'M407 177.6c7.6-24-13.4-46.8-37.4-41.7-22 4.8-28.8-28.1-7.1-32.8 50.1-10.9 92.3 37.1 76.5 84.8-6.8 21.2-38.8 10.8-32-10.3zM214.8 446.7c-106.3 0-214.8-51.4-214.8-136.3 0-44.3 28-95.4 76.3-143.7 99.7-99.7 203.2-100.9 173.6-5.7-4 13.1 12.3 5.7 12.3 6 79.5-33.6 140.5-16.8 114 51.4-3.7 9.4 1.1 10.9 8.3 13.1 135.7 42.3 34.8 215.2-169.7 215.2zM358.5 300.4c-5.4-55.7-78.5-94-163.4-85.7-84.8 8.6-148.8 60.3-143.4 116s78.5 94 163.4 85.7c84.8-8.6 148.8-60.3 143.4-116zM347.9 35.1c-25.9 5.6-16.8 43.7 8.3 38.3 72.3-15.2 134.8 52.8 111.7 124-7.4 24.2 29.1 37 37.4 12 31.9-99.8-55.1-195.9-157.4-174.3zm-78.5 311c-17.1 38.8-66.8 60-109.1 46.3-40.8-13.1-58-53.4-40.3-89.7 17.7-35.4 63.1-55.4 103.4-45.1 42 10.8 63.1 50.2 46 88.5zm-86.3-30c-12.9-5.4-30 .3-38 12.9-8.3 12.9-4.3 28 8.6 34 13.1 6 30.8 .3 39.1-12.9 8-13.1 3.7-28.3-9.7-34zm32.6-13.4c-5.1-1.7-11.4 .6-14.3 5.4-2.9 5.1-1.4 10.6 3.7 12.9 5.1 2 11.7-.3 14.6-5.4 2.8-5.2 1.1-10.9-4-12.9z',
    glyphBox: '0 0 512 512',
  },
  {
    name: '哔哩哔哩',
    url: 'https://space.bilibili.com/2832224',
    abbr: 'B站',
    color: '#00a1d6',
    glyph: 'M488.6 104.1c16.7 18.1 24.4 39.7 23.3 65.7l0 202.4c-.4 26.4-9.2 48.1-26.5 65.1-17.2 17-39.1 25.9-65.5 26.7L92 464c-26.4-.8-48.2-9.8-65.3-27.2-17.1-17.4-26-40.3-26.7-68.6L0 169.8c.8-26 9.7-47.6 26.7-65.7 17.1-16.3 38.8-25.3 65.3-26.1l29.4 0-25.4-25.8c-5.7-5.7-8.6-13-8.6-21.8s2.9-16.1 8.6-21.8 13-8.6 21.9-8.6 16.1 2.9 21.9 8.6l73.3 69.4 88 0 74.5-69.4C381.7 2.9 389.2 0 398 0s16.1 2.9 21.9 8.6c5.7 5.7 8.6 13 8.6 21.8s-2.9 16.1-8.6 21.8L394.6 78 423.9 78c26.4 .8 48 9.8 64.7 26.1zm-38.8 69.7c-.4-9.6-3.7-17.4-10.7-23.5-5.2-6.1-14-9.4-22.7-9.8l-320.4 0c-9.6 .4-17.4 3.7-23.6 9.8-6.1 6.1-9.4 13.9-9.8 23.5l0 194.4c0 9.2 3.3 17 9.8 23.5s14.4 9.8 23.6 9.8l320.4 0c9.2 0 17-3.3 23.3-9.8s9.7-14.3 10.1-23.5l0-194.4zM185.5 216.5c6.3 6.3 9.7 14.1 10.1 23.2l0 33.3c-.4 9.2-3.7 16.9-9.8 23.2-6.2 6.3-14 9.5-23.6 9.5s-17.5-3.2-23.6-9.5-9.4-14-9.8-23.2l0-33.3c.4-9.1 3.8-16.9 10.1-23.2s13.2-9.6 23.3-10c9.2 .4 17 3.7 23.3 10zm191.5 0c6.3 6.3 9.7 14.1 10.1 23.2l0 33.3c-.4 9.2-3.7 16.9-9.8 23.2s-14 9.5-23.6 9.5-17.4-3.2-23.6-9.5c-7-6.3-9.4-14-9.7-23.2l0-33.3c.3-9.1 3.7-16.9 10-23.2s14.1-9.6 23.3-10c9.2 .4 17 3.7 23.3 10z',
    glyphBox: '0 0 512 512',
  },
  {
    name: 'YouTube',
    url: 'https://www.youtube.com/@SNH48Official',
    abbr: 'YT',
    color: '#ff0000',
    glyph: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
]

/** 参考项目致谢 */
interface ReferenceProject {
  name: string
  url: string
  role: string
}

const referenceProjects: ReferenceProject[] = [
  { name: 'Jarvay/desktop48', url: 'https://github.com/Jarvay/desktop48', role: '参考项目' },
  { name: 'yk1z/yaya_msg', url: 'https://github.com/yk1z/yaya_msg', role: '房间消息' },
]

/** 展示链接域名 */
function linkHost(url: string) {
  try {
    return new URL(url).hostname
  }
  catch {
    return url
  }
}

/** logo 加载失败时隐藏图片，露出首字磁贴 */
function hideLogo(event: Event) {
  (event.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <el-scrollbar
    class="scrollbar-wrapper"
    wrap-class="scrollbar-wrapper"
  >
    <div class="setting-root">
      <!-- 口袋48账号 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile auth-avatar"
            :class="{ 'is-clickable': pocketAuthState.loggedIn, 'is-verifying': verifying, 'has-avatar': !!authAvatarUrl }"
            :style="{ '--tile-color': 'var(--brand-primary)' }"
            :title="pocketAuthState.loggedIn ? (verifying ? '正在验证登录…' : '点击查看登录状态与账号资料') : ''"
            @click="pocketAuthState.loggedIn ? verifyLogin() : undefined"
          >
            <img
              v-if="pocketAuthState.loggedIn && authAvatarUrl"
              :src="authAvatarUrl"
              alt="账号头像"
            >
            <el-icon v-else>
              <User />
            </el-icon>
          </span>
          <div class="row-text row-text--fluid">
            <div class="row-title">
              {{ authRowTitle }}<span
                v-if="currentProfileLabel"
                class="row-profile-badge"
                :title="pocketClientProfileOption(pocketAuthState.clientProfile).hint"
              >{{ currentProfileLabel }}</span>
            </div>
            <div class="row-desc">
              <template v-if="pocketAuthState.loggedIn">
                账号<template v-if="pocketAuthState.mobileMasked">
                  （{{ pocketAuthState.mobileMasked }}）
                </template>
              </template>
              <template v-else>
                登录后可在直播页实时查看口袋互动消息
              </template>
            </div>
          </div>
          <div class="row-actions">
            <template v-if="pocketAuthState.loggedIn">
              <el-tag
                v-if="pocketAuthState.plainFallback"
                type="warning"
                size="small"
                class="auth-fallback-tag"
              >
                明文存储
              </el-tag>
              <el-button
                :loading="checkingIn"
                @click="handleCheckIn"
              >
                签到
              </el-button>
              <el-button
                type="danger"
                plain
                @click="confirmLogout"
              >
                退出登录
              </el-button>
            </template>
            <el-button
              v-else
              type="primary"
              @click="openLoginDialog"
            >
              登录
            </el-button>
          </div>
        </div>
      </section>

      <!-- 默认下载目录 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': 'var(--color-downloads)' }"
          >
            <el-icon><Folder /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              默认下载目录
            </div>
            <div class="row-desc">
              回放与录制文件的保存位置
            </div>
          </div>
          <el-input
            v-model="downloadDirectory"
            class="row-control"
            readonly
            placeholder="点击输入框选择目录"
            @click="setDownloadDirectory"
          />
          <div class="row-actions">
            <el-button
              :disabled="!downloadDirectory"
              @click="openDownloadDirectory"
            >
              打开目录
            </el-button>
            <el-button
              type="primary"
              @click="setDownloadDirectory"
            >
              选择
            </el-button>
          </div>
        </div>
      </section>

      <!-- ffmpeg 目录 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': 'var(--color-lives)' }"
          >
            <el-icon><Cpu /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              FFmpeg 目录
            </div>
            <div class="row-desc">
              播放直播与录制下载依赖的程序
            </div>
          </div>
          <el-input
            :model-value="ffmpegDirectory"
            class="row-control"
            readonly
            placeholder="未配置，可一键下载或手动选择"
            @click="handleChooseFfmpegDir"
          />
          <div class="row-actions">
            <el-button
              :disabled="!ffmpegDirectory"
              @click="openFfmpegDirectory"
            >
              打开目录
            </el-button>
            <el-button
              :disabled="ffmpegBusy"
              @click="handleChooseFfmpegDir"
            >
              选择
            </el-button>
            <el-button
              type="primary"
              :disabled="ffmpegBusy"
              :loading="ffmpegDownloading"
              @click="handleDownloadFfmpeg"
            >
              {{ ffmpegDownloading ? '下载中' : '下载' }}
            </el-button>
          </div>
        </div>

        <!-- 就绪状态：目录可能在应用之外被删除或移动，这里给出可直接照做的修复说明 -->
        <div class="row-body">
          <div
            class="ffmpeg-state"
            :class="ffmpegStateClass"
          >
            <span class="state-dot" />
            <span class="state-label">{{ ffmpegStateLabel }}</span>
            <span
              v-if="ffmpegStatus && !ffmpegStatus.ok"
              class="state-hint"
            >{{ ffmpegCopy.hint }}</span>
          </div>
          <el-progress
            v-if="ffmpegDownloading && ffmpegDownloadPercent !== null"
            class="ffmpeg-progress"
            :percentage="ffmpegDownloadPercent"
            :stroke-width="8"
            :show-text="false"
          />
          <p
            v-if="ffmpegDownloading"
            class="ffmpeg-progress-label"
          >
            {{ ffmpegDownloadLabel }}
          </p>
          <p
            v-else-if="ffmpegStatus && !ffmpegStatus.ok"
            class="ffmpeg-fix-hint"
          >
            下一步：点击「下载」自动获取，或点击「选择」指定本机已有的 FFmpeg 目录。
          </p>
        </div>
      </section>

      <!-- 屏蔽成员 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': 'var(--color-members)' }"
          >
            <el-icon><Hide /></el-icon>
          </span>
          <div class="row-text row-text--fluid">
            <div class="row-title">
              屏蔽成员
            </div>
            <div class="row-desc">
              已屏蔽 {{ blockedMembers.length }} 名成员，其直播、回放与房间消息将不再展示
            </div>
          </div>
          <div class="row-actions">
            <el-button
              type="danger"
              plain
              :disabled="!blockedMembers.length"
              @click="confirmClearBlockedMembers"
            >
              清空
            </el-button>
            <el-button
              type="primary"
              @click="goMembers"
            >
              屏蔽成员
            </el-button>
          </div>
        </div>
        <div class="row-body">
          <div v-if="blockedMembers.length" class="tag-list">
            <el-tag
              v-for="member in blockedMembers"
              :key="member.userId"
              closable
              :color="Tools.toHex(member.teamColor)"
              effect="dark"
              @close="unblockMember(member.userId)"
            >
              {{ member.realName }}
            </el-tag>
          </div>
          <div v-else class="empty-hint">
            尚未屏蔽任何成员，点击「屏蔽成员」前往成员页操作
          </div>
        </div>
      </section>

      <!-- 版本与更新：轻量单行，作为设置项收尾，与下方声明区的「关于」语义衔接 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': 'var(--color-albums)' }"
          >
            <el-icon><Refresh /></el-icon>
          </span>
          <div class="row-text row-text--fluid">
            <div class="row-title">
              版本
              <span v-if="appVersion" class="row-version">v{{ appVersion }}</span>
              <span v-if="availableUpdate" class="row-update-badge">有新版本</span>
            </div>
            <div class="row-desc" :class="updaterDescClass">
              {{ updaterDesc }}
            </div>
          </div>
          <div class="row-actions">
            <el-button
              v-if="updaterState.phase === 'available' || updaterState.phase === 'ready'"
              :disabled="updaterChecking"
              @click="checkUpdate"
            >
              重新检查
            </el-button>
            <el-button
              type="primary"
              :disabled="updaterAction.disabled"
              :loading="updaterAction.loading"
              @click="updaterAction.handler"
            >
              {{ updaterAction.label }}
            </el-button>
          </div>
        </div>

        <!-- 新版本提示：available 态展开版本对比与更新说明；downloading 态接棒显示下载进度 -->
        <div v-if="availableUpdate || downloadingUpdate" class="row-body update-notice">
          <template v-if="availableUpdate">
            <div class="update-notice-head">
              <el-icon class="update-notice-icon">
                <Top />
              </el-icon>
              <span class="update-notice-title">{{ availableTitle }}</span>
              <span class="update-notice-versions">{{ updateVersionLine }}</span>
            </div>
            <ul v-if="releaseNotesPreview.lines.length" class="update-notes">
              <li
                v-for="(line, index) in releaseNotesPreview.lines"
                :key="index"
              >
                {{ line }}
              </li>
            </ul>
            <p v-if="releaseNotesPreview.truncated" class="update-notes-more">
              更多更新内容详见 GitHub Release 页面
            </p>
            <p class="update-notice-hint">
              {{ manualUpdateNotice
                ? 'macOS 暂不支持应用内更新，请点击「去下载」打开 GitHub 页面，下载后手动安装。'
                : '点击「更新版本」开始下载，下载完成后重启应用即可完成升级。' }}
            </p>
          </template>
          <template v-else-if="downloadingUpdate">
            <div class="update-notice-head">
              <el-icon class="update-notice-icon">
                <Download />
              </el-icon>
              <span class="update-notice-title">{{ downloadingTitle }}</span>
              <span class="update-notice-versions">{{ updaterPercent.toFixed(0) }}%</span>
            </div>
            <el-progress
              class="update-progress"
              :percentage="updaterPercent"
              :stroke-width="8"
              :show-text="false"
            />
            <p class="update-notice-hint">
              {{ downloadSizeText }}，下载完成后需重启应用以完成更新。
            </p>
          </template>
        </div>
      </section>

      <!-- 网络诊断 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': 'var(--color-shows)' }"
          >
            <el-icon><Connection /></el-icon>
          </span>
          <div class="row-text row-text--fluid">
            <div class="row-title">
              网络诊断（仅供参考）
            </div>
            <div class="row-desc">
              检测核心服务域名与口袋客户端身份的连通情况；接口报错（如 HTTP 403）时可能影响使用
            </div>
          </div>
          <div class="row-actions">
            <el-button
              v-if="diagnoseResults.length"
              :disabled="diagnosing"
              @click="handleCopyDiagnose"
            >
              复制结果
            </el-button>
            <el-button
              type="primary"
              :loading="diagnosing"
              @click="handleDiagnose"
            >
              开始诊断
            </el-button>
          </div>
        </div>
        <div
          v-if="diagnoseResults.length"
          class="row-body"
        >
          <div class="diagnose-grid">
            <div
              v-for="item in diagnoseResults"
              :key="`${item.label}|${item.url}`"
              class="diagnose-item"
            >
              <div class="diagnose-head">
                <span class="diagnose-label">{{ item.label }}</span>
                <el-tag
                  size="small"
                  :type="diagnoseVerdict(item).type"
                >
                  {{ diagnoseVerdict(item).label }}
                </el-tag>
              </div>
              <div class="diagnose-detail">
                {{ item.status === null ? '无响应' : `HTTP ${item.status}` }} · {{ item.ms }}ms
                <span
                  v-if="diagnoseNote(item)"
                  class="diagnose-note"
                >{{ diagnoseNote(item) }}</span>
                <span
                  v-if="item.detail"
                  class="diagnose-note diagnose-note--body"
                >{{ item.detail }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 权利声明 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            style="--tile-color: #909399"
          >
            <el-icon><Document /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              权利声明
            </div>
            <div class="row-desc">
              免责声明与版权归属说明
            </div>
          </div>
        </div>
        <div class="row-body">
          <div class="friend-links">
            <span class="links-label">推荐链接</span>
            <div class="links-grid">
              <a
                v-for="link in friendLinks"
                :key="link.name"
                class="friend-link"
                :href="link.url"
                target="_blank"
                rel="noopener"
              >
                <span class="link-logo icon-tile" :style="{ '--tile-color': link.color }">
                  <svg
                    v-if="link.glyph"
                    class="link-glyph"
                    :viewBox="link.glyphBox || '0 0 24 24'"
                    aria-hidden="true"
                  >
                    <path :d="link.glyph" />
                  </svg>
                  <span v-else class="link-abbr">{{ link.abbr }}</span>
                  <img v-if="link.logo" :src="link.logo" alt="" @error="hideLogo">
                </span>
                <span class="link-meta">
                  <span class="link-name">{{ link.name }}</span>
                  <span class="link-host ellipsis">{{ linkHost(link.url) }}</span>
                </span>
              </a>
            </div>
          </div>
        </div>
        <div class="legal-grid">
          <div class="legal-block">
            <p class="legal-title">
              版权声明
            </p>
            <p class="legal-text">
              所有数据来源于SNH48 官方网站、口袋48 APP 等互联网公开数据，本应用不拥有任何资源的版权。
            </p>
            <p class="legal-text">
              包括且不限于商标、肖像权、音视频版权，均归 SNH48 Group 及其运营方（上海丝芭文化传媒集团有限公司）和其他相关权利人所有。
            </p>
          </div>
          <div class="legal-block">
            <p class="legal-title">
              免责声明
            </p>
            <p class="legal-text">
              本应用不对任何音视频资源的版权合法性承担责任。用户在使用本应用时，应当遵守相关法律法规，不得用于商业用途。
            </p>
            <p class="legal-text">
              任何因使用本应用而产生的版权纠纷或法律责任，均由用户自行承担。本应用不承担任何责任。
            </p>
          </div>
        </div>
      </section>

      <!-- 参考项目致谢 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            style="--tile-color: #909399"
          >
            <el-icon><Document /></el-icon>
          </span>
          <div class="row-text row-text--fluid">
            <div class="row-title">
              参考项目致谢
            </div>
            <div class="row-desc">
              感谢以下项目提供的实现参考
            </div>
          </div>
        </div>
        <div class="row-body">
          <div class="credits-grid">
            <a
              v-for="project in referenceProjects"
              :key="project.name"
              class="credit-link"
              :href="project.url"
              target="_blank"
              rel="noopener"
            >
              <span class="credit-name">{{ project.name }}</span>
              <span class="credit-role ellipsis">{{ project.role }}</span>
            </a>
          </div>
        </div>
      </section>
    </div>

    <!-- 口袋48登录弹窗：短信验证码 / Token 粘贴 两种方式 -->
    <el-dialog
      v-model="loginDialogVisible"
      width="480px"
      align-center
      :close-on-click-modal="false"
      append-to-body
      @opened="focusSmsMobile"
    >
      <template #header>
        <div class="login-head">
          <span class="login-head-icon icon-tile" :style="{ '--tile-color': 'var(--brand-primary)' }">
            <el-icon :size="18"><Lock /></el-icon>
          </span>
          <div class="login-head-text">
            <h3 class="login-head-title">
              登录口袋48账号
            </h3>
            <p class="login-head-sub">
              短信验证码或 Token 均可登录
            </p>
          </div>
        </div>
      </template>
      <div class="login-profile">
        <div class="login-profile-row">
          <el-radio-group
            v-model="loginProfile"
            size="small"
          >
            <el-radio-button
              v-for="option in POCKET_CLIENT_PROFILE_OPTIONS"
              :key="option.id"
              :value="option.id"
            >
              <span class="profile-option">
                <img
                  class="profile-option-logo"
                  :src="profileLogos[option.id]"
                  alt=""
                  @error="hideLogo"
                >
                {{ option.label }}
              </span>
            </el-radio-button>
          </el-radio-group>
        </div>
        <div class="login-profile-hint">
          {{ loginProfileHint }}
        </div>
      </div>
      <el-tabs
        v-model="loginTab"
        class="login-tabs"
      >
        <el-tab-pane
          label="短信验证码"
          name="sms"
        >
          <div class="login-form">
            <div class="login-mobile-row">
              <el-select
                v-model="smsForm.area"
                class="login-area"
                :disabled="smsForm.loggingIn || smsForm.areaLocked"
              >
                <el-option
                  v-for="area in AREA_OPTIONS"
                  :key="area.value"
                  :label="area.label"
                  :value="area.value"
                />
              </el-select>
              <el-input
                ref="smsMobileRef"
                v-model="smsForm.mobile"
                class="login-mobile"
                placeholder="手机号"
                :maxlength="smsForm.area === '86' ? 11 : 15"
                :disabled="smsForm.loggingIn"
              />
            </div>
            <div
              v-if="smsForm.captcha"
              class="login-captcha"
            >
              <div class="captcha-question">
                <el-icon><WarningFilled /></el-icon>
                {{ smsForm.captcha.question }}
              </div>
              <el-radio-group
                v-model="smsForm.captcha.answer"
                class="captcha-options"
              >
                <el-radio
                  v-for="option in smsForm.captcha.options"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </el-radio>
              </el-radio-group>
            </div>
            <div class="login-code-row">
              <el-input
                v-model="smsForm.code"
                placeholder="验证码"
                maxlength="8"
                :disabled="smsForm.loggingIn"
                @keyup.enter="smsLoginable && submitSmsLogin()"
              />
              <el-button
                class="login-code-btn"
                :disabled="!smsSendable || smsForm.countdown > 0 || captchaPending"
                :loading="smsForm.sending"
                @click="sendSmsCode"
              >
                {{ smsForm.countdown > 0 ? `${smsForm.countdown}s` : (smsForm.captcha ? '重新发送' : '发送验证码') }}
              </el-button>
            </div>
            <el-button
              type="primary"
              class="login-submit"
              :disabled="!smsLoginable"
              :loading="smsForm.loggingIn"
              @click="submitSmsLogin"
            >
              登录
            </el-button>
          </div>
        </el-tab-pane>
        <el-tab-pane
          label="Token 粘贴"
          name="token"
        >
          <div class="login-form">
            <el-input
              v-model="tokenForm.token"
              type="textarea"
              :rows="4"
              placeholder="粘贴口袋48 token（抓包或从其他工具获取）"
              class="login-token-input"
            />
            <el-input
              v-model="tokenForm.mobile"
              placeholder="手机号（选填，用于下次登录预填）"
              maxlength="15"
            />
            <el-button
              type="primary"
              class="login-submit"
              :disabled="!tokenLoginable"
              :loading="tokenForm.loggingIn"
              @click="submitTokenLogin"
            >
              登录
            </el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
      <div class="login-hint">
        <el-icon class="login-hint-icon">
          <Lock />
        </el-icon>
        <p>
          凭证仅保存在本机（safeStorage 加密），不会上传。token 由服务端掌控有效期，失效后需重新登录。
        </p>
      </div>
    </el-dialog>

    <!-- 登录状态验证结果：点击已登录头像触发，资料 / 钱包 / 链路状态一屏看完 -->
    <el-dialog
      v-model="verifyDialogVisible"
      :title="verifyFailed ? '登录状态异常' : '登录状态'"
      width="460px"
      append-to-body
      class="verify-dialog"
    >
      <!-- 验证中：主进程依次请求 token 校验 / IM 凭据 / 口袋钱包三个接口 -->
      <div v-if="verifying" class="verify-loading">
        <span class="verify-spinner" />
        <span>正在向口袋48服务端校验登录状态…</span>
      </div>

      <!-- 验证失败：网络异常或服务端判定失效，直接给重新登录入口 -->
      <div v-else-if="verifyFailed" class="verify-fail">
        <el-icon class="verify-fail-icon">
          <WarningFilled />
        </el-icon>
        <p class="verify-fail-message">
          {{ verifyFailedMessage }}
        </p>
        <p class="verify-fail-hint">
          可立即重新登录；若是网络不通，恢复后重试即可。
        </p>
      </div>

      <!-- 验证成功：服务端取回的账号资料卡 -->
      <div v-else-if="verifyResult?.valid" class="verify-card">
        <div class="verify-head">
          <span class="verify-avatar" :class="{ 'has-avatar': !!authAvatarUrl }">
            <img v-if="authAvatarUrl" :src="authAvatarUrl" alt="账号头像">
            <el-icon v-else>
              <User />
            </el-icon>
          </span>
          <div class="verify-idblock">
            <div class="verify-nick">
              {{ verifyResult.nickname || pocketAuthState.nickname || '口袋48用户' }}
              <span v-if="verifyResult.level" class="verify-level">Lv.{{ verifyResult.level }}</span>
            </div>
            <div class="verify-uid">
              ID {{ verifyResult.userId || '—' }}
            </div>
          </div>
        </div>

        <p v-if="verifyResult.signature" class="verify-signature">
          「{{ verifyResult.signature }}」
        </p>

        <div class="verify-stats">
          <div class="verify-stat">
            <div class="stat-value">
              {{ verifyResult.moneyOk ? formatCount(String(verifyResult.moneyTotal)) : '—' }}
            </div>
            <div class="stat-label">
              鸡腿
            </div>
          </div>
          <div class="verify-stat">
            <div class="stat-value">
              {{ verifyResult.support ? formatCount(verifyResult.support) : '—' }}
            </div>
            <div class="stat-label">
              鸡翅
            </div>
          </div>
          <div v-if="verifyResult.fans" class="verify-stat">
            <div class="stat-value">
              {{ formatCount(verifyResult.fans) }}
            </div>
            <div class="stat-label">
              粉丝
            </div>
          </div>
          <div v-if="verifyResult.likes" class="verify-stat">
            <div class="stat-value">
              {{ formatCount(verifyResult.likes) }}
            </div>
            <div class="stat-label">
              获赞
            </div>
          </div>
        </div>

        <div class="verify-links">
          <div class="verify-link">
            <span class="verify-link-name">互动消息</span>
            <span class="verify-link-desc">直播弹幕 / 房间功能 / 签到</span>
            <span class="verify-link-state" :class="verifyResult.imOk ? 'is-ok' : 'is-bad'">
              {{ verifyResult.imOk ? '可用' : '不可用' }}
            </span>
          </div>
        </div>

        <div class="verify-local">
          登录凭证：{{ pocketAuthState.plainFallback ? '明文（当前系统无加密能力）保存' : '本机安全加密保存' }}<template v-if="savedDays > 0">
            ，已保存 {{ savedDays }} 天
          </template>
        </div>
      </div>

      <template #footer>
        <el-button
          v-if="verifyResult?.valid"
          :loading="followSyncing"
          @click="handleSyncFollow"
        >
          拉取关注
        </el-button>
        <el-button @click="verifyDialogVisible = false">
          关闭
        </el-button>
        <el-button
          v-if="verifyFailed"
          type="primary"
          @click="reloginFromVerify"
        >
          重新登录
        </el-button>
      </template>
    </el-dialog>
  </el-scrollbar>
</template>

<style scoped lang="scss">
.setting-root {
  max-width: 880px;
  margin: 0 auto;
  /* 底部留出悬浮 Dock 的高度（--dock-reserve），避免最后一张卡片被遮挡 */
  padding: 20px 24px var(--dock-reserve);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 设置卡片：磨砂玻璃基底见全局 .glass-card */
.setting-card {
  padding: 18px 20px;
  border-radius: var(--radius-lg);
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 渐变主题图标磁贴：骨架见全局 .icon-tile（与底部 Dock 的视觉语言一致），此处仅定尺寸 */
.row-icon {
  width: 44px;
  height: 44px;

  .el-icon {
    font-size: 21px;
  }
}

.row-text {
  flex-shrink: 0;
  width: 180px;

  .row-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  /* 登录身份徽标（如「口袋48身份」或「塞纳河48身份」）：标题行右侧的品牌渐变小药丸，悬停给出选档说明 */
  .row-profile-badge {
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #fff;
    background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
    cursor: default;
  }

  /* 版本号：紧贴标题的次要徽标，等宽数字便于逐位辨读 */
  .row-version {
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    color: var(--el-text-color-secondary);
    background: color-mix(in srgb, var(--el-text-color-secondary) 12%, transparent);
  }

  /* 新版本徽标：标题右侧的告警色小药丸，进入设置页即可察觉有更新 */
  .row-update-badge {
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #fff;
    background: var(--el-color-warning);
  }

  /* available 态的描述加粗切主文字色，与其余状态的中性文案区分 */
  .row-desc.is-update {
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .row-desc {
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--el-text-color-secondary);
  }
}

.row-text--fluid {
  /* 更新行没有中间控件，允许描述用满剩余宽度；普通行仍保持 190px 对齐 */
  flex: 1;
  width: auto;
}

.row-control {
  flex: 1;
  min-width: 200px;
  cursor: pointer;
}

.row-actions {
  flex-shrink: 0;
  /* 屏蔽成员行没有 row-control 占位，auto 外边距保证按钮与其他行一样靠右 */
  margin-left: auto;
  display: flex;
}

/* 卡片正文：与标题行之间用虚线分隔 */
.row-body {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

/* FFmpeg 就绪状态：圆点 + 结论 + 原因说明，broken 态再补一条可直接照做的修复提示 */
.ffmpeg-state {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.ffmpeg-state .state-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.ffmpeg-state.is-ready .state-dot {
  background: var(--el-color-success);
}

.ffmpeg-state.is-broken .state-dot {
  background: var(--el-color-danger);
}

.ffmpeg-state .state-hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.ffmpeg-progress {
  margin-top: 12px;
}

.ffmpeg-progress-label,
.ffmpeg-fix-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

/* 网络诊断结果：两列网格，单格 = 名称 + 徽标 / 状态摘要 + 说明；窄窗自动降为单列 */
.diagnose-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px 14px;
}

.diagnose-item {
  padding: 8px 12px;
  border: 1px dashed var(--el-border-color-lighter);
  border-radius: var(--radius-md);
}

.diagnose-item .diagnose-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.diagnose-item .diagnose-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.diagnose-item .diagnose-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.diagnose-item .diagnose-note {
  display: block;
}

/* 4xx/5xx 响应体摘要：比说明再低一档颜色，长串允许任意折行 */
.diagnose-item .diagnose-note--body {
  margin-top: 2px;
  color: var(--el-text-color-placeholder);
  word-break: break-all;
}

/* 新版本提示块：available 态展开版本对比与更新说明，downloading 态接棒显示进度 */
.update-notice {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--el-color-warning) 8%, transparent);
}

.update-notice-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.update-notice-icon {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--el-color-warning);
}

.update-notice-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.update-notice-versions {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* 更新说明：剥掉 markdown 标记后的纯文本行，告警色小圆点列表 */
.update-notes {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    padding-left: 12px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-regular);
    word-break: break-word;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0.72em;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--el-color-warning);
    }
  }
}

.update-notes-more {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.update-notice-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.update-progress {
  margin-top: 10px;
}

/* 屏蔽名单：队伍色标签（:color 内联样式优先级高，需 !important 覆盖） */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  :deep(.el-tag) {
    color: #fff !important;
    border-color: rgba(255, 255, 255, 0.45) !important;

    .el-tag__close {
      color: #fff;

      &:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.3);
      }
    }
  }
}

/* 屏蔽名单空态：样式见全局 .empty-hint */

/* 权利声明：小字号次要色，低调呈现；两类声明做成响应式双栏卡片 */
.legal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.legal-block {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 4%, transparent);
}

.legal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &::before {
    content: '';
    flex: none;
    width: 3px;
    height: 13px;
    border-radius: 2px;
    background: linear-gradient(180deg, var(--brand-primary-light), var(--brand-primary));
  }
}

.legal-text {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}

.legal-text:last-child {
  margin-bottom: 0;
}

/* 友情链接：logo 卡片网格，悬浮上浮高亮 */
.friend-links {
  .links-label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--el-text-color-secondary);

    &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--el-border-color-lighter);
    }
  }
}

.links-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}

.friend-link {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
    box-shadow: var(--shadow-sm);
    transform: translateY(-2px);

    .link-name {
      color: var(--brand-primary);
    }
  }

  /* 主题色首字磁贴：渐变骨架见全局 .icon-tile；logo 加载失败 / 无 logo 时兜底展示 */
  .link-logo {
    position: relative;
    display: flex;
    width: 38px;
    height: 38px;
    overflow: hidden;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 700;

    /* 中英文短标识都居中且不换行 */
    .link-abbr {
      padding: 0 2px;
      line-height: 1;
      white-space: nowrap;
    }

    /* 内联品牌图标：白色剪影叠在主题色磁贴上，自带轻微投影更像官方 logo */
    .link-glyph {
      width: 22px;
      height: 22px;
      fill: #fff;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.28));
    }

    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #fff;
    }
  }

  .link-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .link-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
    transition: color 0.18s ease;
  }

  .link-host {
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}

/* 参考项目致谢：轻量文字卡，避免和右侧声明区抢视觉 */
.credits-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
}

.credit-link {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
    box-shadow: var(--shadow-sm);
    transform: translateY(-2px);

    .credit-name {
      color: var(--brand-primary);
    }
  }
}

.credit-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  transition: color 0.18s ease;
}

.credit-role {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

/* 品牌渐变主按钮已全局统一，见 app.scss */

/* ===== 口袋48登录弹窗 ===== */
/* 头部：品牌色图标磁贴 + 主副标题，替代默认的单行标题 */
.login-head {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-right: 24px;
}

.login-head-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
}

.login-head-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.login-head-sub {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}

/* 登录身份选择：口袋48 / 塞纳河48 两个官方客户端档位，同一账号可在两端并存 */
.login-profile {
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 4%, transparent);
}

.login-profile-row {
  display: flex;
  gap: 10px;
  align-items: center;

  /* 身份档位分段拉满剩余宽度，两端选项等宽，视觉更稳 */
  :deep(.el-radio-group) {
    flex: 1;
    display: flex;
  }

  :deep(.el-radio-button) {
    flex: 1;

    .el-radio-button__inner {
      width: 100%;
    }
  }
}

.login-profile-label {
  flex: none;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

/* 档位按钮内 APP logo：16px 圆角小图，加载失败自动隐藏只留文字 */
.profile-option {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.profile-option-logo {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  object-fit: contain;
}

.login-profile-hint {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

/* 登录方式 Tab：等宽平分弹窗宽度，视觉重心稳定 */
.login-tabs {
  :deep(.el-tabs__nav) {
    display: flex;
    width: 100%;
  }

  :deep(.el-tabs__item) {
    flex: 1;
    justify-content: center;
    font-size: 14px;
    text-align: center;
  }

  :deep(.el-tabs__nav-wrap::after) {
    background-color: var(--el-border-color-lighter);
  }
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 6px;
}

/* 问答题卡片：服务端反爬（2001），题目 + 单选作答 */
.login-captcha {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 4%, transparent);

  .captcha-question {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--el-text-color-primary);

    .el-icon {
      flex: none;
      font-size: 15px;
      color: var(--el-color-warning);
    }
  }

  .captcha-options {
    display: flex;
    flex-wrap: wrap;
    column-gap: 14px;
  }
}

.login-mobile-row {
  display: flex;
  gap: 8px;

  .login-area {
    flex: 0 0 150px;
  }

  .login-mobile {
    flex: 1;
  }
}

.login-code-row {
  display: flex;
  gap: 8px;

  .login-code-btn {
    flex-shrink: 0;
    /* 固定最小宽度避免 60s 倒计时数字宽度抖动 */
    min-width: 108px;
  }
}

.login-submit {
  width: 100%;
  height: 38px;
  margin-top: 2px;
  font-size: 14px;
  font-weight: 500;
}

.login-token-input {
  :deep(.el-textarea__inner) {
    font-family: var(--el-font-family, monospace);
    font-size: 12px;
    word-break: break-all;
  }
}

.login-hint {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);

  p {
    margin: 0;
  }

  .login-hint-icon {
    flex: none;
    margin-top: 2px;
    font-size: 13px;
    color: var(--el-text-color-placeholder);
  }
}

/* 明文存储降级提示 */
.auth-fallback-tag {
  margin-right: 4px;
}

/* 已登录头像：点击触发登录有效性验证 */
.auth-avatar {
  overflow: hidden;
  border-radius: 50%;

  /* 头像图自带圆形裁切：有图时去掉磁贴渐变底色，避免透明四角露出紫色 */
  &.has-avatar {
    background: transparent;
    box-shadow: none;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }

  &.is-clickable {
    cursor: pointer;
    transition: filter 0.2s;

    &:hover {
      filter: brightness(1.15);
    }
  }

  &.is-verifying {
    cursor: wait;
    filter: grayscale(0.6) brightness(0.85);
  }
}

/* ===== 登录状态验证弹窗 ===== */

/* 验证中：主进程在后台打三个需登录接口，给一个不打扰的等待态 */
.verify-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 30px 0 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.verify-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--brand-primary) 25%, transparent);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: verify-spin 0.9s linear infinite;
}

@keyframes verify-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 验证失败：图标 + 原因 + 一句出路 */
.verify-fail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 6px 8px;
  text-align: center;

  .verify-fail-icon {
    font-size: 40px;
    color: var(--el-color-warning);
  }

  .verify-fail-message {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .verify-fail-hint {
    margin: 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

/* 资料卡头部：大头像 + 昵称 + 等级徽标 + ID */
.verify-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.verify-avatar {
  display: flex;
  width: 56px;
  height: 56px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;

  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
  color: #fff;
  font-size: 24px;

  /* 头像图自带圆形裁切：有图时去掉渐变底色，避免透明四角露出紫色 */
  &.has-avatar {
    background: transparent;
    box-shadow: none;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.verify-idblock {
  min-width: 0;
}

.verify-nick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.verify-level {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
}

.verify-uid {
  margin-top: 3px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* 个性签名：弱底色引用块 */
.verify-signature {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 5%, transparent);
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

/* 统计瓦片：鸡腿 / 鸡翅始终展示，粉丝 / 获赞按服务端返回有无展示 */
.verify-stats {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.verify-stat {
  flex: 1;
  padding: 12px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  text-align: center;

  .stat-value {
    font-size: 17px;
    font-weight: 700;
    color: var(--el-text-color-primary);
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    margin-top: 3px;
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}

/* 功能链路：互动消息是弹幕功能的实际依赖，单独一行给出可用性 */
.verify-links {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.verify-link {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;

  .verify-link-name {
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .verify-link-desc {
    flex: 1;
    color: var(--el-text-color-secondary);
  }

  .verify-link-state {
    font-weight: 600;

    &.is-ok {
      color: var(--el-color-success);
    }

    &.is-bad {
      color: var(--el-color-danger);
    }
  }
}

/* 本地凭证：保存方式与保存时长，佐证「这台机器上的登录态」 */
.verify-local {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}
</style>
