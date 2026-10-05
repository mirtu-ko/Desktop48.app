import type { AlbumSong, MusicAlbum } from '../src/renderer/src/services/api-types'
import { describe, expect, it } from 'vitest'
import { playableCount, releaseDate, songSeconds, tagClass, tagLabel, totalTime, toTrack, toTracks, trackKey } from '../src/renderer/src/utils/album'

function makeSong(extra: Partial<AlbumSong> = {}): AlbumSong {
  return { songs_id: '1001', songs_name: '夜风', songs_time: '3:45', url: 'https://cdn/1001.mp3', ...extra }
}

function makeAlbum(extra: Partial<MusicAlbum> = {}): MusicAlbum {
  return {
    sid: 'alb-1',
    title: '第一章',
    singer: 'SNH48',
    tag: 'zj',
    image: 'https://cdn/cover.jpg',
    year: '2024',
    start_time: '',
    link: '',
    href: '',
    song: [makeSong()],
    ...extra,
  }
}

describe('album.trackKey', () => {
  it('拼成 sid:歌曲id', () => {
    expect(trackKey(makeAlbum(), makeSong())).toBe('alb-1:1001')
  })

  it('同歌曲 id 出现在两张专辑里是两个不同的键', () => {
    const song = makeSong()
    expect(trackKey(makeAlbum({ sid: 'a' }), song)).not.toBe(trackKey(makeAlbum({ sid: 'b' }), song))
  })
})

describe('album.toTrack', () => {
  it('专辑与歌曲的字段各自落到对应位置', () => {
    expect(toTrack(makeAlbum(), makeSong())).toEqual({
      key: 'alb-1:1001',
      songsId: '1001',
      sid: 'alb-1',
      name: '夜风',
      url: 'https://cdn/1001.mp3',
      cover: 'https://cdn/cover.jpg',
      albumTitle: '第一章',
      singer: 'SNH48',
    })
  })

  it('url 为 null 时落成空串（AudioTrack.url 是 string）', () => {
    expect(toTrack(makeAlbum(), makeSong({ url: null })).url).toBe('')
  })
})

describe('album.toTracks', () => {
  it('过滤掉无音源的伴奏曲目，保留原顺序', () => {
    const album = makeAlbum({
      song: [
        makeSong({ songs_id: '1', songs_name: 'A' }),
        makeSong({ songs_id: '2', songs_name: 'B', url: null }),
        makeSong({ songs_id: '3', songs_name: 'C' }),
      ],
    })
    expect(toTracks(album).map(track => track.name)).toEqual(['A', 'C'])
  })

  it('空专辑返回空数组', () => {
    expect(toTracks(makeAlbum({ song: [] }))).toEqual([])
  })
})

describe('album.playableCount', () => {
  it('只数有音源的曲目', () => {
    const album = makeAlbum({
      song: [
        makeSong({ songs_id: '1' }),
        makeSong({ songs_id: '2', url: null }),
        makeSong({ songs_id: '3' }),
      ],
    })
    expect(playableCount(album)).toBe(2)
    expect(playableCount(makeAlbum({ song: [] }))).toBe(0)
  })
})

describe('album.songSeconds', () => {
  it('解析 m:ss', () => {
    expect(songSeconds(makeSong({ songs_time: '3:45' }))).toBe(225)
    expect(songSeconds(makeSong({ songs_time: '12:03' }))).toBe(723)
    expect(songSeconds(makeSong({ songs_time: '0:30' }))).toBe(30)
  })

  it('null / 空串 / 不可解析一律按 0', () => {
    expect(songSeconds(makeSong({ songs_time: null }))).toBe(0)
    expect(songSeconds(makeSong({ songs_time: '' }))).toBe(0)
    expect(songSeconds(makeSong({ songs_time: '--:--' }))).toBe(0)
  })

  it('秒段缺失按 0（"3:" 是 3 分钟整）', () => {
    expect(songSeconds(makeSong({ songs_time: '3:' }))).toBe(180)
  })
})

describe('album.totalTime', () => {
  it('累加各曲时长', () => {
    const album = makeAlbum({
      song: [makeSong({ songs_time: '3:00' }), makeSong({ songs_time: '2:30' })],
    })
    expect(totalTime(album)).toBe('05:30')
  })

  it('忽略无时长的伴奏曲目', () => {
    const album = makeAlbum({
      song: [makeSong({ songs_time: '3:00' }), makeSong({ songs_time: null })],
    })
    expect(totalTime(album)).toBe('03:00')
  })

  it('无一首有时长时返回空串（调用方据此隐藏这段文案）', () => {
    const album = makeAlbum({ song: [makeSong({ songs_time: null })] })
    expect(totalTime(album)).toBe('')
  })

  it('超过 1 小时切成 hh:mm:ss', () => {
    const album = makeAlbum({
      song: [makeSong({ songs_time: '40:00' }), makeSong({ songs_time: '25:00' })],
    })
    expect(totalTime(album)).toBe('01:05:00')
  })
})

describe('album.tagLabel / tagClass', () => {
  it('已知 tag 映射到展示名与配色 class', () => {
    expect(tagLabel('ep')).toBe('EP')
    expect(tagLabel('zj')).toBe('专辑')
    expect(tagLabel('sg')).toBe('单曲')
    expect(tagClass('ep')).toBe('album-tag--ep')
    expect(tagClass('zj')).toBe('album-tag--zj')
    expect(tagClass('sg')).toBe('album-tag--sg')
  })

  it('未知 tag：展示名走大写，配色返回空串（由样式兜底中性灰）', () => {
    expect(tagLabel('mv')).toBe('MV')
    expect(tagClass('mv')).toBe('')
    expect(tagClass('')).toBe('')
  })
})

describe('album.releaseDate', () => {
  it('有 start_time 时按秒级时间戳格式化', () => {
    const ts = Math.floor(new Date(2024, 4, 20).getTime() / 1000)
    expect(releaseDate(makeAlbum({ start_time: String(ts) }))).toBe('2024-05-20')
  })

  it('start_time 缺失或为 0 时回退 year', () => {
    expect(releaseDate(makeAlbum({ start_time: '', year: '2021' }))).toBe('2021')
    expect(releaseDate(makeAlbum({ start_time: '0', year: '2021' }))).toBe('2021')
  })

  it('两者都没有时返回「未知」', () => {
    expect(releaseDate(makeAlbum({ start_time: '', year: '' }))).toBe('未知')
  })
})
