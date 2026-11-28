import type { ComputedRef, Ref } from 'vue'
import { useFullscreen, useResizeObserver } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

/** 浮窗播放器音量与静音记忆的 localStorage 键 */
export const FLOAT_PLAYER_VOLUME_KEY = 'desktop48:float-player:volume'

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

  // 旋转 90/270 时原生控制条会跟着画面侧躺，改用自绘迷你条（见 MiniControls）
  const playing = ref(false)

  function loadSavedVolume(): { volume: number, muted: boolean } {
    try {
      const raw = globalThis.localStorage?.getItem(FLOAT_PLAYER_VOLUME_KEY)
      if (!raw)
        return { volume: 1, muted: false }
      const parsed = JSON.parse(raw) as { volume?: unknown, muted?: unknown }
      const vol = typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
        ? Math.min(1, Math.max(0, parsed.volume))
        : 1
      return { volume: vol, muted: parsed.muted === true }
    }
    catch {
      return { volume: 1, muted: false }
    }
  }

  const VOLUME_SAVE_THROTTLE_MS = 200
  const savedVolume = loadSavedVolume()
  let lastSavedVolumeJson = JSON.stringify({
    volume: Math.round(savedVolume.volume * 100) / 100,
    muted: savedVolume.muted,
  })
  let pendingVolumeJson: string | null = null
  let saveVolumeTimer: ReturnType<typeof setTimeout> | null = null

  function writeVolumeJson(json: string) {
    lastSavedVolumeJson = json
    try {
      globalThis.localStorage?.setItem(FLOAT_PLAYER_VOLUME_KEY, json)
    }
    catch {
      // 忽略配额或受限环境写入失败
    }
  }

  function flushVolumeSave() {
    if (saveVolumeTimer) {
      clearTimeout(saveVolumeTimer)
      saveVolumeTimer = null
    }
    if (pendingVolumeJson && pendingVolumeJson !== lastSavedVolumeJson)
      writeVolumeJson(pendingVolumeJson)
    pendingVolumeJson = null
  }

  /** 去重 + 200ms leading/trailing 节流写盘，避免拖动或 volumechange 重复高频写入 */
  function saveVolumeState(vol: number, isMuted: boolean) {
    const json = JSON.stringify({ volume: Math.round(Math.min(1, Math.max(0, vol)) * 100) / 100, muted: isMuted })
    if (json === lastSavedVolumeJson && pendingVolumeJson === null)
      return
    if (!saveVolumeTimer) {
      writeVolumeJson(json)
      saveVolumeTimer = setTimeout(() => {
        saveVolumeTimer = null
        if (pendingVolumeJson && pendingVolumeJson !== lastSavedVolumeJson)
          writeVolumeJson(pendingVolumeJson)
        pendingVolumeJson = null
      }, VOLUME_SAVE_THROTTLE_MS)
      return
    }
    pendingVolumeJson = json
  }
  const muted = ref(savedVolume.muted)

  function togglePlay() {
    const el = getMedia()
    if (!el)
      return
    if (el.paused)
      void Promise.resolve(el.play()).catch((error: any) => console.error('[use-video-rotation.ts] 播放失败:', error))
    else
      el.pause()
  }

  // 每次按键的音量步进
  const VOLUME_STEP = 0.05
  const volume = ref(savedVolume.volume)
  /**
   * 静音前的音量，取消静音 / 静音态按 ↑ 时恢复到这里。
   * 只在进入静音那一次快照；静音与归零同时发生时 volume 已是 0，用 lastAudibleVolume 兜底。
   */
  let volumeBeforeMute = savedVolume.volume > 0 ? savedVolume.volume : 1
  let lastAudibleVolume = savedVolume.volume > 0 ? savedVolume.volume : 1

  /** 将当前记忆的音量与静音态同步到媒体元素（新开浮窗或切换音视频元素时调用） */
  function applySavedVolume(target?: HTMLMediaElement | null) {
    const el = target ?? getMedia()
    if (!el)
      return
    el.volume = volume.value
    el.muted = muted.value
  }

  function toggleMute() {
    const el = getMedia()
    if (!el)
      return
    // 音量已归零时取消静音等于没改，先补回上一次能听到的音量
    if (el.muted && el.volume <= 0) {
      el.volume = volumeBeforeMute > 0 ? volumeBeforeMute : lastAudibleVolume
      volume.value = el.volume
    }
    el.muted = !el.muted
    muted.value = el.muted
    saveVolumeState(volume.value, muted.value)
    notifyVolume()
  }

  /** 改音量；静音态不动静音开关，由调用方决定是否解除 */
  function setVolume(next: number) {
    const el = getMedia()
    const clamped = Math.min(1, Math.max(0, next))
    if (!el)
      return
    el.volume = clamped
  }

  /**
   * 音量滑块（入参 0..1）：拖到 0 视为静音，拖回正值退出静音并落在当前位置；
   * 静音态拖到 0 不覆盖 volumeBeforeMute，之后按 ↑ / 点喇叭仍回到原来的音量。
   */
  function onVolumeSliderInput(value: number) {
    if (!Number.isFinite(value))
      return
    const el = getMedia()
    // 取整到整数百分比，避免浮点误差让读数和滑块对不上
    const next = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
    // 归零交给 media 自己上报 muted；这里再置 muted 会让取消静音后滑块停在 0
    if (next === 0) {
      setVolume(0)
      volume.value = 0
      saveVolumeState(0, muted.value)
      return
    }
    // 静音态下拖滑块即恢复声音
    if (el && el.muted) {
      el.muted = false
      muted.value = false
    }
    setVolume(next)
    // volumechange 是异步的，先同步 UI，滑块不滞后一帧
    volume.value = next
    lastAudibleVolume = next
    saveVolumeState(next, muted.value)
  }

  // 键盘调音量 / 快进快退 / 倍速的提示：焦点常在按钮/空白处，靠它即时确认。
  // 带自增 id，方便宿主按 id 去重
  const shortcutHint = ref<{ id: number, text: string } | null>(null)
  let shortcutHintTimer: ReturnType<typeof setTimeout> | null = null
  let shortcutHintSeq = 0

  function showShortcutHint(text: string) {
    shortcutHint.value = { id: ++shortcutHintSeq, text }
    if (shortcutHintTimer)
      clearTimeout(shortcutHintTimer)
    shortcutHintTimer = setTimeout(() => {
      shortcutHint.value = null
    }, 1000)
  }

  function notifyVolume() {
    if (muted.value || volume.value <= 0) {
      showShortcutHint('静音')
      return
    }
    showShortcutHint(`音量 ${Math.round(volume.value * 100)}%`)
  }

  /** 键盘 ↑/↓：静音态按 ↑ 先恢复静音前音量再加一步 */
  function adjustVolume(delta: number) {
    const el = getMedia()
    if (!el)
      return
    if (el.muted && delta > 0) {
      el.muted = false
      el.volume = Math.round(Math.min(1, Math.max(0, (volumeBeforeMute || lastAudibleVolume || 1) + delta)) * 1000) / 1000
      // volumechange 异步，先同步再报提示
      muted.value = el.muted
      volume.value = el.volume
      lastAudibleVolume = el.volume
      saveVolumeState(volume.value, muted.value)
      notifyVolume()
      return
    }
    // 取三位小数，修掉浮点累加误差
    setVolume(Math.round(Math.min(1, Math.max(0, el.volume + delta)) * 1000) / 1000)
    volume.value = el.volume
    if (volume.value > 0)
      lastAudibleVolume = volume.value
    saveVolumeState(volume.value, muted.value)
    notifyVolume()
  }

  function onVolumeChange(event: Event) {
    const el = event.target as HTMLMediaElement
    const wasMuted = muted.value
    muted.value = el.muted
    volume.value = Number.isFinite(el.volume) ? el.volume : 1
    if (!el.muted && volume.value > 0)
      lastAudibleVolume = volume.value
    if (!wasMuted && el.muted)
      volumeBeforeMute = Math.max(volume.value, lastAudibleVolume)
    saveVolumeState(volume.value, muted.value)
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
    applySavedVolume()
    const video = getVideo()
    if (video)
      video.addEventListener('resize', handleNativeVideoResize)
  })

  onUnmounted(() => {
    flushVolumeSave()
    if (shortcutHintTimer) {
      clearTimeout(shortcutHintTimer)
      shortcutHintTimer = null
    }
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
    shortcutHint,
    showShortcutHint,
    rotateLeft,
    rotateRight,
    resetRotation,
    onBoxDblClick,
    isFullscreen,
    toggleFullscreen,
    playing,
    muted,
    togglePlay,
    toggleMute,
    volume,
    volumeBeforeMute: () => volumeBeforeMute,
    VOLUME_STEP,
    setVolume,
    applySavedVolume,
    onVolumeSliderInput,
    adjustVolume,
    onVolumeChange,
    updateVideoDimensions,
  }
}
