<script setup lang="ts">
/**
 * 电台舞台：轮播封面铺满 + 隐藏 audio 媒体源，LivePlayer / PlaybackPlayer 共用。
 * audio 元素本体经 `audio` 事件回传（挂载时元素、卸载时 null），
 * 由父级挂 mpegts / hls 播放会话；播控交互统一走 MiniControls。
 */
withDefaults(defineProps<{
  /** 轮播图 URL 列表 */
  carousels: string[]
  /** 轮播切换间隔（毫秒） */
  interval?: number
  /** 是否让 audio 自动播放（直播电台用，回放由父级手动 play） */
  autoplay?: boolean
}>(), {
  interval: 5000,
  autoplay: false,
})

const emit = defineEmits<{
  audio: [el: HTMLAudioElement | null]
  play: []
  pause: []
  volumechange: [event: Event]
}>()

// 模板函数 ref：挂载回传元素、卸载回传 null，父级无需持有组件实例
function setAudioRef(el: unknown) {
  emit('audio', el instanceof HTMLAudioElement ? el : null)
}
</script>

<template>
  <div class="radio-stage">
    <div class="radio-carousel">
      <el-carousel
        v-if="carousels.length > 0"
        :interval="interval"
        indicator-position="none"
        arrow="never"
        height="100%"
      >
        <el-carousel-item v-for="carousel in carousels" :key="carousel">
          <img :src="carousel" class="radio-cover" alt="cover" draggable="false">
        </el-carousel-item>
      </el-carousel>
    </div>
    <!-- 音频仅作媒体源，不渲染原生控件（播控走 MiniControls） -->
    <audio
      :ref="setAudioRef"
      class="audio-player"
      :autoplay="autoplay"
      @play="emit('play')"
      @pause="emit('pause')"
      @volumechange="emit('volumechange', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
.radio-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* 轮播铺满整个窗口 */
.radio-carousel {
  position: absolute;
  inset: 0;
  display: flex;
}

:deep(.el-carousel) {
  width: 100%;
  height: 100%;
}

:deep(.el-carousel__container) {
  height: 100%;
}

/* 封面铺满：object-fit: cover 裁边填充 */
:deep(.el-carousel__item) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.radio-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.audio-player {
  display: none;
}
</style>
