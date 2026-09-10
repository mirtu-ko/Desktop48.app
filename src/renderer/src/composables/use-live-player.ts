import type { Ref } from 'vue'
import { debugLog } from '@renderer/utils/debug'
import mpegts from 'mpegts.js'

/**
 * mpegts 播放器实例管理：
 * 创建/销毁/复位媒体元素，错误经回调上抛给组件编排层。
 * 直播用本地 HTTP-FLV + 追帧配置，低延迟优先。
 */
export function useLivePlayer(options: {
  /** 电台模式返回 audio 元素，普通直播返回 video 元素 */
  getMedia: () => HTMLVideoElement | HTMLAudioElement | null
  isRadio: () => boolean
  isDisposed: () => boolean
  mediaLoading: Ref<boolean>
  /** canplay：加载完成（组件在此复位恢复态、刷新视频尺寸） */
  onCanPlay: () => void
  /** loadedmetadata：仅非电台模式挂载，用于刷新视频尺寸 */
  onLoadedMetadata: () => void
  /**
   * 错误上抛。isNetwork=true 表示 mpegts 网络错误
   * （调用方保持 loading 并进入重试）；false 为致命错误
   * （调用方销毁播放器后再重试）。
   */
  onError: (reason: string, isNetwork: boolean) => void
}) {
  let player: ReturnType<typeof mpegts.createPlayer> | null = null

  function destroyPlayer() {
    if (player) {
      player.destroy()
      player = null
    }
  }

  function hasPlayer() {
    return player !== null
  }

  function play() {
    if (!player)
      return
    void Promise.resolve(player.play()).catch((error) => {
      console.error('[use-live-player] 播放失败:', error)
    })
  }

  /** 清空媒体元素并解除事件绑定，供重建/卸载时复位 */
  function resetMediaElement() {
    const mediaElement = options.getMedia()
    if (!mediaElement)
      return
    mediaElement.pause()
    mediaElement.removeAttribute('src')
    mediaElement.load()
    mediaElement.onerror = null
    mediaElement.oncanplay = null
    mediaElement.onended = null
  }

  /**
   * 按本地 FLV 地址创建并挂载 mpegts 播放器。
   * @returns false 表示当前环境不支持 HTTP-FLV（调用方负责提示用户）
   */
  function setupPlayer(path: string): boolean {
    const mediaElement = options.getMedia()
    if (!mediaElement || !path)
      return true

    // 播放地址变化时，销毁旧实例并按最新本地 FLV 地址重新挂载。
    destroyPlayer()

    if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
      options.mediaLoading.value = false
      return false
    }

    const created = mpegts.createPlayer({
      type: 'flv',
      isLive: true,
      cors: true,
      withCredentials: false,
      url: path,
    }, {
      enableWorker: true,
      enableStashBuffer: false,
      isLive: true,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      liveSync: true,
      liveSyncMaxLatency: 1.2,
      liveSyncTargetLatency: 0.6,
      liveSyncPlaybackRate: 1.2,
    })

    player = created
    created.attachMediaElement(mediaElement)
    created.load()
    play()
    debugLog('live', `mpegts 播放器已挂载: ${path}`)

    mediaElement.oncanplay = () => {
      debugLog('live', '媒体可播放（canplay）')
      options.mediaLoading.value = false
      options.onCanPlay()
    }

    if (!options.isRadio())
      mediaElement.onloadedmetadata = () => options.onLoadedMetadata()

    mediaElement.onerror = () => {
      options.onError('native media error', false)
    }

    // 上游推流中断（如主播开始/停止连麦导致 RTMP 签名地址失效）→ 主进程 FFmpeg 退出 →
    // 本地 FLV 响应结束。响应没有 Content-Length，mpegts 判为「下载完成」而非 Early-EOF，
    // **不发 ERROR**；它随后 endOfStream 并把时长校正到最后一段，浏览器播完缓冲即触发 ended
    // （状态转为暂停，此时再调 play() 也无法继续）。
    // 直播流正常播放时永远不会 ended，故此处一律按网络错误上抛，交由重试重建。
    // ⚠️ 不要改用 mpegts 的 LOADING_COMPLETE：enableWorker 下 worker 回传的包只有
    // { msg, event }、不带 extraData，主线程按 `'extraData' in packet` 判断后直接丢弃。
    mediaElement.onended = () => {
      if (player !== created)
        return

      debugLog('live', '媒体流已结束（上游推流中断），按网络错误处理并重建')
      options.onError('media ended', true)
    }

    created.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
      if (options.isDisposed()) {
        created.destroy()
        if (player === created)
          player = null
        return
      }

      console.error('[use-live-player] HTTP-FLV 错误:', errorType, errorDetail, errorInfo)
      if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
        options.mediaLoading.value = true
        options.onError(`${errorType}:${errorDetail}`, true)
        return
      }

      options.onError(`${errorType}:${errorDetail}`, false)
    })

    return true
  }

  return { setupPlayer, destroyPlayer, resetMediaElement, hasPlayer, play }
}
