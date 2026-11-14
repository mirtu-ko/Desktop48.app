import type { LiveDetailView } from '@renderer/services/live-detail'
import type { Ref } from 'vue'
import { loadLiveDetail } from '@renderer/services/live-detail'
import { ensurePocketAuthState, pocketAuthState } from '@renderer/stores/pocket-auth'
import { debugLog } from '@renderer/utils/debug'
import {
  buildPlaybackUrl,
  isEndedLiveDetail,
  isLiveEndedMessage,
  isLiveRemovedMessage,
  resolveCarouselImages,
} from '@renderer/utils/live-stream'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { ref, watch } from 'vue'

/**
 * 直播会话：直播详情获取 + 本地 HTTP-FLV 会话生命周期（创建/停止/重启）。
 *
 * 只管「拿地址、开会话」，不管播放器实例与重试节奏：
 * 播放器在 use-live-player，重试在 use-stream-retry，三者由 LivePlayer.vue 编排。
 *
 * 两个方向相反的「地址」不要搞混：
 * - 入参 / LiveDetailView.playStreamPath = rtmp://...   远程源，喂给主进程的 FFmpeg
 * - 出参 localPlaybackUrl            = http://127.0.0.1 本地地址，喂给 mpegts 播放器
 *
 * 完整链路见 docs/live-playback-pipeline.md
 */
export function useLiveSession(options: {
  liveId: () => string
  /** 数据源：user=用户直播(getLiveOne)，open=开放公演(getOpenLiveOne) */
  source: () => string
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatarUrl: () => string
  isRadio: () => boolean
  /** 卸载标记：置位后一切异步回包直接丢弃 */
  isDisposed: Ref<boolean>
  /** 头像上报给浮窗头部（fp-bar）展示 */
  onAvatar: (avatarUrl: string) => void
  /** 详情携带的在线人数上抛（首帧；实时值走 IM LIVEUPDATE 推送） */
  onOnlineNum: (num: number) => void
  /** 详情确认本场已下播：by=详情转回放 / 业务文案「回放生成中」，宿主进下播结束卡 */
  onEnded: (by: 'detail' | 'error') => void
  /** 直播已被删除/下架：列表刷新 + 关闭浮窗 */
  onUnavailable: () => void
  /** 详情临时失败（网络异常等）：宿主进加载失败卡，不再静默转圈 */
  onSessionError: (error: unknown) => void
  /** 每次重建流之前调用：组件在此销毁播放器/复位媒体元素/清重试计时器 */
  onBeforeRebuild: () => void
  /** 会话启动（getLiveOne 开始）时调用：组件在此复位重试计数与 loading 态 */
  onSessionStart: () => void
}) {
  /** 本地 HTTP-FLV 播放地址（http://127.0.0.1:<port>/live/xxx.flv?t=&r=），播放器的唯一数据源 */
  const localPlaybackUrl = ref('')
  /** 当前已在主进程注册的会话标识（值即 liveId）；空串表示当前无会话 */
  const activeSessionLiveId = ref('')
  /** 流重启序号：拼进播放地址，防止同 URL 复用旧连接 */
  const streamRestartToken = ref(0)
  const coverImage = ref('')
  const realName = ref('')
  const userAvatar = ref('')
  /** 口袋聊天室 ID（getLiveOne 详情携带）：口袋互动弹幕的会话锚点；空串 = 无（公演/回放/已结束） */
  const chatroomId = ref('')
  /** 房主 userId（getLiveOne 详情携带）：禁言/拉黑通知门控比对管理员操作者用；换场必须清空防串场 */
  const ownerUserId = ref('')
  /** 当前会话在用的远程 RTMP 地址：换流信号时比对用（连麦时地址主体不变、token 变） */
  const activeRtmpUrl = ref('')
  /** 电台轮播图与切换间隔（毫秒） */
  const carousels = ref<string[]>([])
  const carouselTime = ref(5000)

  // 递增令牌：每次重启换新 id，旧会话的异步回包凭 id 失效
  let activeStreamRequestId = 0

  /** 直播详情与界面状态同步，不直接处理播放器 */
  function applyLiveDetail(view: LiveDetailView) {
    coverImage.value = view.coverUrl
    chatroomId.value = view.chatroomId || ''
    ownerUserId.value = view.ownerUserId || ''
    // 电台无轮播图时回退封面单张展示（live-stream.ts 内 resolveCarouselImages 的既定契约）
    carousels.value = resolveCarouselImages(
      options.isRadio(),
      view.carouselImages,
      view.coverUrl,
      url => Tools.sourceUrl(url),
    )
    carouselTime.value = view.carouselTime
    realName.value = view.realName
    userAvatar.value = view.userAvatar
    options.onAvatar(userAvatar.value)
    // 上游未带在线人数时不回调（open 公演接口恒不带）
    if (view.onlineNum !== undefined)
      options.onOnlineNum(view.onlineNum)
  }

  /**
   * 取直播详情并归一成 LiveDetailView（open 走公演接口，user 走个人直播接口）。
   * 返回值里的 playStreamPath 是**远程 rtmp 地址**（不是本地播放地址）。
   * 异常原样上抛：业务错误由调用方判别后关窗或进下播结束态。
   * fetchOptions.silent = 后台轮询（游客刷在线人数）用，失败不弹统一提示。
   */
  async function fetchLiveDetail(fetchOptions?: { silent?: boolean }): Promise<LiveDetailView> {
    const source = options.source() === 'open' ? 'open' : 'user'
    debugLog('live', `②拉详情: source=${source} → ${source === 'open' ? 'openLive 接口（多档清晰度数组，需选流）' : 'getLiveOne 接口（单档 rtmp 地址）'}`, `liveId=${options.liveId()}`)
    const view = await loadLiveDetail({
      liveId: options.liveId(),
      source,
      stream: 'live',
      avatarUrl: options.avatarUrl(),
      silent: fetchOptions?.silent,
    })
    debugLog('live', `②拉详情: 归一结果 streamType=${view.streamType ?? '单档'} cover=${view.coverUrl ? '有' : '无'}`, view)
    return view
  }

  /**
   * 补拉聊天室 ID（口袋互动弹幕的会话锚点）。
   * 渲染层 getLiveOne 不带登录 token，服务端不返回 chatroomId（roomId 恒 0），
   * 所以详情归一后必须用主进程带 token 的接口再取一次；未登录返回空串（登录后由 watch 重试）。
   */
  async function refreshChatroomId() {
    if (options.source() === 'open')
      return
    const liveId = options.liveId()
    if (!liveId || options.isDisposed.value)
      return
    // 触发登录态镜像初始化：未登录时主进程返回空串，等真实登录态到达后由下方 watch 重试
    ensurePocketAuthState()
    try {
      const id = await window.mainAPI.pocketGetChatroomId(liveId)
      if (id && !options.isDisposed.value && liveId === options.liveId())
        chatroomId.value = id
    }
    catch (error) {
      debugLog('live', '口袋聊天室 ID 获取失败:', error)
    }
  }

  // 登录态晚于直播打开（浮窗冷启动 + 异步读凭证）时，登录一到手立即补拉
  watch(() => pocketAuthState.value.loggedIn, (loggedIn) => {
    if (loggedIn)
      void refreshChatroomId()
  })

  /** 停掉当前会话并等待主进程确认（重建流之前调用，确保旧 FFmpeg 已退出） */
  async function stopCurrentLiveStream() {
    const currentLiveId = activeSessionLiveId.value
    if (!currentLiveId)
      return
    activeSessionLiveId.value = ''
    debugLog('live', `session 停止当前直播会话: ${currentLiveId}`)
    try {
      // ★ 跨进程：preload/index.ts → main/stream.ts 的 'stopLiveStream' handler
      await window.mainAPI.stopLiveStream(currentLiveId)
    }
    catch (err) {
      console.error('停止直播流失败:', err)
    }
  }

  async function startLiveStream(rtmpUrl: string, requestId: number) {
    // 主进程失败（如本地流媒体服务端口全部被占用）在这里显式提示：
    // 这条链路不经过 apis.ts 的 request()，没有统一兜底弹窗
    let result
    try {
      // ★ 跨进程：preload/index.ts → main/stream.ts 的 'createLiveStream' handler。
      // 主进程只登记 { liveId → rtmpUrl } 并返回本地地址，此时 FFmpeg 尚未启动；
      // 真正 spawn 发生在播放器 GET 这个地址时（见 main/http-server.ts）
      result = await window.mainAPI.createLiveStream(rtmpUrl, options.liveId())
    }
    catch (err: any) {
      ElMessage.error(err?.message || '创建直播流失败')
      throw err
    }

    // 等待期间组件已卸载 / 又发起了更新的一次重启：本次结果作废，顺手把刚登记的会话撤掉
    if (options.isDisposed.value || requestId !== activeStreamRequestId) {
      debugLog('live', `session 会话回包已过期（liveId=${result.liveId || options.liveId()}），撤销刚登记的会话`)
      try {
        // ★ 跨进程：preload/index.ts → main/stream.ts 的 'stopLiveStream' handler
        await window.mainAPI.stopLiveStream(result.liveId || options.liveId())
      }
      catch (err) {
        console.error('关闭过期直播流失败:', err)
      }
      return false
    }

    activeSessionLiveId.value = result.liveId
    // 写入即触发 LivePlayer 里的 watch，由它重建 mpegts 播放器
    localPlaybackUrl.value = buildPlaybackUrl(result.url, streamRestartToken.value)
    debugLog('live', `session 本地播放地址已就绪: ${localPlaybackUrl.value}`)
    return true
  }

  /**
   * 首次进入 / 重试恢复：按最新 RTMP 地址重建本地 HTTP-FLV 会话。
   */
  async function restartLiveStream(rtmpUrl: string) {
    const requestId = ++activeStreamRequestId
    debugLog('live', `session 重建直播流（第 ${streamRestartToken.value + 1} 次）, rtmp=${rtmpUrl}`)
    activeRtmpUrl.value = rtmpUrl
    options.onBeforeRebuild()
    await stopCurrentLiveStream()
    if (options.isDisposed.value || requestId !== activeStreamRequestId)
      return false
    streamRestartToken.value++
    return await startLiveStream(rtmpUrl, requestId)
  }

  /**
   * 会话入口：拉详情 → 同步界面 → 开本地转流会话。
   * 失败按业务文案分流（下播 / 下架），其余临时故障交给宿主显示加载失败卡。
   */
  async function getLiveOne() {
    options.onSessionStart()
    try {
      const data = await fetchLiveDetail()
      debugLog('live', `②拉详情: 直播详情 -> data`, data)
      if (options.isDisposed.value)
        return
      // 详情已转回放态说明本场下播：不能把 VOD 地址喂给直播转流会话
      if (isEndedLiveDetail(data, options.source())) {
        options.onEnded('detail')
        return
      }
      applyLiveDetail(data)
      void refreshChatroomId()
      await restartLiveStream(data.playStreamPath)
    }
    catch (error: any) {
      console.error('getLiveOne()', error)
      // 临时故障不关窗；「回放生成中」是本场刚下播（request() 也不为它弹提示），走结束卡。
      // 其余业务错误由 apis.ts 的 request() 统一弹窗，这里不重复弹。
      if (error instanceof Error && isLiveEndedMessage(error.message))
        options.onEnded('error')
      else if (error instanceof Error && isLiveRemovedMessage(error.message))
        options.onUnavailable()
      else
        options.onSessionError(error)
    }
  }

  /** 重试耗尽 / 组件卸载时：停止当前流并清空会话 */
  function stopStreamNow() {
    const currentLiveId = activeSessionLiveId.value
    if (!currentLiveId)
      return
    activeSessionLiveId.value = ''
    debugLog('live', `session 最终停流: ${currentLiveId}（重试耗尽或组件卸载）`)
    // ★ 跨进程：preload/index.ts → main/stream.ts 的 'stopLiveStream' handler。
    // 卸载路径上不 await：调用方（onUnmounted）是同步的，失败只记日志
    window.mainAPI.stopLiveStream(currentLiveId).catch((err) => {
      console.error('停止直播流失败:', err)
    })
  }

  /** 组件卸载：置位 disposed、令牌失效、停流。后续所有异步回包都会被丢弃 */
  function dispose() {
    options.isDisposed.value = true
    activeStreamRequestId++
    stopStreamNow()
  }

  return {
    localPlaybackUrl,
    coverImage,
    realName,
    carousels,
    carouselTime,
    chatroomId,
    ownerUserId,
    activeRtmpUrl,
    fetchLiveDetail,
    applyLiveDetail,
    getLiveOne,
    restartLiveStream,
    stopStreamNow,
    dispose,
  }
}
