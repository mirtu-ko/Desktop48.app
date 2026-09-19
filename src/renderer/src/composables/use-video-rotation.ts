import type { ComputedRef, Ref } from 'vue'
import { useEventListener, useFullscreen, useResizeObserver } from '@vueuse/core'
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

  // 视频实际渲染区（object-fit: contain 的 letterbox 结果）在容器内的矩形：
  // 竖屏视频放进宽屏全屏容器时左右有黑边，弹幕锚在本矩形左下角才不会离画面太远。
  // bottom 为相对容器底边的偏移，便于自下而上堆叠的弹幕条定位。
  const videoRect = computed(() => {
    const boxW = boxDimensions.value.width || videoBoxRef.value?.clientWidth || 0
    const boxH = boxDimensions.value.height || videoBoxRef.value?.clientHeight || 0
    if (boxW <= 0 || boxH <= 0)
      return null
    // 元数据未就绪：按撑满容器兜底，位置稳定在容器左下角
    if (videoWidth.value <= 0 || videoHeight.value <= 0)
      return { left: 0, top: 0, width: boxW, height: boxH, bottom: 0 }

    // 旋转 90/270 时显示宽高交换
    const ratio = isVerticalRotation.value
      ? videoHeight.value / videoWidth.value
      : videoWidth.value / videoHeight.value
    // contain：撑满一条边，另一条边居中留黑边
    const [width, height] = ratio < boxW / boxH
      ? [boxH * ratio, boxH]
      : [boxW, boxW / ratio]
    // 矩形两轴都居中，故 left/right 与 top/bottom 各自对称
    return {
      left: (boxW - width) / 2,
      top: (boxH - height) / 2,
      width,
      height,
      bottom: (boxH - height) / 2,
    }
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

  /** 双击：无论是否旋转都切换容器全屏（全屏作用在视频容器上，旋转随 wrapper 一并保留） */
  function onBoxDblClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('.player-actions, .mini-controls'))
      return
    event.preventDefault()
    void toggleFullscreen()
  }

  // 全屏作用在容器而非 media 元素：原生全屏只放大 video 本身，
  // 会让 LIVE 徽标、旋转、录制这些浮层在全屏下集体消失。
  // 传入 videoBoxRef，isFullscreen 的语义即「当前全屏元素是否为本容器」——
  // 与其他浮窗全屏互不干扰，正好是多播放器共存的判定口径。
  const { isFullscreen, toggle: toggleFullscreenRaw } = useFullscreen(videoBoxRef)

  async function toggleFullscreen() {
    try {
      // 容器全屏前若已有元素在全屏，useFullscreen 会先退再进
      await toggleFullscreenRaw()
    }
    catch (error: any) {
      console.error('[use-video-rotation] 切换全屏失败:', error)
    }
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

  // PiP 窗口取的是 video 的解码帧，DOM 与 CSS 不参与合成 —— wrapper 上的 rotate 带不进去，
  // 直接给 video 加 transform 也一样被忽略（规范写死）。Electron 也没实现 Document PiP
  // （requestWindow 能 resolve，但窗口根本不会被创建）。所以旋转只能落到像素上：
  // 按当前角度把画面画进 canvas，用 captureStream() 喂一个影子 video，再对影子 video 请求 PiP。
  // 角度为 0 时仍走直连路径，不引入任何额外开销。
  const PIP_MIRROR_MAX_EDGE = 960

  interface PipMirror {
    element: HTMLVideoElement
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    stream: MediaStream
    raf: number
  }

  let pipMirror: PipMirror | null = null

  /** 影子 canvas 只喂 PiP 小窗，最长边压到 PIP_MIRROR_MAX_EDGE，省掉整帧的重绘 */
  function mirrorSize(video: HTMLVideoElement) {
    const width = video.videoWidth || 480
    const height = video.videoHeight || 270
    const longest = Math.max(width, height)
    const k = longest > PIP_MIRROR_MAX_EDGE ? PIP_MIRROR_MAX_EDGE / longest : 1
    return { width: Math.round(width * k), height: Math.round(height * k) }
  }

  /** 按当前角度把源画面旋转后居中铺满 canvas；入口角度下正好满幅，之后换角度则留边 */
  function paintMirrorFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, video: HTMLVideoElement, angle: number) {
    const sourceWidth = video.videoWidth
    const sourceHeight = video.videoHeight
    if (!sourceWidth || !sourceHeight)
      return
    const swap = angle % 180 !== 0
    const rotatedWidth = swap ? sourceHeight : sourceWidth
    const rotatedHeight = swap ? sourceWidth : sourceHeight
    const scale = Math.min(canvas.width / rotatedWidth, canvas.height / rotatedHeight)
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((angle * Math.PI) / 180)
    ctx.scale(scale, scale)
    ctx.drawImage(video, -sourceWidth / 2, -sourceHeight / 2)
    ctx.restore()
  }

  function destroyPipMirror() {
    if (!pipMirror)
      return
    cancelAnimationFrame(pipMirror.raf)
    pipMirror.stream.getTracks().forEach(track => track.stop())
    pipMirror.element.srcObject = null
    pipMirror.element.remove()
    pipMirror = null
  }

  /**
   * 源画面本身一动不动（不重连、不二次拉流），只是每帧多画一次。
   * PiP 上的播放 / 静音按钮作用在影子 video 上，转发回真实元素，免得按了没反应。
   */
  function createPipMirror(video: HTMLVideoElement, angle: number): PipMirror | null {
    const canvas = document.createElement('canvas')
    if (typeof canvas.captureStream !== 'function')
      return null
    const swap = angle % 180 !== 0
    const size = mirrorSize(video)
    // canvas 取旋转后的比例，PiP 窗口才会跟着定形成竖的
    canvas.width = swap ? size.height : size.width
    canvas.height = swap ? size.width : size.height
    const ctx = canvas.getContext('2d')
    if (!ctx)
      return null
    paintMirrorFrame(canvas, ctx, video, angle)

    const element = document.createElement('video')
    element.muted = true
    element.playsInline = true
    // 影子 video 必须在文档里才吃得到帧；压成 2px 且近乎透明，不影响观感与布局
    element.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none'

    const mirror: PipMirror = { element, canvas, ctx, stream: canvas.captureStream(30), raf: 0 }
    const paint = () => {
      paintMirrorFrame(canvas, ctx, video, rotationAngle.value)
      mirror.raf = requestAnimationFrame(paint)
    }
    paint()

    document.body.appendChild(element)
    element.srcObject = mirror.stream
    element.addEventListener('play', () => {
      if (video.paused)
        void Promise.resolve(video.play()).catch((error: any) => console.error('[use-video-rotation] 同步播放失败:', error))
    })
    element.addEventListener('pause', () => {
      if (!video.paused)
        video.pause()
    })
    element.addEventListener('volumechange', () => {
      video.muted = element.muted
    })
    return mirror
  }

  /** 旋转非 0 时用影子 video 请求 PiP；失败（无 captureStream / PiP 被拒）返回 false 交给直连路径 */
  async function requestMirrorPip(video: HTMLVideoElement): Promise<boolean> {
    destroyPipMirror()
    const mirror = createPipMirror(video, rotationAngle.value)
    if (!mirror)
      return false
    pipMirror = mirror
    const target = mirror.element as HTMLVideoElement & PipApi
    try {
      await mirror.element.play()
      if (!target.requestPictureInPicture)
        throw new Error('requestPictureInPicture 不可用')
      await target.requestPictureInPicture()
      return true
    }
    catch (error: any) {
      console.error('[use-video-rotation] 画中画镜像路径失败，回退直连:', error)
      destroyPipMirror()
      return false
    }
  }

  async function togglePip() {
    const video = getVideo() as (HTMLVideoElement & PipApi) | null
    const doc = document as Document & PipApi
    // 已在画中画的正是本播放器（真实 video 或影子 video）→ 退出；其他浮窗占用时直接请求，Chromium 会接管切换
    const pipElement = doc.pictureInPictureElement
    if (pipElement && (pipElement === video || pipElement === pipMirror?.element)) {
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
      if (rotationAngle.value !== 0 && await requestMirrorPip(video))
        return
      await video.requestPictureInPicture()
    }
    catch (error: any) {
      console.error('[use-video-rotation] 切换画中画失败:', error)
    }
  }

  function onPipStateChange() {
    const doc = document as Document & PipApi
    const element = doc.pictureInPictureElement
    isPip.value = !!element && (element === getVideo() || element === pipMirror?.element)
    // 退出（含用户直接关掉 PiP 窗口）时拆掉影子链路，别让帧循环空转
    if (!element)
      destroyPipMirror()
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

  // 容器尺寸观察：电台无视频轨不观察（元素置 null）；ResizeObserver 挂上后
  // 首帧必回调一次，不需要额外做挂载时的初始快照
  useResizeObserver(computed(() => (isRadio.value ? null : videoBoxRef.value)), (entries) => {
    for (const entry of entries) {
      boxDimensions.value = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }
    }
  })

  onMounted(() => {
    const video = getVideo()
    if (video)
      video.addEventListener('resize', handleNativeVideoResize)
  })

  // 全局事件监听交给 useEventListener：scope dispose 时自动移除，免手动 add/remove
  // PiP 事件会从媒体元素冒泡到 document，多浮窗共用同一组监听、各自比对元素
  useEventListener(document, 'enterpictureinpicture', onPipStateChange)
  useEventListener(document, 'leavepictureinpicture', onPipStateChange)

  onUnmounted(() => {
    destroyPipMirror()
    const video = getVideo()
    if (video)
      video.removeEventListener('resize', handleNativeVideoResize)
  })

  return {
    rotationAngle,
    isVerticalRotation,
    videoRect,
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
