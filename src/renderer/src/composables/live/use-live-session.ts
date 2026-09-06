import type { Ref } from 'vue'
import type { LiveDetail } from '../../services/api-types'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'
import Apis from '../../services/apis'
import { debugLog } from '../../utils/debug'
import {
  buildPlaybackUrl,
  normalizeCarouselTime,
  pickPreferredStream,
  resolveCarouselImages,
} from '../../utils/live-stream'
import Tools from '../../utils/tools'

/** 直播详情形状统一在 services/api-types.ts 建模 */
export type { LiveDetail }

/**
 * 直播会话：直播详情获取 + 本地 HTTP-FLV 会话生命周期（创建/停止/重启）。
 *
 * 只管「拿地址、开会话」，不管播放器实例与重试节奏：
 * 播放器在 use-live-player，重试在 use-stream-retry，三者由 LivePlayer.vue 编排。
 *
 * 两个方向相反的「地址」不要搞混：
 * - 入参 / LiveDetail.playStreamPath = rtmp://...      远程源，喂给主进程的 FFmpeg
 * - 出参 localPlaybackUrl            = http://127.0.0.1 本地地址，喂给 mpegts 播放器
 *
 * 完整链路见 docs/播放链路.md
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
  /** 详情携带的在线人数上抛（归 use-live-polling 所有） */
  onOnlineNum: (num: number) => void
  /** 详情获取失败（通常直播已下架）：列表刷新 + 关闭浮窗 */
  onUnavailable: () => void
  /** 每次重建流之前调用：组件在此销毁播放器/复位媒体元素/清重试计时器 */
  onBeforeRebuild: () => void
  /** 会话启动（getOne 开始）时调用：组件在此复位重试计数与 loading 态 */
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
  /** 电台轮播图与切换间隔（毫秒） */
  const carousels = ref<string[]>([])
  const carouselTime = ref(5000)

  // 递增令牌：每次重启换新 id，旧会话的异步回包凭 id 失效
  let activeStreamRequestId = 0

  /** 直播详情与界面状态同步，不直接处理播放器 */
  function applyLiveDetail(data: LiveDetail) {
    coverImage.value = Tools.sourceUrl(data.coverPath)
    carousels.value = resolveCarouselImages(
      options.isRadio(),
      data.carousels?.carousels,
      data.coverPath,
      url => Tools.sourceUrl(url),
    )
    carouselTime.value = normalizeCarouselTime(data.carousels?.carouselTime)
    realName.value = data.user.userName
    // 头像：优先调用方传入（open 公演为封面），否则取详情的主播头像；open 模式无在线人数
    userAvatar.value = Tools.sourceUrl(options.avatarUrl() || data.user.userAvatar || '')
    options.onAvatar(userAvatar.value)
    if (typeof data.onlineNum === 'number')
      options.onOnlineNum(data.onlineNum)
  }

  /**
   * 取直播详情，把两个上游接口抹平成同一个 LiveDetail 形状，
   * 后续代码不必再区分公演 / 个人直播。
   * 返回值里的 playStreamPath 是**远程 rtmp 地址**（不是本地播放地址）。
   */
  async function fetchLiveDetail(): Promise<LiveDetail> {
    if (options.source() === 'open') {
      // 开放公演：getOpenLiveOne 返回 playStreams 数组（多档清晰度），选高清（streamType 2）；
      // 该接口没有主播信息，用副标题/标题兜底成 user.userName 以满足 LiveDetail 契约
      debugLog('live', '②拉详情: source=open → 走 openLive 接口（公演详情为多档清晰度数组，需选流）')
      const data = await Apis.instance().openLive(options.liveId())
      const stream = pickPreferredStream(data.playStreams)
      debugLog('live', `②拉详情: 公演选流 → streamType=${stream?.streamType || '无'}（优先高清 2，回落任意有地址的流）`)
      return {
        playStreamPath: stream?.streamPath || '',
        coverPath: data.coverPath || '',
        user: { userName: data.subTitle || data.title || '开放公演', userAvatar: '' },
        liveId: data.liveId,
      }
    }
    debugLog('live', '②拉详情: source=user → 走 getLiveOne 接口（单档 rtmp 地址）')
    return await Apis.instance().live(options.liveId())
  }

  /** 停掉当前会话并等待主进程确认（重建流之前调用，确保旧 FFmpeg 已退出） */
  async function stopCurrentLiveStream() {
    const currentLiveId = activeSessionLiveId.value
    if (!currentLiveId)
      return
    activeSessionLiveId.value = ''
    debugLog('live', `停止当前直播会话: ${currentLiveId}`)
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
    // 这条链路不经过 Apis.request，没有统一兜底弹窗
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
      debugLog('live', `会话回包已过期（liveId=${result.liveId || options.liveId()}），撤销刚登记的会话`)
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
    debugLog('live', `本地播放地址已就绪: ${localPlaybackUrl.value}`)
    return true
  }

  /**
   * 首次进入 / 重试恢复：按最新 RTMP 地址重建本地 HTTP-FLV 会话。
   * @param rtmpUrl 远程源地址（来自 LiveDetail.playStreamPath）
   */
  async function restartLiveStream(rtmpUrl: string) {
    const requestId = ++activeStreamRequestId
    debugLog('live', `重建直播流（第 ${streamRestartToken.value + 1} 次）, rtmp=${rtmpUrl}`)
    options.onBeforeRebuild()
    await stopCurrentLiveStream()
    if (options.isDisposed.value || requestId !== activeStreamRequestId)
      return false
    streamRestartToken.value++
    return await startLiveStream(rtmpUrl, requestId)
  }

  /**
   * 会话入口：拉详情 → 同步界面 → 开本地转流会话。
   * 详情都取不到通常意味着直播已下架，走 onUnavailable 关窗。
   */
  async function getOne() {
    options.onSessionStart()
    try {
      const data = await fetchLiveDetail()
      if (options.isDisposed.value)
        return
      applyLiveDetail(data)
      await restartLiveStream(data.playStreamPath)
    }
    catch (error: any) {
      console.error('getOne()', error)
      // 详情失败的原因已由 Apis.request 统一弹窗提示（不在这里重复弹）；
      // 详情都取不到通常意味着直播已下架，走下架处理
      options.onUnavailable()
    }
  }

  /** 重试耗尽 / 组件卸载时：停止当前流并清空会话 */
  function stopStreamNow() {
    const currentLiveId = activeSessionLiveId.value
    if (!currentLiveId)
      return
    activeSessionLiveId.value = ''
    debugLog('live', `最终停流: ${currentLiveId}（重试耗尽或组件卸载）`)
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
    activeSessionLiveId,
    streamRestartToken,
    coverImage,
    realName,
    userAvatar,
    carousels,
    carouselTime,
    fetchLiveDetail,
    applyLiveDetail,
    getOne,
    restartLiveStream,
    stopCurrentLiveStream,
    stopStreamNow,
    dispose,
  }
}
