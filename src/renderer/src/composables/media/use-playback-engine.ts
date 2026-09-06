import Hls from 'hls.js'
import { ref } from 'vue'
import { debugLog } from '../../utils/debug'

interface PlaybackEngineOptions {
  /** 当前应挂载播放源的媒体元素（视频/音频由组件决定），无元素时 attach 直接忽略 */
  getMediaElement: () => HTMLMediaElement | null
  /** 组件管理的全部媒体元素：destroy 时统一复位（电台模式切换会同时存在过 video/audio 引用） */
  getManagedElements: () => Array<HTMLMediaElement | null>
  /** 进度更新：组件据此推进弹幕游标 */
  onTimeUpdate: (_time: number) => void
  /** 原生 seeking：小幅拖动也能识别，组件重建弹幕游标 */
  onSeeking: (_time: number) => void
  /** 元数据就绪：组件记录时长/源尺寸、加载弹幕；引擎随后自动播放 */
  onMetadataLoaded: (_media: HTMLMediaElement) => void | Promise<void>
  /** 开始播放（如获取防休眠） */
  onPlaying?: () => void
  /** 暂停或播完（如释放防休眠） */
  onIdle?: () => void
}

/**
 * 录播（VOD）播放引擎：按地址选择 HLS 或原生 MP4 播放，
 * 维护「加载中 / 缓冲中 / 出错」三态，媒体事件全部经 onXxx 回调交还组件做业务处理。
 * LivePlayer 的直播走 mpegts 低延迟链路，不经过这里。
 */
export function usePlaybackEngine(options: PlaybackEngineOptions) {
  const {
    getMediaElement,
    getManagedElements,
    onTimeUpdate,
    onSeeking,
    onMetadataLoaded,
    onPlaying,
    onIdle,
  } = options

  const loading = ref(true)
  const buffering = ref(false)
  const error = ref('')

  let hlsInstance: Hls | null = null

  function resetMediaElement(mediaElement: HTMLMediaElement | null) {
    if (!mediaElement)
      return

    mediaElement.pause()
    mediaElement.removeAttribute('src')
    mediaElement.load()
    mediaElement.ontimeupdate = null
    mediaElement.onseeking = null
    mediaElement.onloadedmetadata = null
    mediaElement.onerror = null
    mediaElement.onwaiting = null
    mediaElement.onplaying = null
    mediaElement.onpause = null
    mediaElement.onended = null
  }

  function destroy() {
    if (hlsInstance) {
      debugLog('playback', '销毁 hls.js 实例')
      hlsInstance.destroy()
      hlsInstance = null
    }

    for (const mediaElement of getManagedElements())
      resetMediaElement(mediaElement)
  }

  /** 同一错误只上报一次，避免重复错误事件刷屏 */
  function notifyError(message: string) {
    if (error.value === message)
      return

    error.value = message
    loading.value = false
    buffering.value = false
  }

  function attemptAutoplay(mediaElement: HTMLMediaElement) {
    void Promise.resolve(mediaElement.play()).catch((err) => {
      console.error('[use-playback-engine] 自动播放失败:', err)
    })
  }

  function bindMediaEvents(mediaElement: HTMLMediaElement) {
    mediaElement.ontimeupdate = () => {
      onTimeUpdate(mediaElement.currentTime)
    }

    mediaElement.onseeking = () => {
      onSeeking(mediaElement.currentTime)
    }

    mediaElement.onloadedmetadata = async () => {
      debugLog('playback', '元数据就绪（loadedmetadata），退出加载态并自动播放')
      error.value = ''
      loading.value = false
      await onMetadataLoaded(mediaElement)
      attemptAutoplay(mediaElement)
    }

    mediaElement.onwaiting = () => {
      buffering.value = true
    }

    mediaElement.onplaying = () => {
      buffering.value = false
      loading.value = false
      onPlaying?.()
    }

    mediaElement.onpause = () => onIdle?.()
    mediaElement.onended = () => onIdle?.()

    mediaElement.onerror = () => {
      console.error('[use-playback-engine] 录播播放失败:', mediaElement.currentSrc)
      notifyError('录播播放失败，请稍后重试或检查播放地址是否有效')
    }
  }

  // 录播是 VOD 场景，保留 HLS 最合适；如果是 MP4 则直接交给原生 video。
  function attach(sourcePath: string) {
    const mediaElement = getMediaElement()
    if (!mediaElement)
      return

    destroy()
    error.value = ''
    loading.value = true

    if (sourcePath.endsWith('.m3u8')) {
      debugLog('playback', `引擎选择: ${sourcePath} 是 HLS → 优先 hls.js 引擎（原生 video 不支持直播切片级控制）`)
      if (Hls.isSupported()) {
        const hls = new Hls()
        hlsInstance = hls
        hls.loadSource(sourcePath)
        hls.attachMedia(mediaElement)
        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.error('[use-playback-engine] HLS 录播播放失败:', data)

          if (!data.fatal)
            return

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            notifyError('录播加载失败，播放地址可能已失效或网络不可用')
          }
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            notifyError('录播播放失败，媒体内容可能已损坏或编码不受支持')
          }
          else {
            notifyError('录播播放失败，请稍后重试')
          }
        })
      }
      else if (mediaElement.canPlayType('application/vnd.apple.mpegurl')) {
        debugLog('playback', '引擎选择: hls.js 不受支持，回落到 Safari 原生 HLS（canPlayType 命中）')
        mediaElement.src = sourcePath
      }
      else {
        debugLog('playback', '引擎选择: hls.js 与原生 HLS 均不可用，无法播放')
        notifyError('当前环境不支持录播 HLS 播放')
        return
      }
    }
    else {
      debugLog('playback', `引擎选择: ${sourcePath} 非 m3u8 → 原生 video 直接播放（MP4 无需 hls.js）`)
      mediaElement.src = sourcePath
      mediaElement.load()
    }

    bindMediaEvents(mediaElement)
    attemptAutoplay(mediaElement)
  }

  return { loading, buffering, error, attach, destroy }
}
