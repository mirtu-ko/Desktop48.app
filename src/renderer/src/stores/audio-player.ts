/**
 * ⚠️ 全局单例 store（模块作用域共享）
 *
 * 播放列表、播放进度与那个全局唯一的 HTML5 Audio 元素都定义在模块作用域，
 * **不随任何组件卸载而销毁**：专辑页负责入队/点播，FloatAudioBar 负责展示与移除，
 * 两边调用 useAudioPlayerStore() 拿到的是同一份状态。
 */
import { computed, ref, shallowRef } from 'vue'

/** 播放列表条目 */
export interface AudioTrack {
  /** 唯一键：专辑 sid + 歌曲 id */
  key: string
  /** 歌曲 id */
  songsId: string
  /** 所属专辑 sid */
  sid: string
  /** 歌曲名 */
  name: string
  /** 音频直链（无音源的伴奏曲目不进入队列） */
  url: string
  /** 封面（专辑封面，完整 URL） */
  cover: string
  /** 所属专辑标题 */
  albumTitle: string
  /** 歌手 */
  singer: string
}

/** 本地音量记忆键（带版本后缀，结构变化时换键即可，无需迁移） */
const VOLUME_STORAGE_KEY = 'desktop48:album-audio-volume:v1'

interface StoredAudioPrefs {
  volume: number
  muted: boolean
}

/** 读取本地记忆的音量与静音状态；无 localStorage（Node 测试）或脏数据时回退默认值 */
function loadStoredAudioPrefs(): StoredAudioPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(VOLUME_STORAGE_KEY)
    if (!raw)
      return { volume: 1, muted: false }
    const parsed = JSON.parse(raw) as Partial<StoredAudioPrefs>
    const vol = typeof parsed?.volume === 'number' && Number.isFinite(parsed.volume)
      ? Math.round(Math.min(1, Math.max(0, parsed.volume)) * 100) / 100
      : 1
    return { volume: vol, muted: Boolean(parsed?.muted) }
  }
  catch {
    return { volume: 1, muted: false }
  }
}

function saveStoredAudioPrefs(vol: number, isMuted: boolean) {
  try {
    globalThis.localStorage?.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: vol, muted: isMuted }))
  }
  catch {
    // 忽略存储配额 / 隐私模式异常
  }
}

// ===== 模块级单例：跨页面（keep-alive 复用）共享播放列表与播放状态 =====
const initialPrefs = loadStoredAudioPrefs()
const playlist = ref<AudioTrack[]>([])
const currentIndex = ref(-1)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(initialPrefs.volume)
const muted = ref(initialPrefs.muted)
/** 静音或归零前的最近一次可听音量，取消静音时据此恢复 */
let lastAudibleVolume = initialPrefs.volume > 0 ? initialPrefs.volume : 1
/**
 * 加载/播放失败的音频直链（失效 MP3 标记后不再重试）。
 * 用 shallowRef + 整体替换：Vue 3 的 ref/ref 不会深度代理 Set，
 * 原地 add() 不触发依赖更新，"失效曲目"的置灰就不会出现
 */
const brokenUrls = shallowRef(new Set<string>())

/** 全局唯一的 HTML5 Audio 元素，首次播放时惰性创建 */
let audio: HTMLAudioElement | null = null

const currentTrack = computed(() => playlist.value[currentIndex.value] || null)

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio
  }
  audio = new Audio()
  audio.preload = 'auto'
  // 创建即套用本地记忆音量，避免首帧以 100% 爆响
  audio.volume = volume.value
  audio.muted = muted.value
  audio.addEventListener('play', () => {
    playing.value = true
  })
  audio.addEventListener('pause', () => {
    playing.value = false
  })
  audio.addEventListener('timeupdate', () => {
    currentTime.value = audio?.currentTime || 0
  })
  audio.addEventListener('durationchange', () => {
    duration.value = audio?.duration && Number.isFinite(audio.duration) ? audio.duration : 0
  })
  audio.addEventListener('volumechange', () => {
    if (!audio)
      return
    muted.value = audio.muted
    if (Number.isFinite(audio.volume)) {
      volume.value = Math.round(Math.min(1, Math.max(0, audio.volume)) * 100) / 100
      if (!audio.muted && volume.value > 0)
        lastAudibleVolume = volume.value
    }
  })
  audio.addEventListener('ended', () => {
    next()
  })
  audio.addEventListener('error', () => {
    const track = currentTrack.value
    if (track && audio?.src && track.url && audio.src.includes(track.url)) {
      console.error('[stores/audio-player]音频加载失败，标记失效:', track.url)
      // 替换整个 Set 才能触发 shallowRef 的依赖更新（原地 add 不会）
      brokenUrls.value = new Set(brokenUrls.value).add(track.url)
      // 自动顺延下一首可用曲目，没有则停止
      const nextIdx = findNextPlayableIndex(currentIndex.value + 1)
      if (nextIdx >= 0) {
        playAt(nextIdx)
      }
      else {
        stop()
      }
    }
  })
  return audio
}

/** 从指定下标向后查找第一首未失效的曲目下标，找不到返回 -1 */
function findNextPlayableIndex(fromIndex: number): number {
  for (let i = Math.max(0, fromIndex); i < playlist.value.length; i++) {
    if (!isBroken(playlist.value[i].url))
      return i
  }
  return -1
}

/** 从指定下标向前查找第一首未失效的曲目下标，找不到返回 -1 */
function findPrevPlayableIndex(fromIndex: number): number {
  for (let i = Math.min(fromIndex, playlist.value.length - 1); i >= 0; i--) {
    if (!isBroken(playlist.value[i].url))
      return i
  }
  return -1
}

/** 播放指定下标的曲目；再次点击当前曲目时切换播放/暂停；失效曲目直接忽略 */
function playAt(index: number) {
  const track = playlist.value[index]
  if (!track || isBroken(track.url)) {
    return
  }
  if (index === currentIndex.value && audio && audio.src.includes(track.url)) {
    togglePlay()
    return
  }
  const el = ensureAudio()
  currentIndex.value = index
  currentTime.value = 0
  duration.value = 0
  el.src = track.url
  void el.play().catch(error => console.error('[stores/audio-player] 播放失败:', error))
}

/** 播放/暂停切换；待播态（列表非空但未选中曲目）时自动从首首可用曲目起播 */
function togglePlay() {
  if (!audio || !currentTrack.value) {
    const firstPlayable = findNextPlayableIndex(0)
    if (firstPlayable >= 0)
      playAt(firstPlayable)
    return
  }
  if (audio.paused) {
    void audio.play().catch(error => console.error('[stores/audio-player] 播放失败:', error))
  }
  else {
    audio.pause()
  }
}

/** 下一首：跳过失效曲目，播到队列末尾自动停止 */
function next() {
  const nextIdx = findNextPlayableIndex(currentIndex.value + 1)
  if (nextIdx >= 0) {
    playAt(nextIdx)
  }
  else {
    audio?.pause()
  }
}

/** 上一首：播放超过 3 秒时回到本曲开头，否则切上一首可用曲目 */
function prev() {
  if (currentTime.value > 3) {
    seek(0)
    return
  }
  const prevIdx = findPrevPlayableIndex(currentIndex.value - 1)
  if (prevIdx >= 0) {
    playAt(prevIdx)
  }
  else {
    seek(0)
  }
}

/** 跳转到指定秒数 */
function seek(seconds: number) {
  if (!audio || !currentTrack.value || !Number.isFinite(seconds)) {
    return
  }
  const maxDuration = duration.value || (Number.isFinite(audio.duration) ? audio.duration : 0)
  if (maxDuration <= 0) {
    return
  }
  const clamped = Math.min(Math.max(seconds, 0), maxDuration)
  audio.currentTime = clamped
  currentTime.value = clamped
}

/** 设置音量（0..1，取整到整数百分比）；静音态下调至正值自动解除静音，并持久化到 localStorage */
function setVolume(next: number) {
  if (!Number.isFinite(next))
    return
  const clamped = Math.round(Math.min(1, Math.max(0, next)) * 100) / 100
  volume.value = clamped
  if (clamped > 0) {
    lastAudibleVolume = clamped
    if (muted.value)
      muted.value = false
  }
  if (audio) {
    audio.volume = clamped
    if (clamped > 0 && audio.muted)
      audio.muted = false
  }
  saveStoredAudioPrefs(volume.value, muted.value)
}

/** 切换静音；音量为 0 时取消静音会自动恢复上次可听音量 */
function toggleMute() {
  if (muted.value || volume.value <= 0) {
    if (volume.value <= 0)
      volume.value = lastAudibleVolume > 0 ? lastAudibleVolume : 1
    muted.value = false
    if (audio) {
      audio.volume = volume.value
      audio.muted = false
    }
  }
  else {
    lastAudibleVolume = volume.value
    muted.value = true
    if (audio)
      audio.muted = true
  }
  saveStoredAudioPrefs(volume.value, muted.value)
}

/** 停止播放并清空播放位置（不清空列表） */
function stop() {
  audio?.pause()
  currentIndex.value = -1
  playing.value = false
  currentTime.value = 0
  duration.value = 0
}

/**
 * 整单替换播放列表并从指定下标起查找首首可用曲目开始播放；全单失效则停止
 */
function playAlbum(tracks: AudioTrack[], startIndex = 0) {
  if (!tracks.length) {
    return
  }
  playlist.value = [...tracks]
  const clamped = Math.min(Math.max(startIndex, 0), tracks.length - 1)
  const nextIdx = findNextPlayableIndex(clamped)
  if (nextIdx >= 0) {
    playAt(nextIdx)
  }
  else {
    stop()
  }
}

/**
 * 追加曲目到播放列表（按 key 去重，不自动播放）
 * @returns 第一首新加入曲目的下标，全部已存在时返回 -1
 */
function addAlbum(tracks: AudioTrack[]): number {
  let firstAddedIndex = -1
  tracks.forEach((track) => {
    const exists = playlist.value.some(item => item.key === track.key)
    if (exists) {
      return
    }
    playlist.value.push(track)
    if (firstAddedIndex === -1) {
      firstAddedIndex = playlist.value.length - 1
    }
  })
  return firstAddedIndex
}

/**
 * 追加单曲到播放列表（已存在时返回其下标，不自动播放）
 */
function addTrack(track: AudioTrack): number {
  const exists = playlist.value.findIndex(item => item.key === track.key)
  if (exists >= 0) {
    return exists
  }
  playlist.value.push(track)
  return playlist.value.length - 1
}

/** 移除指定下标的曲目；移除的是当前曲目时顺延下一首可用曲目，无可用曲目则停止 */
function removeAt(index: number) {
  if (index < 0 || index >= playlist.value.length) {
    return
  }
  const isCurrentTrack = index === currentIndex.value
  playlist.value.splice(index, 1)
  if (index < currentIndex.value) {
    currentIndex.value -= 1
  }
  else if (isCurrentTrack) {
    const nextIdx = findNextPlayableIndex(index)
    if (nextIdx >= 0) {
      playAt(nextIdx)
    }
    else {
      stop()
    }
  }
}

/** 清空播放列表并停止播放 */
function clearAll() {
  stop()
  playlist.value = []
}

/** 该 key 是否为当前播放条目 */
function isCurrent(key: string): boolean {
  return currentTrack.value?.key === key
}

/** 地址为空或已被标记为失效 */
function isBroken(url: string): boolean {
  return !url || brokenUrls.value.has(url)
}

/**
 * 全局音频播放器：HTML5 Audio 单例 + 共享播放列表。
 * 挂在布局根部的浮动条（FloatAudioBar）跨页面持续播放，
 * 专辑页负责入队/点播，移除/清空在浮动条队列面板完成。
 */
export function useAudioPlayerStore() {
  return {
    playlist,
    currentIndex,
    currentTrack,
    playing,
    currentTime,
    duration,
    volume,
    muted,
    brokenUrls,
    playAt,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    stop,
    playAlbum,
    addAlbum,
    addTrack,
    removeAt,
    clearAll,
    isCurrent,
    isBroken,
  }
}

export default useAudioPlayerStore
