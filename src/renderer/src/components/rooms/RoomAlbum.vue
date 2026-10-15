<script setup lang="ts">
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { computed } from 'vue'

const props = defineProps<{
  messages: PocketRoomMessageView[]
}>()

/** 消息流里的图片消息（保持时间序）；相册只反映当前已加载的消息范围 */
const photos = computed(() =>
  props.messages
    .filter(message => message.imageUrl)
    .map(message => ({ id: message.id, url: message.imageUrl })),
)

const urls = computed(() => photos.value.map(photo => photo.url))
</script>

<template>
  <section class="album-card">
    <header class="album-head">
      相册
      <span v-if="photos.length" class="album-count">{{ photos.length }}</span>
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
      />
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
