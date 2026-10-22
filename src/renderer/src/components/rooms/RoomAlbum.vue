<script setup lang="ts">
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { Download, Loading } from '@element-plus/icons-vue'
import ImageViewerToolbar from '@renderer/components/ui/ImageViewerToolbar.vue'
import { debugLog } from '@renderer/utils/debug'
import { SMALL_IMAGE_MIN_SIDE } from '@renderer/utils/image-download'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, h, onMounted, onUnmounted, ref } from 'vue'

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

const urls = computed(() => photos.value.map(photo => photo.url))

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
      <span v-if="photos.length" class="album-count">{{ photos.length }}</span>
      <button
        type="button"
        class="album-download"
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
    </header>

    <div v-if="photos.length" class="album-grid">
      <el-image
        v-for="photo in photos"
        :key="photo.id"
        class="album-item"
        :src="photo.url"
        :preview-src-list="urls"
        :initial-index="urls.indexOf(photo.url)"
        preview-teleported
        lazy
        fit="cover"
        hide-on-click-modal
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

.album-download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
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
