import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useVideoRotation } from '../src/renderer/src/composables/use-video-rotation'

/**
 * 画中画镜像链路的替身：Node 环境没有 canvas / video / rAF，
 * 这里只保留被测代码会碰到的面，重点验证「走哪条路」与「退出是否拆干净」。
 */

interface FakeTrack {
  stopped: boolean
  stop: () => void
}

type FakeCtx = Record<'save' | 'restore' | 'translate' | 'rotate' | 'scale' | 'drawImage', ReturnType<typeof vi.fn>>

interface FakeCanvas {
  width: number
  height: number
  ctx: FakeCtx
  tracks: FakeTrack[]
  getContext: () => FakeCtx
  captureStream: () => { getTracks: () => FakeTrack[] }
}

interface FakeVideo {
  videoWidth: number
  videoHeight: number
  muted: boolean
  paused: boolean
  playsInline: boolean
  srcObject: unknown
  style: { cssText: string }
  play: () => Promise<void>
  pause: () => void
  remove: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  requestPictureInPicture: () => Promise<unknown>
}

let listeners: Map<string, Array<() => void>>
let canvases: FakeCanvas[]
let videos: FakeVideo[]
let rafSeq: number
let cancelled: number[]
/** 影子 video 的 PiP 结果由用例决定，用来覆盖被拒后的回退 */
let pipImpl: (video: FakeVideo) => Promise<unknown>

const fakeDocument = {
  fullscreenElement: null as unknown,
  pictureInPictureElement: null as unknown,
  body: { appendChild: vi.fn() },
  addEventListener: (type: string, fn: () => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn])
  },
  removeEventListener: () => {},
  createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : makeVideo()),
}

function dispatch(type: string) {
  for (const fn of listeners.get(type) ?? [])
    fn()
}

function makeCanvas(): FakeCanvas {
  const ctx: FakeCtx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn() }
  const track: FakeTrack = { stopped: false, stop: () => void (track.stopped = true) }
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    ctx,
    tracks: [track],
    getContext: () => ctx,
    captureStream: () => ({ getTracks: () => canvas.tracks }),
  }
  canvases.push(canvas)
  return canvas
}

function makeVideo(): FakeVideo {
  const video: FakeVideo = {
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    paused: false,
    playsInline: false,
    srcObject: null,
    style: { cssText: '' },
    play: () => Promise.resolve(),
    pause: () => void (video.paused = true),
    remove: vi.fn(),
    addEventListener: vi.fn(),
    requestPictureInPicture: () => pipImpl(video),
  }
  videos.push(video)
  return video
}

function mount(angle: 0 | 90 = 0) {
  const source = makeVideo()
  const rotation = useVideoRotation({
    videoBoxRef: ref<HTMLElement | null>(null),
    getMedia: () => source as unknown as HTMLVideoElement,
    getVideo: () => source as unknown as HTMLVideoElement,
    isRadio: ref(false),
    onAspect: () => {},
  })
  if (angle === 90)
    rotation.rotateRight()
  return { rotation, source }
}

beforeEach(() => {
  listeners = new Map()
  canvases = []
  videos = []
  rafSeq = 0
  cancelled = []
  // 取到帧即视为进入 PiP，与浏览器行为对齐，方便断言 isPip
  pipImpl = async (video) => {
    fakeDocument.pictureInPictureElement = video
    return { width: 540, height: 960 }
  }
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => ++rafSeq))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => void cancelled.push(id)))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // composable 里有 onMounted / onUnmounted，脱离组件实例调用必然告警，与用例无关
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useVideoRotation 画中画', () => {
  it('未旋转时直连真实 video，不建镜像', async () => {
    const { rotation, source } = mount()

    await rotation.togglePip()

    expect(fakeDocument.pictureInPictureElement).toBe(source)
    expect(canvases).toHaveLength(0)
    expect(videos).toHaveLength(1)
  })

  it('旋转后走 canvas 镜像：canvas 取旋转后的比例，最长边压到 960', async () => {
    const { rotation, source } = mount(90)

    await rotation.togglePip()

    expect(canvases).toHaveLength(1)
    expect([canvases[0].width, canvases[0].height]).toEqual([540, 960])
    // 旋转真正落在像素上：绘制前按 90° 旋转
    expect(canvases[0].ctx.rotate).toHaveBeenCalledWith(Math.PI / 2)
    // 源画面原封不动留在页面里，进 PiP 的是影子 video
    expect(fakeDocument.pictureInPictureElement).toBe(videos[1])
    expect(fakeDocument.pictureInPictureElement).not.toBe(source)
    expect(source.paused).toBe(false)
  })

  it('影子 video 进 PiP 后 isPip 为真，退出时停轨道、移除元素', async () => {
    const { rotation } = mount(90)
    await rotation.togglePip()
    const shadow = videos[1]

    fakeDocument.pictureInPictureElement = shadow
    dispatch('enterpictureinpicture')
    expect(rotation.isPip.value).toBe(true)

    fakeDocument.pictureInPictureElement = null
    dispatch('leavepictureinpicture')
    expect(rotation.isPip.value).toBe(false)
    expect(canvases[0].tracks[0].stopped).toBe(true)
    expect(cancelled).toHaveLength(1)
    expect(shadow.remove).toHaveBeenCalled()
  })

  it('镜像请求被拒时回退到真实 video 直连，并拆掉影子链路', async () => {
    // 只拒影子 video，真实 video 正常放行 —— 回退成功与否才可断言
    pipImpl = async (video) => {
      if (video === videos[1])
        throw new Error('denied')
      fakeDocument.pictureInPictureElement = video
      return {}
    }
    const { rotation, source } = mount(90)

    await rotation.togglePip()

    expect(fakeDocument.pictureInPictureElement).toBe(source)
    expect(videos[1].remove).toHaveBeenCalled()
    expect(canvases[0].tracks[0].stopped).toBe(true)
  })

  it('已在 PiP 中再点一次是退出，不会重建镜像', async () => {
    const { rotation } = mount(90)
    await rotation.togglePip()
    const canvasesBefore = canvases.length

    await rotation.togglePip()

    expect(canvases).toHaveLength(canvasesBefore)
    expect(videos).toHaveLength(2)
  })
})
