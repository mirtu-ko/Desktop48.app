<script setup lang="ts">
import type { AlbumSong, MusicAlbum } from '@renderer/services/api-types'
import { Close, Headset, Link, Plus, ShoppingCart, VideoPlay } from '@element-plus/icons-vue'
import CoverImage from '@renderer/components/ui/CoverImage.vue'
import { useAlbumPlayer } from '@renderer/composables/use-album-player'
import { playableCount, releaseDate, tagClass, tagLabel, totalTime } from '@renderer/utils/album'
import { computed, onBeforeUnmount, onMounted } from 'vue'

/** 专辑详情卡片：左栏封面 / 黑胶 / 元信息 / 全部操作，右栏曲目列表独立滚动。播放规则见 composables/use-album-player */
const props = defineProps<{
  album: MusicAlbum | null
  /** 封面刷新版本号，透传给 CoverImage 做 cache-busting */
  version?: number
  /** 上一个 / 下一个专辑是否存在；不传则 ↑ / ↓ 不响应 */
  hasPrev?: boolean
  hasNext?: boolean
}>()
const emit = defineEmits<{
  close: []
  prev: []
  next: []
}>()

const {
  playing,
  isCurrentTrack,
  isBrokenTrack,
  playWholeAlbum,
  queueWholeAlbum,
  playFromAlbum,
  addSingle,
  openAlbumConcept,
  openAlbumShop,
} = useAlbumPlayer()

const playable = computed(() => (props.album ? playableCount(props.album) : 0))
const duration = computed(() => (props.album ? totalTime(props.album) : ''))

/** 点击曲目：无音源 / 已失效的曲目不响应（置灰行的 cursor 只是提示，得真拦住） */
function onTrackClick(album: MusicAlbum, song: AlbumSong) {
  if (isBrokenTrack(song)) {
    return
  }
  playFromAlbum(album, song)
}

/** ===== 键盘：↑ / ↓ 切专辑，Esc 关闭由 el-dialog 自带 ===== */
function onKeydown(event: KeyboardEvent) {
  if (!props.album) {
    return
  }
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    return
  }
  // 曲目列表本身可滚动，↑ / ↓ 会被原生滚动吃掉：先 preventDefault 抢过来，列表滚动交给滚轮
  if (event.key === 'ArrowUp' && props.hasPrev) {
    event.preventDefault()
    emit('prev')
  }
  else if (event.key === 'ArrowDown' && props.hasNext) {
    event.preventDefault()
    emit('next')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 关闭卡片（点击蒙版 / ESC / 关闭按钮） */
function onVisibilityChange(value: boolean) {
  if (!value) {
    emit('close')
  }
}
</script>

<template>
  <el-dialog
    class="detail-card-dialog"
    modal-class="detail-card-overlay"
    :model-value="!!album"
    :show-close="false"
    align-center
    append-to-body
    @update:model-value="onVisibilityChange"
  >
    <div v-if="album" :key="album.sid" class="detail-card">
      <!-- 左栏：专辑自身的身份与全部操作入口 -->
      <div class="side">
        <div class="side-bg" :style="{ backgroundImage: `url(${album.image})` }" />
        <div class="side-scrim" />

        <div class="side-body detail-scroll">
          <div class="side-inner">
            <div class="hero-cover">
              <div class="vinyl">
                <span class="vinyl-label" :style="{ backgroundImage: `url(${album.image})` }" />
              </div>
              <div class="cover-img">
                <CoverImage
                  class="cover-src media-fill"
                  :src="album.image"
                  :version="version"
                  :alt="album.title"
                >
                  <div class="cover-fallback">
                    <el-icon><Headset /></el-icon>
                  </div>
                </CoverImage>
              </div>
            </div>

            <h3 class="side-title" :title="album.title">
              {{ album.title }}
            </h3>

            <div class="side-meta">
              <span class="album-tag" :class="tagClass(album.tag)">{{ tagLabel(album.tag) }}</span>
              <span class="ellipsis">{{ album.singer }}</span>
              <span class="meta-dot">·</span>
              <span>{{ releaseDate(album) }}</span>
            </div>

            <div class="side-count">
              {{ playable }} 首可播放<template v-if="playable !== album.song.length">
                （共 {{ album.song.length }} 首）
              </template>
              <template v-if="duration">
                · {{ duration }}
              </template>
            </div>

            <div v-if="album.link || album.href" class="side-links">
              <el-button v-if="album.link" :icon="Link" @click="openAlbumConcept(album)">
                专辑概念
              </el-button>
              <el-button v-if="album.href" :icon="ShoppingCart" @click="openAlbumShop(album)">
                购买专辑
              </el-button>
            </div>

            <div class="side-actions">
              <el-button type="primary" :icon="VideoPlay" @click="playWholeAlbum(album)">
                播放全部
              </el-button>
              <el-button :icon="Plus" @click="queueWholeAlbum(album)">
                加入队列
              </el-button>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏：曲目列表，独立滚动（左栏不跟着一起滚走） -->
      <div class="tracks">
        <div class="tracks-head">
          <span class="tracks-title">曲目</span>
          <span class="tracks-sub">{{ album.song.length }} 首</span>
          <span v-if="hasPrev || hasNext" class="tracks-hint">↑ ↓ 切换专辑</span>
        </div>

        <!-- tabindex 让列表可聚焦：↑ / ↓ 已被卡片占用，键盘滚动靠聚焦后的 PgUp / PgDn -->
        <div class="track-list detail-scroll" tabindex="0">
          <div
            v-for="(song, index) in album.song"
            :key="song.songs_id"
            class="track-row"
            :class="{
              'is-current': isCurrentTrack(album, song),
              'is-broken': isBrokenTrack(song),
            }"
            :style="{ '--i': index }"
            @click="onTrackClick(album, song)"
          >
            <span class="track-index">
              <!-- 当前播放：均衡器跳动 -->
              <span
                v-if="isCurrentTrack(album, song)"
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
              aria-label="加入播放列表"
              @click.stop="addSingle(album, song)"
            >
              <el-icon><Plus /></el-icon>
            </button>
            <span class="track-time">{{ song.songs_time || '--:--' }}</span>
          </div>
        </div>
      </div>

      <button class="detail-close" title="关闭" @click="emit('close')">
        <el-icon :size="15">
          <Close />
        </el-icon>
      </button>
    </div>
  </el-dialog>
</template>

<!-- 外壳 / 卡面 / 关闭钮 / 滚动列的样式见全局 app.scss 的「详情卡片共用」，这里只留本卡独有的部分 -->
<style scoped lang="scss">
/* ===== 入场：外壳不动，左栏元素与右栏曲目错峰上浮（曲线与时长与成员卡一致） =====
 * 别给 .detail-card 整体加淡入：卡片按 album.sid 重挂，切专辑时整卡会从 opacity: 0 重放一遍，
 * 看着就是「消失再出现」的闪烁 */
.side-inner > *,
.tracks-head,
.track-row {
  animation: detail-enter 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* 左栏元素依次上浮，步长与成员卡一致 */
.side-inner {
  @for $i from 1 through 6 {
    > *:nth-child(#{$i}) {
      animation-delay: 0.04s * $i;
    }
  }
}

.tracks-head {
  animation-delay: 0.06s;
}

/* 曲目逐行上浮。只错峰前 8 行（序号由模板给到 --i），再长的专辑后面几行一起进来 */
.track-row {
  animation-delay: calc(0.08s + min(var(--i, 0), 8) * 0.03s);
}

/* ===== 左栏：封面 / 黑胶 / 元信息 / 操作 ===== */
.side {
  position: relative;
  /* 窄窗口时收到 300px 为止，不再继续压，剩余宽度全给曲目列表 */
  flex: 0 0 clamp(300px, 40%, 420px);
  display: flex;
  overflow: hidden;
  background: var(--el-fill-color-light);
}

/* 封面模糊放大的氛围底 */
.side-bg {
  position: absolute;
  inset: -40px;
  background-position: center;
  background-size: cover;
  filter: blur(46px) saturate(160%);
  opacity: 0.5;
  pointer-events: none;
}

/* 压一层浅色渐变保证文字可读 */
.side-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.12),
    color-mix(in srgb, var(--el-bg-color) 78%, transparent)
  );
  pointer-events: none;
}

.side-body {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* box-sizing 必须显式声明：项目没有全局 border-box 重置，content-box 下 width:100% + 左右 padding
 * 会把这一栏撑出 44px，操作行被 .side 的 overflow:hidden 切掉右半边。
 * 排布用 space-evenly 而非「贴顶 + 按钮钉底」：定高 660px 装 ~570px 内容，
 * 钉底会把差额全堆成标题区与按钮之间的一块空白 */
.side-inner {
  box-sizing: border-box;
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-evenly;
  gap: 10px;
  width: 100%;
  padding: 26px 22px 22px;
  text-align: center;
}

/* 封面尺寸跟着卡片高度走（卡片高 min(86vh, 660px)）：矮窗口时自己缩回，左栏不撑出滚动条。
 * 250px 是封面之外要占的高度；右端留 16px 给黑胶探出，否则被 .side 的 overflow:hidden 切平 */
.hero-cover {
  position: relative;
  flex: none;
  width: clamp(160px, calc(min(86vh, 660px) - 250px), calc(100% - 16px));
  aspect-ratio: 1;
}

/* 黑胶：藏在封面右侧探出一截（纹理见全局 .vinyl）。探出量用 px，按比例放大会出界 */
.vinyl {
  top: 6.5%;
  right: -20px;
  width: 86%;
  height: 86%;
}

/* 唱片中心盘标：用封面图充当 */
.vinyl-label {
  width: 40%;
  height: 40%;
  margin: -20% 0 0 -20%;
}

.cover-img {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-md);
  /* 骨架底色：图片在途时占位，避免出现透明空洞 */
  background: var(--el-fill-color-light);
}

/* 卡面封面比列表卡片大，兜底图标跟着放大（.cover-fallback 基础样式在全局） */
.cover-fallback .el-icon {
  font-size: 44px;
}

/* 长标题最多两行 */
.side-title {
  max-width: 100%;
  margin: 2px 0 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.32;
  color: var(--el-text-color-primary);
  overflow: hidden;
  display: -webkit-box;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.side-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  max-width: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);

  .meta-dot {
    color: var(--el-text-color-placeholder);
  }
}

.side-count {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

/* 播放全部 / 加入队列（主操作），下一行是专辑概念 / 购买专辑。
 * 四个按钮统一基础圆角 —— round 是 20px 胶囊，和下一行并排就不齐了 */
.side-actions,
.side-links {
  display: flex;
  gap: 10px;
  width: 100%;

  :deep(.el-button) {
    flex: 1;
    margin-left: 0;
    border-radius: var(--el-border-radius-base);
  }
}

/* ===== 右栏：曲目列表 ===== */
.tracks {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tracks-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 右侧给关闭钮留位 */
  padding: 17px 50px 12px 22px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.tracks-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tracks-sub {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.tracks-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.track-list {
  flex: 1;
  padding: 8px 12px 16px;
}

.track-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
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

  /* 无音源 / 加载失效：置灰不可点 */
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

/* 关闭钮浮在浅色曲目栏上，改用深色图标（几何与悬停态见全局 .detail-close） */
.detail-close {
  --detail-close-bg: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
  --detail-close-ink: var(--el-text-color-secondary);
}

/* 系统「减少动态效果」下关掉装饰性动画：入场、黑胶自旋、封面淡入 */
@media (prefers-reduced-motion: reduce) {
  .side-inner > *,
  .tracks-head,
  .track-row,
  .vinyl-label,
  .cover-src {
    animation: none;
  }
}
</style>
