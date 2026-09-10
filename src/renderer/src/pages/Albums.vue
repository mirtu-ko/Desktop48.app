<script setup lang="ts">
import type { AudioTrack } from '@renderer/composables/use-audio-player'
import type { AlbumSong, MusicAlbum } from '@renderer/services/api-types'
import { Headset, Link, Plus, ShoppingCart, VideoPlay } from '@element-plus/icons-vue'
import CoverImage from '@renderer/components/ui/CoverImage.vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import BaseSkeleton from '@renderer/components/ui/skeleton/BaseSkeleton.vue'
import useAudioPlayer from '@renderer/composables/use-audio-player'
import Apis from '@renderer/services/apis'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'

const albumList = ref<MusicAlbum[]>([])
const loading = ref(false)
/** 封面刷新版本：手动刷新时递增，保证同一封面 URL 也会重新请求 */
const imageVersion = ref(0)

/** 年份筛选：全部 + 数据中出现的年份（新→旧） */
const yearFilter = ref('0')

const yearTabs = computed(() => {
  const years = [...new Set(albumList.value.map(album => album.year).filter(Boolean))]
    .sort((a, b) => Number(b) - Number(a))
  return [{ label: '全部', key: '0' }, ...years.map(year => ({ label: year, key: year }))]
})

const filteredAlbums = computed(() =>
  yearFilter.value === '0'
    ? albumList.value
    : albumList.value.filter(album => album.year === yearFilter.value),
)

/** tag 字段 → 展示名 */
function tagLabel(tag: string): string {
  const map: Record<string, string> = { ep: 'EP', zj: '专辑', sg: '单曲' }
  return map[tag] || tag.toUpperCase()
}

/** tag 字段 → 徽章配色 class（EP 玫粉 / 专辑 品牌紫 / 单曲 青绿） */
function tagClass(tag: string): string {
  const map: Record<string, string> = {
    ep: 'album-tag--ep',
    zj: 'album-tag--zj',
    sg: 'album-tag--sg',
  }
  return map[tag] || ''
}

/** 发行日期：优先 start_time，缺失时回退 year */
function releaseDate(album: MusicAlbum): string {
  const ts = Number(album.start_time)
  return ts > 0 ? Tools.dateFormat(ts * 1000, 'yyyy-MM-dd') : album.year || '未知'
}

/** 专辑总时长（m:ss，忽略无时长的伴奏曲目） */
function totalTime(album: MusicAlbum): string {
  const total = album.song.reduce((sum, song) => {
    if (!song.songs_time) {
      return sum
    }
    const [m, s] = song.songs_time.split(':').map(Number)
    return sum + m * 60 + (s || 0)
  }, 0)
  if (!total) {
    return ''
  }
  return Tools.formatDuration(total)
}

/** 拉取 CDN 音乐 JSON 并按发行时间倒序 */
async function fetchAlbums() {
  loading.value = true
  try {
    const list: MusicAlbum[] = await Apis.instance().musicAlbums()
    list.sort((a, b) => Number(b.start_time) - Number(a.start_time))
    albumList.value = list
  }
  catch (error) {
    console.error('获取专辑信息失败:', error)
    // 失败原因已由 apis.musicAlbums 统一弹窗提示，这里不重复弹
  }
  finally {
    loading.value = false
  }
}

/** 已有数据时的轻量刷新反馈：卡片降透明度，完成后恢复 */
const isRefreshing = computed(() => loading.value && albumList.value.length > 0)

async function refreshAlbums() {
  imageVersion.value += 1
  await fetchAlbums()
}

const refresh = refreshAlbums

// 首次加载或刷新后无专辑时展示骨架；已有数据刷新不整页遮罩
const showSkeleton = computed(() => loading.value && albumList.value.length === 0)

/** 专辑详情抽屉 */
const detailVisible = ref(false)
const currentAlbum = ref<MusicAlbum | null>(null)

function openDetail(album: MusicAlbum) {
  currentAlbum.value = album
  detailVisible.value = true
}

// ===== 歌曲播放：全局迷你播放条（use-audio-player） =====
const { playlist, currentIndex, playing, playAt, playAlbum, addAlbum, addTrack, isCurrent, isBroken } = useAudioPlayer()

/** 曲目唯一键：专辑 sid + 歌曲 id */
function trackKey(album: MusicAlbum, song: AlbumSong): string {
  return `${album.sid}:${song.songs_id}`
}

/** 单曲 → 播放列表条目 */
function toTrack(album: MusicAlbum, song: AlbumSong): AudioTrack {
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
function toTracks(album: MusicAlbum): AudioTrack[] {
  return album.song.filter(song => song.url).map(song => toTrack(album, song))
}

/** 播放整张专辑（替换当前队列，从第一首开始） */
function playWholeAlbum(album: MusicAlbum) {
  const tracks = toTracks(album)
  if (!tracks.length) {
    ElMessage.info('这张专辑暂无可播放的音源')
    return
  }
  playAlbum(tracks)
}

/** 专辑概念/详情页（event 页） */
function openAlbumConcept(album: MusicAlbum) {
  if (album.link) {
    openExternal(album.link)
  }
}

/** 购买页（shop 商品页） */
function openAlbumShop(album: MusicAlbum) {
  if (album.href) {
    openExternal(album.href)
  }
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

/** 点击曲目：已在队列中直接播放，否则整张专辑入队后定位到该曲 */
function playFromAlbum(album: MusicAlbum, song: AlbumSong) {
  if (!song.url) {
    return
  }
  const existing = playlist.value.findIndex(track => track.key === trackKey(album, song))
  if (existing >= 0) {
    playAt(existing)
    return
  }
  addAlbum(toTracks(album))
  const idx = playlist.value.findIndex(track => track.key === trackKey(album, song))
  if (idx >= 0) {
    playAt(idx)
  }
}

/** 单曲加入播放列表；队列原本为空时自动播放该曲 */
function addSingle(album: MusicAlbum, song: AlbumSong) {
  if (!song.url) {
    return
  }
  const idx = addTrack(toTrack(album, song))
  if (currentIndex.value === -1) {
    playAt(idx)
  }
  ElMessage.success(`已把《${song.songs_name}》加入播放列表`)
}

/** 外链跳转：window.open 触发主进程 setWindowOpenHandler，转交系统浏览器打开 */
function openExternal(url: string) {
  window.open(url, '_blank', 'noopener')
}

onMounted(fetchAlbums)
</script>

<template>
  <div class="container page-root">
    <!-- 左上角浮动年份切换：磨砂玻璃，双击当前年份刷新 -->
    <FloatingTabBar
      :tabs="yearTabs"
      :active="yearFilter"
      @change="yearFilter = $event"
      @refresh="refresh"
    />

    <div v-if="showSkeleton" class="albums-skeleton" aria-busy="true">
      <div class="albums-grid">
        <div
          v-for="albumSkeleton in 8"
          :key="albumSkeleton"
          class="album-skeleton"
        >
          <BaseSkeleton
            class="album-cover"
            width="96px"
            height="96px"
            radius="var(--radius-lg)"
          />
          <div class="album-skeleton-info">
            <BaseSkeleton class="album-title-line" width="72%" height="18px" />
            <BaseSkeleton class="album-meta-line" width="48%" />
            <BaseSkeleton class="album-count-line" width="32%" />
          </div>
        </div>
      </div>
    </div>
    <el-scrollbar v-else class="scrollbar-wrapper">
      <div class="albums-container">
        <div
          class="albums-grid"
          :class="{ 'is-refreshing': isRefreshing }"
          :aria-busy="isRefreshing"
        >
          <!-- 专辑卡片：唱片套 + 探出的黑胶唱片，悬浮时唱片滑出旋转 -->
          <div
            v-for="album in filteredAlbums"
            :key="album.sid"
            class="album-card glass-card"
            @click="openDetail(album)"
          >
            <div class="album-cover">
              <div class="vinyl">
                <span class="vinyl-label">
                  <CoverImage class="vinyl-label-img" :src="album.image" :version="imageVersion" loading="lazy" />
                </span>
              </div>
              <!-- 原生懒加载：视口外不请求，滚动接近时浏览器提前预取，比 el-image 的滚动节流更早就位 -->
              <div class="cover-img">
                <CoverImage class="cover-src" :src="album.image" :version="imageVersion" loading="lazy">
                  <div class="cover-fallback">
                    <el-icon><Headset /></el-icon>
                  </div>
                </CoverImage>
              </div>
            </div>

            <div class="album-info">
              <div class="album-title ellipsis">
                {{ album.title }}
              </div>
              <div class="album-meta">
                <span class="album-tag" :class="tagClass(album.tag)">{{ tagLabel(album.tag) }}</span>
                <span class="album-singer ellipsis">{{ album.singer }} · {{ album.year }}</span>
              </div>
              <div class="album-count">
                {{ album.song.length }} 首<template v-if="totalTime(album)">
                  · {{ totalTime(album) }}
                </template>
              </div>
            </div>

            <!-- 悬浮快捷操作列：播放 / 概念 / 购买（hover 滑入，阻止冒泡不打开详情） -->
            <div class="card-actions">
              <el-tooltip content="播放专辑" placement="left" :show-after="300">
                <button
                  type="button"
                  class="quick-btn quick-btn--play"
                  @click.stop="playWholeAlbum(album)"
                >
                  <el-icon><VideoPlay /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="专辑概念" placement="left" :show-after="300">
                <button
                  type="button"
                  class="quick-btn"
                  :class="{ 'is-disabled': !album.link }"
                  @click.stop="openAlbumConcept(album)"
                >
                  <el-icon><Link /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="购买专辑" placement="left" :show-after="300">
                <button
                  type="button"
                  class="quick-btn"
                  :class="{ 'is-disabled': !album.href }"
                  @click.stop="openAlbumShop(album)"
                >
                  <el-icon><ShoppingCart /></el-icon>
                </button>
              </el-tooltip>
            </div>
          </div>
        </div>

        <el-empty
          v-if="!filteredAlbums.length && !loading"
          class="page-empty"
          :image-size="120"
          description="暂无专辑数据，点击右上角刷新试试"
        />
      </div>
      <div v-if="filteredAlbums.length" class="list-end">
        共 {{ filteredAlbums.length }} 张{{ yearFilter === '0' ? '' : `（${yearFilter} 年）` }}
      </div>
    </el-scrollbar>

    <!-- 右上角浮动刷新按钮 -->
    <FloatingRefreshDock
      :loading="loading"
      @refresh="refresh"
    />

    <!-- 专辑详情抽屉：氛围底 + 旋转黑胶 + 曲目列表 -->
    <el-drawer v-model="detailVisible" size="440px" :with-header="false" destroy-on-close>
      <div v-if="currentAlbum" class="album-detail">
        <div class="detail-hero">
          <img class="hero-bg" :src="currentAlbum.image" alt="">
          <div class="hero-cover">
            <div class="vinyl vinyl--big">
              <span
                class="vinyl-label"
                :style="{ backgroundImage: `url(${currentAlbum.image})` }"
              />
            </div>
            <el-image class="cover-img" :src="currentAlbum.image" fit="cover">
              <template #error>
                <div class="cover-fallback">
                  <el-icon><Headset /></el-icon>
                </div>
              </template>
            </el-image>
          </div>
          <h3 class="detail-title">
            {{ currentAlbum.title }}
          </h3>
          <div class="detail-meta">
            <span class="album-tag" :class="tagClass(currentAlbum.tag)">{{ tagLabel(currentAlbum.tag) }}</span>
            <span>{{ currentAlbum.singer }}</span>
            <span class="meta-dot">·</span>
            <span>{{ releaseDate(currentAlbum) }}</span>
            <span class="meta-dot">·</span>
            <span>{{ currentAlbum.song.length }} 首</span>
          </div>
          <div class="detail-actions">
            <el-button type="primary" round :icon="VideoPlay" @click="playWholeAlbum(currentAlbum)">
              播放全部
            </el-button>
            <el-button round :icon="Plus" @click="queueWholeAlbum(currentAlbum)">
              加入队列
            </el-button>
          </div>
        </div>

        <div class="track-list">
          <div
            v-for="(song, index) in currentAlbum.song"
            :key="song.songs_id"
            class="track-row"
            :class="{
              'is-current': isCurrent(trackKey(currentAlbum, song)),
              'is-broken': !song.url || isBroken(song.url),
            }"
            @click="playFromAlbum(currentAlbum, song)"
          >
            <span class="track-index">
              <!-- 当前播放：均衡器跳动 -->
              <span
                v-if="isCurrent(trackKey(currentAlbum, song))"
                class="eq"
                :class="{ paused: !playing }"
              ><i /><i /><i /></span>
              <template v-else>{{ String(index + 1).padStart(2, '0') }}</template>
            </span>
            <span class="track-name ellipsis">{{ song.songs_name }}</span>
            <button
              v-if="song.url"
              class="track-add"
              title="加入播放列表"
              @click.stop="addSingle(currentAlbum, song)"
            >
              <el-icon><Plus /></el-icon>
            </button>
            <span class="track-time">{{ song.songs_time || '--:--' }}</span>
          </div>
        </div>

        <!-- 底部操作区：专辑概念 / 购买入口（与成员详情抽屉底部按钮行同构） -->
        <div v-if="currentAlbum.link || currentAlbum.href" class="detail-footer">
          <el-button
            v-if="currentAlbum.link"
            :icon="Link"
            @click="openExternal(currentAlbum.link)"
          >
            专辑概念
          </el-button>
          <el-button
            v-if="currentAlbum.href"
            type="primary"
            :icon="ShoppingCart"
            @click="openExternal(currentAlbum.href)"
          >
            购买专辑
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped lang="scss">
/* ===== 页面骨架：与直播/公演页同构（相对定位 + 裁剪见全局 .page-root） ===== */

/* 底部留出 Dock 空间（--dock-reserve） */
:deep(.el-scrollbar__view) {
  padding-bottom: var(--dock-reserve);
}

.albums-container {
  /* 顶部留出左上角年份切换器空间（--tabbar-offset-top） */
  padding: var(--tabbar-offset-top) 16px 8px;
}

.albums-skeleton {
  padding: var(--tabbar-offset-top) 16px 8px;
}

.album-skeleton {
  position: relative;
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-lg);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
}

.album-skeleton-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.albums-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  transition:
    opacity 0.25s ease,
    filter 0.25s ease;

  &.is-refreshing {
    opacity: 0.58;
    filter: saturate(0.75);
    pointer-events: none;
  }
}

/* 空态：样式见全局 .page-empty */

/* ===== 专辑卡片：唱片套 + 探出的黑胶 ===== */
.album-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 12px;
  border-radius: var(--radius-lg);
  cursor: pointer;

  &:hover {
    .vinyl {
      transform: translateX(10px);
    }

    .vinyl-label {
      animation-play-state: running;
    }

    .album-title {
      color: var(--brand-primary);
    }

    .card-actions {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }
  }
}

/* 悬浮快捷操作列：播放 / 概念 / 购买，默认隐藏，hover 从右侧滑入 */
.card-actions {
  position: absolute;
  right: 10px;
  top: 50%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  opacity: 0;
  transform: translateY(-50%) translateX(8px);
  transition:
    opacity 0.2s ease,
    transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.quick-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid color-mix(in srgb, var(--el-border-color-lighter) 80%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--el-bg-color) 85%, transparent);
  backdrop-filter: blur(8px);
  color: var(--el-text-color-regular);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease;

  .el-icon {
    font-size: 15px;
  }

  &:hover {
    color: var(--brand-primary);
    border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
    box-shadow: var(--shadow-glow);
  }

  /* 播放：品牌渐变实心圆 */
  &.quick-btn--play {
    border: none;
    background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light));
    color: #fff;
    box-shadow: var(--shadow-glow);

    &:hover {
      background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-secondary));
      color: #fff;
    }
  }

  /* 无对应链接：置灰不可点（tooltip 仍可用） */
  &.is-disabled {
    opacity: 0.4;
    cursor: not-allowed;

    &:hover {
      color: var(--el-text-color-regular);
      border-color: color-mix(in srgb, var(--el-border-color-lighter) 80%, transparent);
      box-shadow: var(--shadow-sm);
    }
  }
}

.album-cover {
  position: relative;
  width: 96px;
  height: 96px;
  flex: none;
}

/* 黑胶唱片：藏在封面右侧，同心圆纹 + 品牌色环境反光 */
.vinyl {
  position: absolute;
  top: 7px;
  left: 36px;
  z-index: 0;
  width: 82px;
  height: 82px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, rgba(109, 90, 224, 0.18) 0 26%, transparent 27%),
    repeating-radial-gradient(circle at 50% 50%, #191920 0 2px, #23232c 2px 3px);
  box-shadow:
    0 8px 16px -6px rgba(var(--shadow-rgb), 0.4),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);

  /* 玻璃高光 */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0) 45%);
  }
}

/* 唱片中心盘标：用封面图充当，悬浮时旋转 */
.vinyl-label {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border-radius: 50%;
  background-size: cover;
  background-position: center;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
  /* 旋转动画见全局 @keyframes spin */
  animation: spin 7s linear infinite;
  animation-play-state: paused;
  overflow: hidden;

  /* 卡片盘标图：填满圆形盘面 */
  .vinyl-label-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* 中心孔 */
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 6px;
    margin: -3px 0 0 -3px;
    border-radius: 50%;
    background: var(--el-bg-color);
  }
}

.cover-img {
  position: relative;
  z-index: 1;
  display: block;
  width: 96px;
  height: 96px;
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  /* 骨架底色：图片在途时占位，避免快速滚动出现透明空洞 */
  background: var(--el-fill-color-light);
}

/* 卡片封面：解码完成才淡入，避免半张图闪现 */
.cover-src {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: cover-fade 0.25s ease;
}

.cover-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--brand-primary) 12%, var(--el-bg-color));
  color: var(--brand-primary);

  .el-icon {
    font-size: 26px;
  }
}

.album-info {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
}

.album-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  transition: color 0.2s ease;
}

.album-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* EP / 专辑 / 单曲 小徽章：不同类型不同配色（语义色见 app.scss 的 --color-* 变量） */
.album-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  line-height: 1.6;
  color: #fff;
  /* 默认（未知 tag）：中性灰 */
  background: linear-gradient(135deg, #909399, color-mix(in srgb, #909399 70%, #fff));
  box-shadow: 0 3px 8px -3px rgba(144, 147, 153, 0.55);

  &.album-tag--ep {
    /* EP：玫粉（与直播语义色同源） */
    background: linear-gradient(135deg, var(--color-lives), #ff8fb0);
    box-shadow: 0 3px 8px -3px color-mix(in srgb, var(--color-lives) 55%, transparent);
  }

  &.album-tag--zj {
    /* 专辑：品牌紫 */
    background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light));
    box-shadow: 0 3px 8px -3px var(--shadow-glow);
  }

  &.album-tag--sg {
    /* 单曲：青绿（与下载语义色同源） */
    background: linear-gradient(135deg, var(--color-downloads), #34d399);
    box-shadow: 0 3px 8px -3px color-mix(in srgb, var(--color-downloads) 55%, transparent);
  }
}

.album-singer {
  min-width: 0;
}

.album-count {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

/* ===== 详情抽屉 ===== */
.album-detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 头部：封面模糊放大的氛围底，内容浮于其上 */
.detail-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 28px 20px 22px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: color-mix(in srgb, var(--el-bg-color) 60%, transparent);

  .hero-bg {
    position: absolute;
    inset: -40px;
    width: calc(100% + 80px);
    height: calc(100% + 80px);
    object-fit: cover;
    filter: blur(46px) saturate(160%);
    opacity: 0.45;
    pointer-events: none;
  }

  /* 蒙一层浅色渐变保证文字可读 */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.05),
      color-mix(in srgb, var(--el-bg-color) 55%, transparent)
    );
    pointer-events: none;
  }

  > * {
    position: relative;
    z-index: 1;
  }
}

.hero-cover {
  position: relative;
  width: 148px;
  height: 148px;
}

.vinyl--big {
  top: 11px;
  left: 56px;
  width: 126px;
  height: 126px;
  transform: none;

  .vinyl-label {
    width: 52px;
    height: 52px;
    margin: -26px 0 0 -26px;
    /* 详情页唱片持续旋转 */
    animation-play-state: running;
  }
}

.hero-cover .cover-img {
  width: 148px;
  height: 148px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.detail-title {
  margin: 18px 0 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  text-align: center;
  text-shadow: 0 1px 8px rgba(255, 255, 255, 0.6);
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);

  .meta-dot {
    color: var(--el-text-color-placeholder);
  }
}

/* 播放全部 / 加入队列 */
.detail-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

/* 底部操作区：专辑概念 / 购买入口，按钮平分一行（与成员详情抽屉底部同构） */
.detail-footer {
  display: flex;
  gap: 10px;

  :deep(.el-button) {
    flex: 1;
    margin-left: 0;
  }
}

/* 曲目列表 */
.track-list {
  display: flex;
  flex-direction: column;
}

.track-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 8px;
  border-radius: var(--radius-sm);
  transition: background-color 0.2s ease;

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 6%, transparent);

    .track-index {
      color: var(--brand-primary);
    }

    .track-add {
      opacity: 1;
    }
  }

  &.is-current {
    background: color-mix(in srgb, var(--brand-primary) 9%, transparent);

    .track-name {
      color: var(--brand-primary);
      font-weight: 600;
    }
  }

  /* 无音源/加载失效：置灰不可点 */
  &.is-broken {
    opacity: 0.45;
    cursor: not-allowed;
  }

  & + .track-row {
    border-top: 1px solid var(--el-border-color-extra-light);
  }
}

/* 单曲加入队列按钮：悬浮行时出现 */
.track-add {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;

  .el-icon {
    font-size: 14px;
  }

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 14%, transparent);
    color: var(--brand-primary);
  }
}

/* 均衡器动效 .eq 见全局 app.scss */

.track-index {
  flex: none;
  width: 24px;
  font-size: 12px;
  font-style: italic;
  font-weight: 700;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
  transition: color 0.2s ease;
}

.track-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.track-time {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

@keyframes cover-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
