<script setup lang="ts">
import type { MusicAlbum } from '@renderer/services/api-types'
import { Headset, Link, ShoppingCart, VideoPlay } from '@element-plus/icons-vue'
import AlbumDetailCard from '@renderer/components/ui/AlbumDetailCard.vue'
import CoverImage from '@renderer/components/ui/CoverImage.vue'
import FloatingRefreshDock from '@renderer/components/ui/FloatingRefreshDock.vue'
import FloatingTabBar from '@renderer/components/ui/FloatingTabBar.vue'
import BaseSkeleton from '@renderer/components/ui/skeleton/BaseSkeleton.vue'
import { useAlbumPlayer } from '@renderer/composables/use-album-player'
import Apis from '@renderer/services/apis'
import { tagClass, tagLabel, totalTime } from '@renderer/utils/album'
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

/** 拉取 CDN 音乐 JSON 并按发行时间倒序 */
async function fetchAlbums() {
  loading.value = true
  try {
    const list: MusicAlbum[] = await Apis.musicAlbums()
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

// ===== 歌曲播放：全局迷你播放条（use-album-player） =====
const { playWholeAlbum, openAlbumConcept, openAlbumShop } = useAlbumPlayer()

/** 专辑详情卡片（null = 卡片关闭） */
const currentAlbum = ref<MusicAlbum | null>(null)

function openDetail(album: MusicAlbum) {
  currentAlbum.value = album
}

/** 按当前可见顺序（年份筛选后）铺平，切专辑不跳出当前年份 tab */
const selectedIndex = computed(() =>
  currentAlbum.value
    ? filteredAlbums.value.findIndex(album => album.sid === currentAlbum.value?.sid)
    : -1,
)

const hasPrevAlbum = computed(() => selectedIndex.value > 0)
const hasNextAlbum = computed(() =>
  selectedIndex.value >= 0 && selectedIndex.value < filteredAlbums.value.length - 1,
)

function stepAlbum(delta: number) {
  const next = filteredAlbums.value[selectedIndex.value + delta]
  if (next) {
    currentAlbum.value = next
  }
}

onMounted(fetchAlbums)
</script>

<template>
  <div class="page-root">
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
                  <CoverImage class="media-fill" :src="album.image" :version="imageVersion" loading="lazy" />
                </span>
              </div>
              <!-- 原生懒加载：视口外不请求，滚动接近时浏览器提前预取，比 el-image 的滚动节流更早就位 -->
              <div class="cover-img">
                <CoverImage class="cover-src media-fill" :src="album.image" :version="imageVersion" loading="lazy">
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

    <!-- 专辑详情卡片：全屏蒙版 + 左专辑栏 / 右曲目列表，↑ / ↓ 切专辑 -->
    <AlbumDetailCard
      :album="currentAlbum"
      :version="imageVersion"
      :has-prev="hasPrevAlbum"
      :has-next="hasNextAlbum"
      @close="currentAlbum = null"
      @prev="stepAlbum(-1)"
      @next="stepAlbum(1)"
    />
  </div>
</template>

<style scoped lang="scss">
/* ===== 页面骨架：与直播/公演页同构（相对定位 + 裁剪见全局 .page-root；
 * 滚动区给 Dock 的底部预留也由全局 .page-root .el-scrollbar__view 统一提供） ===== */

.albums-container {
  /* 顶部留出左上角年份切换器空间（--tabbar-offset-top） */
  padding: var(--page-pad);
}

.albums-skeleton {
  padding: var(--page-pad);
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
    background: var(--gradient-brand);
    color: #fff;
    box-shadow: var(--shadow-glow);

    &:hover {
      background: var(--gradient-brand-hover);
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

/* 黑胶唱片：藏在封面右侧（纹理见全局 .vinyl），列表里悬停才滑出并起转 */
.vinyl {
  top: 7px;
  left: 36px;
  width: 82px;
  height: 82px;
}

/* 唱片中心盘标：用封面图充当 */
.vinyl-label {
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  animation-play-state: paused;
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

.album-singer {
  min-width: 0;
}

.album-count {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}
</style>
