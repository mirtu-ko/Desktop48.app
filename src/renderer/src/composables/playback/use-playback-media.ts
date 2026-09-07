import type { Ref } from 'vue'
import { nextTick, ref, watch } from 'vue'
import { usePlaybackEngine } from '../media/use-playback-engine'

/**
 * 录播媒体编排：
 * usePlaybackEngine 的业务接线 + retryPlayback + 播放地址变化的挂载 watch。
 * 引擎维护「加载中 / 缓冲中 / 出错」三态，媒体事件经回调交还调用方做业务处理。
 */
export function usePlaybackMedia(options: {
  playStreamPath: Ref<string>
  /** 当前应挂载播放源的媒体元素（电台模式切换后是 audio，否则 video） */
  getMediaElement: () => HTMLMediaElement | null
  /** 组件管理的全部媒体元素：destroy 时统一复位 */
  getManagedElements: () => Array<HTMLMediaElement | null>
  /** 进度更新（弹幕游标推进的唯一入口） */
  onTimeUpdate: (time: number) => void
  /** 原生 seeking：弹幕游标重建 */
  onSeeking: (time: number) => void
  /** 元数据就绪（时长已记录）：刷新源尺寸/上报比例、加载弹幕等组件侧事务 */
  onMetadataLoaded: (media: HTMLMediaElement) => void | Promise<void>
  /** 开始播放（如获取防休眠） */
  onPlaying: () => void
  /** 暂停或播完（如释放防休眠） */
  onIdle: () => void
}) {
  // 源时长：MiniControls 进度条的分母
  const mediaDuration = ref(0)

  const engine = usePlaybackEngine({
    getMediaElement: options.getMediaElement,
    getManagedElements: options.getManagedElements,
    onTimeUpdate: options.onTimeUpdate,
    onSeeking: options.onSeeking,
    onMetadataLoaded: async (media) => {
      mediaDuration.value = media.duration || 0
      await options.onMetadataLoaded(media)
    },
    onPlaying: options.onPlaying,
    onIdle: options.onIdle,
  })

  // 播放地址变化即挂载播放源；组件卸载时该 watch 随作用域自动停止
  watch(
    () => options.playStreamPath.value,
    async (newPath) => {
      if (!newPath)
        return

      // 电台录播会在 isRadio 切换后把 <video> 替换成 <audio>，
      // 这里等一轮 DOM 更新，确保拿到正确的媒体节点再挂载播放源。
      await nextTick()
      engine.attach(newPath)
    },
    { flush: 'post' },
  )

  /** 出错遮罩上的「重试」：按当前地址重新挂载 */
  function retryPlayback() {
    if (!options.playStreamPath.value)
      return
    engine.attach(options.playStreamPath.value)
  }

  return {
    mediaLoading: engine.loading,
    mediaBuffering: engine.buffering,
    lastPlaybackError: engine.error,
    mediaDuration,
    attach: engine.attach,
    destroy: engine.destroy,
    retryPlayback,
  }
}
