<script setup lang="ts">
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { Download, Filter, Loading } from '@element-plus/icons-vue'
import ImageViewerToolbar from '@renderer/components/ui/ImageViewerToolbar.vue'
import { debugLog } from '@renderer/utils/debug'
import { isSmallImage, SMALL_IMAGE_MIN_SIDE } from '@renderer/utils/image-download'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue'

const props = defineProps<{
  messages: PocketRoomMessageView[]
}>()

/** 消息流里的图片消息（保持时间序）；相册只反映当前已加载的消息范围 */
const photos = computed(() =>
  props.messages
    .filter(message => message.imageUrl)
    .map(message => ({
      id: message.id,
      url: message.imageUrl,
      width: message.imageWidth,
      height: message.imageHeight,
      msgTime: message.msgTime,
      nickname: message.nick,
    })),
)

/**
 * 「小图」过滤开关：一键隐藏短边小于 SMALL_IMAGE_MIN_SIDE 的表情 / 贴纸类小图。
 * 只作用于相册展示与预览范围；批量下载仍走弹窗里自带的过滤项，互不影响。
 * 尺寸无从判定的图片保留展示（与下载链路「未知不误滤」同口径）。开关是浏览偏好，跨房间保持。
 */
const hideSmall = ref(false)

/**
 * 实测尺寸缓存（url → 原始宽高）：表情（EXPRESSIMAGE）与部分图片消息不带宽高，
 * 归一层落成 0×0；光凭消息尺寸会永远判不出小图（点击过滤看似无效），
 * 故缩略图加载完成后用自然尺寸（naturalWidth，不受 CSS 缩放影响）兜底。
 */
const measuredSizes = reactive<Record<string, { width: number, height: number }>>({})

function recordMeasuredSize(url: string, width: number, height: number): void {
  if (url && width > 0 && height > 0 && !(url in measuredSizes))
    measuredSizes[url] = { width, height }
}

/** 缩略图加载完成：记下自然尺寸供过滤判定兜底 */
function onPhotoLoad(event: Event, photo: { url: string }): void {
  const img = event.target as HTMLImageElement | null
  if (img)
    recordMeasuredSize(photo.url, img.naturalWidth, img.naturalHeight)
}

/** 判定用尺寸：消息自带宽高优先，缺失用实测；两者皆缺（尚未加载）按未知处理，不误滤 */
function photoSize(photo: { url: string, width: number, height: number }): { width: number, height: number } {
  if (photo.width > 0 && photo.height > 0)
    return photo
  return measuredSizes[photo.url] ?? photo
}

function isSmallPhoto(photo: { url: string, width: number, height: number }): boolean {
  const size = photoSize(photo)
  return isSmallImage(size.width, size.height)
}

/** 当前展示的图片（时间序）：过滤开启时剔除小图。
 * 成员没变时复用旧引用：实测尺寸是逐张到达的，若每来一张就产出新数组，
 * urls / 预览下标表 / 整个网格会跟着空转重渲染；Vue 3.4+ 的 computed 只在值变时
 * 通知下游，稳定引用即可把重渲染压到「真有小图被滤掉」的时刻。
 */
let visibleCache: typeof photos.value | null = null
const visiblePhotos = computed(() => {
  if (!hideSmall.value) {
    visibleCache = null
    return photos.value
  }
  const next = photos.value.filter(photo => !isSmallPhoto(photo))
  if (visibleCache && visibleCache.length === next.length
    && visibleCache.every((photo, index) => photo === next[index])) {
    return visibleCache
  }
  visibleCache = next
  return next
})

/** 被隐藏的小图张数：计数徽标与提示文案用（未开启过滤时为 0） */
const hiddenCount = computed(() => photos.value.length - visiblePhotos.value.length)

/** 计数徽标：过滤中显示「可见/总数」，否则只显示总数 */
const albumCountText = computed(() =>
  hiddenCount.value
    ? `${visiblePhotos.value.length}/${photos.value.length}`
    : String(photos.value.length),
)

/** 过滤按钮提示：说清阈值与当前隐藏量，开 / 关两种状态文案不同 */
const filterToggleTitle = computed(() =>
  hideSmall.value
    ? `显示全部图片（已隐藏 ${hiddenCount.value} 张小图）`
    : `过滤小图（短边小于 ${SMALL_IMAGE_MIN_SIDE}px）`,
)

const urls = computed(() => visiblePhotos.value.map(photo => photo.url))

/**
 * 图片 id → 预览列表下标（对齐 Rooms.vue 的 messageImageIndex 模式）。
 * 不能按 URL 反查：同一张图被转发两次时 indexOf 恒指第一张；
 * 收成 computed Map 而非模板里逐项 findIndex——那是每次渲染 O(N²)。
 */
const photoPreviewIndex = computed(() => {
  const map = new Map<string, number>()
  visiblePhotos.value.forEach((photo, index) => map.set(photo.id, index))
  return map
})

/** 非 null = 批量下载中，同时保存进度供按钮展示 */
const downloadProgress = ref<{ done: number, total: number } | null>(null)
let stopProgress: (() => void) | undefined

onMounted(() => {
  stopProgress = window.mainAPI.roomAlbumDownloadProgress((progress) => {
    downloadProgress.value = { done: progress.processed, total: progress.total }
  })
})

onUnmounted(() => stopProgress?.())

async function downloadAll() {
  if (downloadProgress.value)
    return

  // 对话框打开期间消息可能继续加载；本次下载范围以点击时刻为准
  const snapshot = photos.value.slice()
  if (!snapshot.length)
    return

  let filterSmall = true
  const message = h('div', [
    h('p', { style: 'margin: 0 0 12px' }, `将下载当前已加载的 ${snapshot.length} 张图片。`),
    h('label', { style: 'display: flex; align-items: center; gap: 7px; cursor: pointer; color: var(--el-text-color-regular)' }, [
      h('input', {
        type: 'checkbox',
        checked: filterSmall,
        onChange: (event: Event) => {
          filterSmall = (event.target as HTMLInputElement).checked
        },
      }),
      h('span', `过滤小图片（短边小于 ${SMALL_IMAGE_MIN_SIDE}px）`),
    ]),
  ])

  try {
    await ElMessageBox.confirm(message, '下载相册图片', {
      type: 'info',
      customClass: 'app-confirm',
      modalClass: 'detail-card-overlay',
      confirmButtonText: '下载',
      cancelButtonText: '取消',
    })
  }
  catch {
    return
  }

  downloadProgress.value = { done: 0, total: snapshot.length }
  try {
    const result = await window.mainAPI.roomAlbumDownload(
      snapshot.map(photo => ({
        url: photo.url,
        width: photo.width,
        height: photo.height,
        msgTime: photo.msgTime,
        nickname: photo.nickname,
      })),
      filterSmall,
    )
    if (result.canceled)
      return

    const summary = [`已下载 ${result.downloaded} 张`]
    if (result.skipped)
      summary.push(`过滤小图 ${result.skipped} 张`)
    if (result.failed)
      summary.push(`失败 ${result.failed} 张`)

    if (result.failed)
      ElMessage.warning(summary.join('，'))
    else if (result.downloaded)
      ElMessage.success(summary.join('，'))
    else
      ElMessage.info(summary.join('，'))
  }
  catch (error) {
    debugLog('rooms-page', '相册批量下载失败', error)
    ElMessage.error('相册下载失败，请稍后重试')
  }
  finally {
    downloadProgress.value = null
  }
}
</script>

<template>
  <section class="album-card">
    <header class="album-head">
      相册
      <span v-if="photos.length" class="album-count">{{ albumCountText }}</span>
      <div class="album-actions">
        <!-- 小图过滤开关：一键隐藏 / 恢复表情贴纸类小图，只影响展示与预览范围 -->
        <button
          type="button"
          class="album-action"
          :class="{ 'is-active': hideSmall }"
          :disabled="!photos.length"
          :title="filterToggleTitle"
          @click="hideSmall = !hideSmall"
        >
          <el-icon><Filter /></el-icon>
          <span>小图</span>
        </button>
        <button
          type="button"
          class="album-action"
          :disabled="!photos.length || !!downloadProgress"
          :title="downloadProgress ? '正在下载相册图片' : '下载已加载的全部图片'"
          @click="downloadAll"
        >
          <el-icon :class="{ 'is-loading': downloadProgress }">
            <Loading v-if="downloadProgress" />
            <Download v-else />
          </el-icon>
          <span v-if="downloadProgress">{{ downloadProgress.done }}/{{ downloadProgress.total }}</span>
          <span v-else>下载</span>
        </button>
      </div>
    </header>

    <div v-if="visiblePhotos.length" class="album-grid">
      <el-image
        v-for="photo in visiblePhotos"
        :key="photo.id"
        class="album-item"
        :src="photo.url"
        :preview-src-list="urls"
        :initial-index="photoPreviewIndex.get(photo.id) ?? 0"
        preview-teleported
        lazy
        fit="cover"
        hide-on-click-modal
        @load="onPhotoLoad($event, photo)"
      >
        <!-- 预览时可按需下载当前这张（工具条由 rooms 共用组件提供） -->
        <template #toolbar="{ actions, reset, activeIndex }">
          <ImageViewerToolbar
            :actions="actions"
            :reset="reset"
            :urls="urls"
            :active-index="activeIndex"
          />
        </template>
      </el-image>
    </div>
    <!-- 过滤后一张不剩：明说藏了多少、怎么恢复，不与「本来就没图」混为一谈 -->
    <p v-else-if="photos.length" class="album-empty">
      {{ hiddenCount }} 张小图已隐藏，点击「小图」恢复显示
    </p>
    <p v-else class="album-empty">
      已加载的消息里还没有图片
    </p>
  </section>
</template>

<style scoped lang="scss">
.album-card {
  padding: 14px;
  border-radius: var(--radius-card);
  background: var(--el-fill-color-blank);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
}

.album-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.album-count {
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
}

/* 头部动作区：过滤开关 + 下载，统一推到右侧 */
.album-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.album-action {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--el-color-primary);
    background: var(--el-fill-color-light);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* 过滤开关开启态：主色 + 淡底，与 hover 的中性底区分开 */
  &.is-active {
    color: var(--el-color-primary);
    background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--el-color-primary) 18%, transparent);
    }
  }
}

.album-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 10px;

  :deep(.el-image) {
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 6px;
    background: var(--el-fill-color);
  }
}

.album-empty {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
