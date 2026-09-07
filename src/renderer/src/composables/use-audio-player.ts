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

// ===== 模块级单例：跨页面（keep-alive 复用）共享播放列表与播放状态 =====
const playlist = ref<AudioTrack[]>([])
const currentIndex = ref(-1)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
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
  audio.addEventListener('ended', () => {
    next()
  })
  audio.addEventListener('error', () => {
    const track = currentTrack.value
    if (track && audio?.src && track.url && audio.src.includes(track.url)) {
      console.error('[use-audio-player]音频加载失败，标记失效:', track.url)
      // 替换整个 Set 才能触发 shallowRef 的依赖更新（原地 add 不会）
      brokenUrls.value = new Set(brokenUrls.value).add(track.url)
      // 自动顺延下一首，没有下一首则停止
      if (currentIndex.value < playlist.value.length - 1) {
        playAt(currentIndex.value + 1)
      }
      else {
        stop()
      }
    }
  })
  return audio
}

/** 播放指定下标的曲目；再次点击当前曲目时切换播放/暂停 */
function playAt(index: number) {
  const track = playlist.value[index]
  if (!track || !track.url) {
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
  void el.play().catch(error => console.error('[use-audio-player] 播放失败:', error))
}

/** 播放/暂停切换 */
function togglePlay() {
  if (!audio || !currentTrack.value) {
    return
  }
  if (audio.paused) {
    void audio.play().catch(error => console.error('[use-audio-player] 播放失败:', error))
  }
  else {
    audio.pause()
  }
}

/** 下一首：播放到队列末尾自动停止 */
function next() {
  if (currentIndex.value < playlist.value.length - 1) {
    playAt(currentIndex.value + 1)
  }
  else {
    audio?.pause()
  }
}

/** 上一首：播放超过 3 秒时回到本曲开头 */
function prev() {
  if (currentTime.value > 3) {
    seek(0)
    return
  }
  if (currentIndex.value > 0) {
    playAt(currentIndex.value - 1)
  }
  else {
    seek(0)
  }
}

/** 跳转到指定秒数 */
function seek(seconds: number) {
  if (!audio || !currentTrack.value) {
    return
  }
  audio.currentTime = Math.min(Math.max(seconds, 0), duration.value || audio.duration || 0)
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
 * 整单替换播放列表并从指定下标开始播放
 * @param tracks 已过滤无音源曲目的曲目数组
 * @param startIndex 起始下标
 */
function playAlbum(tracks: AudioTrack[], startIndex = 0) {
  if (!tracks.length) {
    return
  }
  playlist.value = [...tracks]
  playAt(Math.min(Math.max(startIndex, 0), tracks.length - 1))
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
 * @returns 曲目在播放列表中的下标
 */
function addTrack(track: AudioTrack): number {
  const exists = playlist.value.findIndex(item => item.key === track.key)
  if (exists >= 0) {
    return exists
  }
  playlist.value.push(track)
  return playlist.value.length - 1
}

/** 移除指定下标的曲目；移除的是当前曲目时顺延播放，队列空则停止 */
function removeAt(index: number) {
  if (index < 0 || index >= playlist.value.length) {
    return
  }
  const isCurrent = index === currentIndex.value
  playlist.value.splice(index, 1)
  if (index < currentIndex.value) {
    currentIndex.value -= 1
  }
  else if (isCurrent) {
    if (index < playlist.value.length) {
      playAt(index)
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
export function useAudioPlayer() {
  return {
    playlist,
    currentIndex,
    currentTrack,
    playing,
    currentTime,
    duration,
    brokenUrls,
    playAt,
    togglePlay,
    next,
    prev,
    seek,
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

export default useAudioPlayer
