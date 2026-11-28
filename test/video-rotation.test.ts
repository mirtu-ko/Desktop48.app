import type { Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { FLOAT_PLAYER_VOLUME_KEY, useVideoRotation } from '../src/renderer/src/composables/use-video-rotation'

/**
 * useVideoRotation 的旋转 / 比例上报 / 画面矩形。
 *
 * 原 video-rotation-pip.test.ts 随 PiP 功能一并删除，这里补回不依赖 PiP 的那部分覆盖。
 * 重点两块：
 * - `renderAngle` 的最短路径（0° 左转必须走 -90°，而不是绕 +270° 一大圈）
 * - 旋转 90° 后上报**交换过**的宽高比（独立播放窗据此把窗口变成竖的）
 */

interface FakeVideo {
  videoWidth: number
  videoHeight: number
  paused: boolean
  /** 真实 media 元素带 volume / muted，音量用例直接读这两项 */
  volume: number
  muted: boolean
  play: () => Promise<void>
  pause: () => void
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

const fakeDocument = {
  fullscreenElement: null as unknown,
  body: { appendChild: vi.fn() },
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({}),
}

function makeVideo(width = 1920, height = 1080): FakeVideo {
  return {
    videoWidth: width,
    videoHeight: height,
    paused: false,
    volume: 1,
    muted: false,
    play: () => Promise.resolve(),
    pause: () => {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function makeBox(width = 1000, height = 500) {
  // 需要 addEventListener：useFullscreen(videoBoxRef) 会把 fullscreenchange 挂到该元素上
  return {
    clientWidth: width,
    clientHeight: height,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLElement
}

function mount(options: { video?: FakeVideo, box?: HTMLElement | null, isRadio?: boolean } = {}) {
  const video = options.video ?? makeVideo()
  const aspects: number[] = []
  const rotation = useVideoRotation({
    videoBoxRef: ref<HTMLElement | null>(options.box ?? null),
    getMedia: () => video as unknown as HTMLMediaElement,
    getVideo: () => video as unknown as HTMLVideoElement,
    isRadio: ref(options.isRadio ?? false) as Ref<boolean>,
    onAspect: (aspect: number) => aspects.push(aspect),
  })
  return { rotation, video, aspects }
}

/** 从 transform 串里取出实际渲染角度 */
function renderAngleOf(rotation: { videoWrapperStyle: { value: { transform: string } } }): number {
  const matched = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(rotation.videoWrapperStyle.value.transform)
  return Number(matched?.[1] ?? Number.NaN)
}

beforeEach(() => {
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  // composable 里有 onMounted / onUnmounted，脱离组件实例调用必然告警，与用例无关
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useVideoRotation 旋转', () => {
  it('左转走最短路径：0° 左转渲染为 -90°，不是 +270°', () => {
    const { rotation } = mount()

    rotation.rotateLeft()

    // 语义角度归一化到 270，渲染角度反向走 90°
    expect(rotation.rotationAngle.value).toBe(270)
    expect(renderAngleOf(rotation)).toBe(-90)
  })

  it('渲染角度与语义角度恒等（模 360），连续旋转不漂移', () => {
    const { rotation } = mount()

    for (const step of ['left', 'left', 'left', 'right', 'right', 'left'] as const) {
      if (step === 'left')
        rotation.rotateLeft()
      else
        rotation.rotateRight()
      const normalized = ((renderAngleOf(rotation) % 360) + 360) % 360
      expect(normalized).toBe(rotation.rotationAngle.value)
    }
  })

  it('isVerticalRotation 只认 90 / 270', () => {
    const { rotation } = mount()

    expect(rotation.isVerticalRotation.value).toBe(false)
    rotation.rotateRight()
    expect(rotation.rotationAngle.value).toBe(90)
    expect(rotation.isVerticalRotation.value).toBe(true)
    rotation.rotateRight()
    expect(rotation.rotationAngle.value).toBe(180)
    expect(rotation.isVerticalRotation.value).toBe(false)
    rotation.rotateRight()
    expect(rotation.rotationAngle.value).toBe(270)
    expect(rotation.isVerticalRotation.value).toBe(true)
  })

  it('已在原方向时 reset 是空操作', () => {
    const { rotation } = mount()

    rotation.resetRotation()

    expect(rotation.rotationAngle.value).toBe(0)
    expect(renderAngleOf(rotation)).toBe(0)
  })
})

describe('useVideoRotation 比例上报', () => {
  it('未旋转时上报原始宽高比', () => {
    const { rotation, aspects } = mount()

    rotation.updateVideoDimensions()

    expect(aspects.at(-1)).toBeCloseTo(1920 / 1080, 5)
  })

  it('旋转 90° 后上报交换后的宽高比，窗口据此变竖', async () => {
    const { rotation, aspects } = mount()

    rotation.rotateRight()
    await nextTick()
    rotation.updateVideoDimensions()

    expect(aspects.at(-1)).toBeCloseTo(1080 / 1920, 5)
  })

  it('电台模式不上报比例', () => {
    const { rotation, aspects } = mount({ isRadio: true })

    rotation.updateVideoDimensions()

    expect(aspects).toHaveLength(0)
  })
})

describe('useVideoRotation 画面矩形', () => {
  it('元数据未就绪时按撑满容器兜底', () => {
    const { rotation } = mount({ box: makeBox(1000, 500) })

    expect(rotation.videoRect.value).toEqual({ left: 0, top: 0, width: 1000, height: 500, bottom: 0 })
  })

  it('横屏画面在容器内上下留边（contain）', () => {
    const { rotation } = mount({ box: makeBox(1000, 500) })

    rotation.updateVideoDimensions()

    const rect = rotation.videoRect.value
    expect(rect?.height).toBe(500)
    expect(rect?.width).toBeCloseTo(888.89, 1)
    expect(rect?.left).toBeCloseTo(55.56, 1)
    expect(rect?.bottom).toBe(0)
  })

  it('旋转 90° 后矩形按交换后的比例收窄', () => {
    const { rotation } = mount({ box: makeBox(1000, 500) })

    rotation.rotateRight()
    rotation.updateVideoDimensions()

    const rect = rotation.videoRect.value
    expect(rect?.height).toBe(500)
    expect(rect?.width).toBeCloseTo(281.25, 1)
    expect(rect?.left).toBeCloseTo(359.38, 1)
  })
})

describe('useVideoRotation 音量', () => {
  function changeEvent(media: FakeVideo): Event {
    return { target: media } as unknown as Event
  }

  it('↑ 每次加一步并同步 volume ref，↓ 一致', () => {
    const { rotation, video } = mount()
    video.volume = 0.5

    rotation.adjustVolume(rotation.VOLUME_STEP)
    rotation.onVolumeChange(changeEvent(video))
    expect(video.volume).toBeCloseTo(0.55, 5)
    expect(rotation.volume.value).toBeCloseTo(0.55, 5)

    rotation.adjustVolume(-rotation.VOLUME_STEP)
    expect(video.volume).toBeCloseTo(0.5, 5)
  })

  it('夹在 0~1，且浮点累加不留误差', () => {
    const { rotation, video } = mount()
    video.volume = 0.97

    rotation.adjustVolume(rotation.VOLUME_STEP)
    expect(video.volume).toBe(1)
    video.volume = 0.02
    rotation.adjustVolume(-rotation.VOLUME_STEP)
    expect(video.volume).toBe(0)
  })

  it('静音态下按 ↑ 先恢复静音前音量再加一步，不会从 0 起步', () => {
    const { rotation, video } = mount()
    video.volume = 0.6
    rotation.onVolumeChange(changeEvent(video))
    video.muted = true
    rotation.onVolumeChange(changeEvent(video))
    expect(rotation.muted.value).toBe(true)
    // 静音期间把音量改小，静音前音量不受影响
    video.volume = 0.1
    rotation.onVolumeChange(changeEvent(video))

    rotation.adjustVolume(rotation.VOLUME_STEP)

    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.65, 5)
    expect(rotation.volume.value).toBeCloseTo(0.65, 5)
  })

  it('滑块拖到 0 时同步将 media 音量归零；静音态拖回正值解除静音', () => {
    const { rotation, video } = mount()
    video.volume = 0.8
    rotation.onVolumeChange(changeEvent(video))

    rotation.onVolumeSliderInput(0)
    expect(rotation.volume.value).toBe(0)
    expect(video.volume).toBe(0)

    video.muted = true
    rotation.onVolumeChange(changeEvent(video))
    rotation.onVolumeSliderInput(0.3)
    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.3, 5)
    expect(rotation.volume.value).toBeCloseTo(0.3, 5)
  })

  it('静音且音量为 0 时取消静音会补回音量，而不是停在 0', () => {
    const { rotation, video } = mount()
    video.volume = 0.7
    rotation.onVolumeChange(changeEvent(video))
    video.muted = true
    video.volume = 0
    rotation.onVolumeChange(changeEvent(video))

    rotation.toggleMute()

    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.7, 5)
    expect(rotation.volume.value).toBeCloseTo(0.7, 5)
  })

  it('持久化并恢复上次记忆的音量与静音态', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })

    const first = mount()
    first.rotation.onVolumeSliderInput(0.35)
    expect(store.get(FLOAT_PLAYER_VOLUME_KEY)).toBe(JSON.stringify({ volume: 0.35, muted: false }))

    const second = mount()
    expect(second.rotation.volume.value).toBeCloseTo(0.35, 5)
    expect(second.rotation.muted.value).toBe(false)
    second.rotation.applySavedVolume()
    expect(second.video.volume).toBeCloseTo(0.35, 5)
    expect(second.video.muted).toBe(false)
  })

  it('音量写盘去重并节流：连续高频变动只写入首尾两次', () => {
    vi.useFakeTimers()
    try {
      const store = new Map<string, string>()
      const setItem = vi.fn((key: string, value: string) => store.set(key, value))
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem,
        removeItem: (key: string) => store.delete(key),
      })

      const { rotation, video } = mount()
      rotation.onVolumeSliderInput(0.5)
      // 同值 volumechange 不重复写盘
      rotation.onVolumeChange(changeEvent(video))
      expect(setItem).toHaveBeenCalledTimes(1)

      // 200ms 内连续拖动只缓存最新值，窗口结束补写一次
      rotation.onVolumeSliderInput(0.4)
      rotation.onVolumeSliderInput(0.3)
      rotation.onVolumeSliderInput(0.2)
      expect(setItem).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(200)
      expect(setItem).toHaveBeenCalledTimes(2)
      expect(store.get(FLOAT_PLAYER_VOLUME_KEY)).toBe(JSON.stringify({ volume: 0.2, muted: false }))
    }
    finally {
      vi.useRealTimers()
    }
  })
})
