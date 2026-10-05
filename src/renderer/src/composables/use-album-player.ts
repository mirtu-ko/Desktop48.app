/** 专辑播放：专辑页（网格快捷按钮）与专辑详情卡片共用一套点播 / 入队规则，状态读写都落在 stores/audio-player 单例上 */
import type { AlbumSong, MusicAlbum } from '@renderer/services/api-types'
import useAudioPlayerStore from '@renderer/stores/audio-player'
import { toTrack, toTracks, trackKey } from '@renderer/utils/album'
import { ElMessage } from 'element-plus'

export function useAlbumPlayer() {
  const { playlist, currentIndex, playing, playAt, playAlbum, addAlbum, addTrack, isCurrent, isBroken } = useAudioPlayerStore()

  /** 该曲目是否为当前播放条目 */
  function isCurrentTrack(album: MusicAlbum, song: AlbumSong): boolean {
    return isCurrent(trackKey(album, song))
  }

  /** 无音源或已被标记为加载失效 */
  function isBrokenTrack(song: AlbumSong): boolean {
    return !song.url || isBroken(song.url)
  }

  /** 播放整张专辑：替换当前队列，从第一首开始 */
  function playWholeAlbum(album: MusicAlbum) {
    const tracks = toTracks(album)
    if (!tracks.length) {
      ElMessage.info('这张专辑暂无可播放的音源')
      return
    }
    playAlbum(tracks)
  }

  /** 整张专辑追加进播放列表；队列原本为空时自动开始播放 */
  function queueWholeAlbum(album: MusicAlbum) {
    const firstAdded = addAlbum(toTracks(album))
    if (firstAdded === -1) {
      ElMessage.info('这张专辑的曲目已在播放列表中')
      return
    }
    if (currentIndex.value === -1) {
      playAt(firstAdded)
    }
    ElMessage.success(`已把《${album.title}》加入播放列表`)
  }

  /** 点击曲目：已在队列中直接播放，否则先入队再播 */
  function playFromAlbum(album: MusicAlbum, song: AlbumSong) {
    if (!song.url) {
      return
    }
    const existing = playlist.value.findIndex(track => track.key === trackKey(album, song))
    if (existing >= 0) {
      playAt(existing)
      return
    }
    playAt(addTrack(toTrack(album, song)))
  }

  /** 单曲加入播放列表；队列原本为空时自动播放该曲 */
  function addSingle(album: MusicAlbum, song: AlbumSong) {
    if (!song.url) {
      return
    }
    const index = addTrack(toTrack(album, song))
    if (currentIndex.value === -1) {
      playAt(index)
    }
    ElMessage.success(`已把《${song.songs_name}》加入播放列表`)
  }

  /** 专辑概念页（event 页）外链 */
  function openAlbumConcept(album: MusicAlbum) {
    if (album.link) {
      openExternal(album.link)
    }
  }

  /** 购买页（shop 商品页）外链 */
  function openAlbumShop(album: MusicAlbum) {
    if (album.href) {
      openExternal(album.href)
    }
  }

  return {
    playing,
    isCurrentTrack,
    isBrokenTrack,
    playWholeAlbum,
    queueWholeAlbum,
    playFromAlbum,
    addSingle,
    openAlbumConcept,
    openAlbumShop,
  }
}

/** 外链跳转：window.open 触发主进程 setWindowOpenHandler，转交系统浏览器打开 */
function openExternal(url: string) {
  window.open(url, '_blank', 'noopener')
}
