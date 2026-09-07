import type { ComputedRef, Ref } from 'vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

interface UseVideoRotationOptions {
  /** 视频容器（全屏作用在它上面，浮层才不会丢） */
  videoBoxRef: Ref<HTMLElement | null>
  /** 当前媒体元素（video/audio 二选一，随电台模式切换） */
  getMedia: () => HTMLMediaElement | null
  /** 当前媒体 video 元素（仅监听其尺寸变化） */
  getVideo: () => HTMLVideoElement | null
  /** 电台模式：旋转/缩放/aspect 上报均跳过 */
  isRadio: Ref<boolean> | ComputedRef<boolean>
  /** 画面实际显示宽高比变化时上报（含旋转后的宽高交换），浮窗据此自动定形 */
  onAspect: (_aspect: number) => void
}

/**
 * 画面旋转 + 容器全屏 + 迷你控制条状态，供 LivePlayer / PlaybackPlayer 共用。
 * 旋转作用于 video wrapper，不参与旋转的浮层（弹幕等）由组件自己保证同级不旋转。
 */
export function useVideoRotation(options: UseVideoRotationOptions) {
  const { videoBoxRef, getMedia, getVideo, isRadio, onAspect } = options

  const rotationAngle = ref(0)
  // 渲染角度：与 rotationAngle 语义一致（0° = 原方向），但允许跨 0° 连续累加，
  // 专用于 transform，让动画永远走 [-180°, 180°) 内的最短路径，
  // 避免「0° 左转」先归一化到 270° 再让 CSS 绕 270° 一大圈。
  const renderAngle = ref(0)
  const videoWidth = ref(0)
  const videoHeight = ref(0)
  const boxDimensions = ref({ width: 0, height: 0 })

  const isVerticalRotation = computed(() => {
    const normalizedAngle = ((rotationAngle.value % 360) + 360) % 360
    return normalizedAngle === 90 || normalizedAngle === 270
  })

  // 旋转 90/270 度时，视频显示宽高会交换，这里单独计算一个缩放系数，
  // 保证旋转后的画面仍然完整落在容器内。
  function calculateRotationScale() {
    if (!isVerticalRotation.value)
      return 1

    const boxWidth = boxDimensions.value.width || videoBoxRef.value?.clientWidth || 0
    const boxHeight = boxDimensions.value.height || videoBoxRef.value?.clientHeight || 0
    const sourceWidth = videoWidth.value
    const sourceHeight = videoHeight.value

    if (boxWidth <= 0 || boxHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0)
      return 1

    const videoRatio = sourceWidth / sourceHeight
    const boxRatio = boxWidth / boxHeight
    let renderedWidth = 0
    let renderedHeight = 0

    if (videoRatio < boxRatio) {
      renderedHeight = boxHeight
      renderedWidth = renderedHeight * videoRatio
    }
    else {
      renderedWidth = boxWidth
      renderedHeight = renderedWidth / videoRatio
    }

    return Math.min(boxWidth / renderedHeight, boxHeight / renderedWidth)
  }

  const videoWrapperStyle = computed(() => {
    const angle = renderAngle.value
    const scale = calculateRotationScale()

    return {
      transform: `rotate(${angle}deg) scale(${scale})`,
    }
  })

  const videoStyle = computed(() => {
    if (isVerticalRotation.value) {
      return {
        maxWidth: '100%',
        maxHeight: '100%',
        width: 'auto',
        height: 'auto',
      }
    }

    return {}
  })

  // 旋转是一组连续状态，界面上只暴露一个控件，所以每次变更都给一条短暂提示，
  // 避免用户转完就忘了自己停在第几个 90°
  const rotateHint = ref('')
  let rotateHintTimer: ReturnType<typeof setTimeout> | null = null

  function showRotateHint(text: string) {
    rotateHint.value = text
    if (rotateHintTimer)
      clearTimeout(rotateHintTimer)
    rotateHintTimer = setTimeout(() => {
      rotateHint.value = ''
    }, 1400)
  }

  function notifyRotation() {
    showRotateHint(rotationAngle.value === 0 ? '已恢复原方向' : `已旋转 ${rotationAngle.value}°`)
  }

  /** 计算从 from 走到 target 的最短旋转差，落在 [-180°, 180°) 内 */
  function shortestRotationDelta(from: number, target: number) {
    return ((target - from + 540) % 360) - 180
  }

  /** rotationAngle 变更后，把渲染角度沿最短路径同步过去 */
  function applyRotation() {
    renderAngle.value += shortestRotationDelta(renderAngle.value, rotationAngle.value)
  }

  function rotateLeft() {
    rotationAngle.value = ((rotationAngle.value - 90) % 360 + 360) % 360
    applyRotation()
    notifyRotation()
  }

  function rotateRight() {
    rotationAngle.value = (rotationAngle.value + 90) % 360
    applyRotation()
    notifyRotation()
  }

  function resetRotation() {
    if (rotationAngle.value === 0)
      return
    rotationAngle.value = 0
    applyRotation()
    notifyRotation()
  }

  /** 双击：旋转态回正，未旋转态切换容器全屏 */
  function onBoxDblClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('.player-actions, .mini-controls'))
      return
    event.preventDefault()
    if (rotationAngle.value !== 0) {
      resetRotation()
      return
    }
    void toggleFullscreen()
  }

  // 全屏作用在容器而非 media 元素：原生全屏只放大 video 本身，
  // 会让 LIVE 徽标、旋转、录制这些浮层在全屏下集体消失。
  const isFullscreen = ref(false)

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement)
        await document.exitFullscreen()
      else
        await videoBoxRef.value?.requestFullscreen()
    }
    catch (error: any) {
      console.error('[use-video-rotation] 切换全屏失败:', error)
    }
  }

  function onFullscreenChange() {
    isFullscreen.value = document.fullscreenElement === videoBoxRef.value
  }

  // 系统画中画（原生 PiP）：仅视频适用，电台下宿主隐藏按钮。
  // 各版本 TS 的 DOM 库对 PiP 覆盖不一（有的已含 exitPictureInPicture），
  // 用交叉类型统一补面型，避免与 lib 声明冲突
  interface PipApi {
    pictureInPictureElement?: Element | null
    exitPictureInPicture?: () => Promise<unknown>
    requestPictureInPicture?: () => Promise<unknown>
  }

  const isPip = ref(false)

  async function togglePip() {
    const video = getVideo() as (HTMLVideoElement & PipApi) | null
    const doc = document as Document & PipApi
    // 已在画中画的正是本播放器 → 退出；其他浮窗占用时直接请求，Chromium 会接管切换
    if (doc.pictureInPictureElement && doc.pictureInPictureElement === video) {
      void doc.exitPictureInPicture?.().catch((error: any) => {
        console.error('[use-video-rotation] 退出画中画失败:', error)
      })
      return
    }
    if (!video?.requestPictureInPicture)
      return
    try {
      // 容器全屏下把 video 摘进 PiP 会只剩黑底空容器：先退全屏再进
      if (document.fullscreenElement)
        await document.exitFullscreen().catch(() => undefined)
      await video.requestPictureInPicture()
    }
    catch (error: any) {
      console.error('[use-video-rotation] 切换画中画失败:', error)
    }
  }

  function onPipStateChange() {
    const doc = document as Document & PipApi
    isPip.value = !!doc.pictureInPictureElement && doc.pictureInPictureElement === getVideo()
  }

  // 旋转 90/270 时原生控制条会跟着画面侧躺，改用自绘迷你条（见 MiniControls）
  const playing = ref(false)
  const muted = ref(false)

  function togglePlay() {
    const el = getMedia()
    if (!el)
      return
    if (el.paused)
      void Promise.resolve(el.play()).catch((error: any) => console.error('[use-video-rotation.ts] 播放失败:', error))
    else
      el.pause()
  }

  function toggleMute() {
    const el = getMedia()
    if (!el)
      return
    el.muted = !el.muted
  }

  function onVolumeChange(event: Event) {
    muted.value = (event.target as HTMLMediaElement).muted
  }

  // 计算画面实际显示宽高比（90/270° 旋转会交换源宽高），上报给浮窗自动定形
  function reportAspect() {
    if (isRadio.value)
      return
    const w = videoWidth.value
    const h = videoHeight.value
    if (!w || !h)
      return
    onAspect(isVerticalRotation.value ? h / w : w / h)
  }

  function updateVideoDimensions() {
    const video = getVideo()
    if (video) {
      videoWidth.value = video.videoWidth || 0
      videoHeight.value = video.videoHeight || 0
    }
    reportAspect()
  }

  function handleNativeVideoResize() {
    updateVideoDimensions()
  }

  // 旋转后画面宽高比随之交换，重新上报给浮窗调整窗口形状
  watch(rotationAngle, () => reportAspect())

  let resizeObserver: ResizeObserver | null = null

  onMounted(() => {
    if (!isRadio.value && videoBoxRef.value) {
      boxDimensions.value = {
        width: videoBoxRef.value.clientWidth,
        height: videoBoxRef.value.clientHeight,
      }

      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          boxDimensions.value = {
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          }
        }
      })

      resizeObserver.observe(videoBoxRef.value)
    }

    const video = getVideo()
    if (video)
      video.addEventListener('resize', handleNativeVideoResize)

    document.addEventListener('fullscreenchange', onFullscreenChange)
    // PiP 事件会从媒体元素冒泡到 document，多浮窗共用同一组监听、各自比对元素
    document.addEventListener('enterpictureinpicture', onPipStateChange)
    document.addEventListener('leavepictureinpicture', onPipStateChange)
  })

  onUnmounted(() => {
    const video = getVideo()
    if (video)
      video.removeEventListener('resize', handleNativeVideoResize)
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    document.removeEventListener('enterpictureinpicture', onPipStateChange)
    document.removeEventListener('leavepictureinpicture', onPipStateChange)
    if (rotateHintTimer) {
      clearTimeout(rotateHintTimer)
      rotateHintTimer = null
    }
  })

  return {
    rotationAngle,
    isVerticalRotation,
    videoWrapperStyle,
    videoStyle,
    rotateHint,
    rotateLeft,
    rotateRight,
    resetRotation,
    onBoxDblClick,
    isFullscreen,
    toggleFullscreen,
    isPip,
    togglePip,
    playing,
    muted,
    togglePlay,
    toggleMute,
    onVolumeChange,
    updateVideoDimensions,
  }
}
