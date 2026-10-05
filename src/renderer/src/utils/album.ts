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
