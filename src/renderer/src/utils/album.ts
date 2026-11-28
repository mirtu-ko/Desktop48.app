import type { AlbumSong, MusicAlbum } from '@renderer/services/api-types'
import type { AudioTrack } from '@renderer/stores/audio-player'
import { formatMediaTime } from '@renderer/utils/time-format'
import dayjs from 'dayjs'

/** 专辑的纯函数层（可脱离 Electron 单测）：曲目转换 / 时长 / 标签 / 发行日期。播放动作见 composables/use-album-player.ts */

/** 曲目唯一键：专辑 sid + 歌曲 id */
export function trackKey(album: MusicAlbum, song: AlbumSong): string {
  return `${album.sid}:${song.songs_id}`
}

/** 单曲 → 播放列表条目 */
export function toTrack(album: MusicAlbum, song: AlbumSong): AudioTrack {
  return {
    key: trackKey(album, song),
    songsId: song.songs_id,
    sid: album.sid,
    name: song.songs_name,
    url: song.url || '',
    cover: album.image,
    albumTitle: album.title,
    singer: album.singer,
  }
}

/** 专辑 → 可播放曲目（过滤无音源的伴奏） */
export function toTracks(album: MusicAlbum): AudioTrack[] {
  return album.song.filter(song => song.url).map(song => toTrack(album, song))
}

/** 可播放曲目数（少于总曲目数说明有伴奏没音源） */
export function playableCount(album: MusicAlbum): number {
  return album.song.filter(song => song.url).length
}

/** 单曲时长 'm:ss' → 秒；缺失或不可解析按 0 */
export function songSeconds(song: AlbumSong): number {
  if (!song.songs_time) {
    return 0
  }
  const [m, s] = song.songs_time.split(':').map(Number)
  if (!Number.isFinite(m)) {
    return 0
  }
  return m * 60 + (Number.isFinite(s) ? s : 0)
}

/** 专辑总时长（不足 1 小时 mm:ss，超过 hh:mm:ss；无一首有时长时返回空串） */
export function totalTime(album: MusicAlbum): string {
  const total = album.song.reduce((sum, song) => sum + songSeconds(song), 0)
  return total > 0 ? formatMediaTime(total) : ''
}

/** tag 字段 → 展示名 */
export function tagLabel(tag: string): string {
  const map: Record<string, string> = { ep: 'EP', zj: '专辑', sg: '单曲' }
  return map[tag] || tag.toUpperCase()
}

/** tag 字段 → 徽章配色 class（EP 玫粉 / 专辑 品牌紫 / 单曲 青绿；未知 tag 返回空串走中性灰） */
export function tagClass(tag: string): string {
  const map: Record<string, string> = {
    ep: 'album-tag--ep',
    zj: 'album-tag--zj',
    sg: 'album-tag--sg',
  }
  return map[tag] || ''
}

/** 发行日期：优先 start_time（秒级时间戳），缺失时回退 year */
export function releaseDate(album: MusicAlbum): string {
  const ts = Number(album.start_time)
  return ts > 0 ? dayjs(ts * 1000).format('YYYY-MM-DD') : album.year || '未知'
}

/** 随机播放默认抽取曲目数 */
export const RANDOM_PICK_COUNT = 15

export interface PickRandomTracksOptions {
  /** 抽取数量，默认 15 */
  count?: number
  /** 判定音源是否已失效（如 audio-player 的 isBroken） */
  isBroken?: (url: string) => boolean
  /** 上一批刚抽过的曲目 key，曲库充足时优先避开以实现「换一批」手感 */
  excludeKeys?: ReadonlySet<string>
  /** 随机数发生器（测试可注入） */
  random?: () => number
}

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/**
 * 从曲库随机抽取指定数量的可播放曲目：
 * 1. 过滤无音源伴奏与已标记失效的链接
 * 2. 按音源 URL 去重（同一首歌收录在多张专辑/精选集时只入池一次）
 * 3. 优先从未在 excludeKeys 中的曲目抽满，不足时再从 excludeKeys 中补足
 */
export function pickRandomTracks(
  albums: MusicAlbum[],
  options: PickRandomTracksOptions = {},
): AudioTrack[] {
  const count = Math.max(0, Math.floor(options.count ?? RANDOM_PICK_COUNT))
  if (count === 0)
    return []

  const isBroken = options.isBroken
  const excludeKeys = options.excludeKeys
  const random = options.random ?? Math.random

  const seenUrls = new Set<string>()
  const fresh: AudioTrack[] = []
  const recent: AudioTrack[] = []

  for (const album of albums) {
    for (const song of album.song) {
      if (!song.url || isBroken?.(song.url) || seenUrls.has(song.url))
        continue
      seenUrls.add(song.url)
      const track = toTrack(album, song)
      if (excludeKeys?.has(track.key))
        recent.push(track)
      else
        fresh.push(track)
    }
  }

  shuffleInPlace(fresh, random)
  if (fresh.length >= count)
    return fresh.slice(0, count)

  shuffleInPlace(recent, random)
  return [...fresh, ...recent.slice(0, count - fresh.length)]
}
