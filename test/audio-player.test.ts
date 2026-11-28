import type { AudioTrack } from '../src/renderer/src/stores/audio-player'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AudioListener = () => void

class FakeAudio {
  preload = ''
  src = ''
  paused = true
  currentTime = 0
  duration = 0
  volume = 1
  muted = false
  private listeners = new Map<string, AudioListener[]>()

  addEventListener(type: string, fn: AudioListener) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? [])
      fn()
  }

  play = vi.fn(() => {
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  })

  pause = vi.fn(() => {
    this.paused = true
    this.emit('pause')
  })
}

function makeTrack(id: string, url = `https://example.com/${id}.mp3`): AudioTrack {
  return {
    key: `album:${id}`,
    songsId: id,
    sid: 'album',
    name: `歌曲 ${id}`,
    url,
    cover: '',
    albumTitle: '测试专辑',
    singer: '测试成员',
  }
}

describe('stores/audio-player 边界行为', () => {
  let fakeAudio: FakeAudio

  beforeEach(() => {
    vi.resetModules()
    fakeAudio = new FakeAudio()
    vi.stubGlobal('Audio', class {
      constructor() {
        return fakeAudio
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('待播态（仅入队未播放）点 togglePlay 自动从首首可用曲目起播', async () => {
    const { useAudioPlayerStore } = await import('../src/renderer/src/stores/audio-player')
    const store = useAudioPlayerStore()
    store.addAlbum([makeTrack('1', ''), makeTrack('2')])

    expect(store.currentIndex.value).toBe(-1)
    store.togglePlay()

    expect(store.currentIndex.value).toBe(1)
    expect(store.currentTrack.value?.songsId).toBe('2')
    expect(store.playing.value).toBe(true)
  })

  it('失效曲目被点击时 playAt 直接忽略，next/prev/removeAt 自动跳过失效曲目', async () => {
    const { useAudioPlayerStore } = await import('../src/renderer/src/stores/audio-player')
    const store = useAudioPlayerStore()
    const t1 = makeTrack('1')
    const t2 = makeTrack('2')
    const t3 = makeTrack('3')
    store.playAlbum([t1, t2, t3], 1)

    // 模拟 t2 加载失败 → 标记失效并自动顺延到 t3
    fakeAudio.emit('error')
    expect(store.isBroken(t2.url)).toBe(true)
    expect(store.currentIndex.value).toBe(2)

    // 再点失效的 t2 不应触发切歌
    const playCallsBefore = fakeAudio.play.mock.calls.length
    store.playAt(1)
    expect(store.currentIndex.value).toBe(2)
    expect(fakeAudio.play.mock.calls.length).toBe(playCallsBefore)

    // t3 点上一首（≤3 秒）跳过失效的 t2 回到 t1
    store.prev()
    expect(store.currentIndex.value).toBe(0)

    // t1 点下一首跳过失效的 t2 直接到 t3
    store.next()
    expect(store.currentIndex.value).toBe(2)
  })

  it('首曲播放超过 3 秒点 prev 回到本曲开头，seek 夹紧合法区间并忽略零时长', async () => {
    const { useAudioPlayerStore } = await import('../src/renderer/src/stores/audio-player')
    const store = useAudioPlayerStore()
    store.playAlbum([makeTrack('1')])

    // duration 为 0 时 seek 不改 currentTime
    store.seek(30)
    expect(fakeAudio.currentTime).toBe(0)

    fakeAudio.duration = 120
    fakeAudio.emit('durationchange')

    store.seek(999)
    expect(fakeAudio.currentTime).toBe(120)
    expect(store.currentTime.value).toBe(120)

    store.prev()
    expect(fakeAudio.currentTime).toBe(0)
    expect(store.currentTime.value).toBe(0)
  })

  it('setVolume 夹紧区间、正值自动解除静音，并同步到 Audio 与 localStorage', async () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
    })
    const { useAudioPlayerStore } = await import('../src/renderer/src/stores/audio-player')
    const store = useAudioPlayerStore()
    store.playAlbum([makeTrack('1')])

    store.toggleMute()
    expect(store.muted.value).toBe(true)
    expect(fakeAudio.muted).toBe(true)

    store.setVolume(0.456)
    expect(store.volume.value).toBe(0.46)
    expect(store.muted.value).toBe(false)
    expect(fakeAudio.volume).toBe(0.46)
    expect(fakeAudio.muted).toBe(false)
    expect(backing.get('desktop48:album-audio-volume:v1')).toBe(JSON.stringify({ volume: 0.46, muted: false }))
  })

  it('音量为 0 时取消静音恢复上次可听音量，且冷启动从 localStorage 恢复记忆', async () => {
    const backing = new Map<string, string>([
      ['desktop48:album-audio-volume:v1', JSON.stringify({ volume: 0.65, muted: false })],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
    })
    const { useAudioPlayerStore } = await import('../src/renderer/src/stores/audio-player')
    const store = useAudioPlayerStore()
    expect(store.volume.value).toBe(0.65)
    expect(store.muted.value).toBe(false)

    store.playAlbum([makeTrack('1')])
    expect(fakeAudio.volume).toBe(0.65)

    store.setVolume(0)
    expect(store.volume.value).toBe(0)
    store.toggleMute()
    expect(store.muted.value).toBe(false)
    expect(store.volume.value).toBe(0.65)
    expect(fakeAudio.volume).toBe(0.65)
  })
})
