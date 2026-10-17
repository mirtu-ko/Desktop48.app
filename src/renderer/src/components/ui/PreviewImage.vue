<script setup lang="ts">
// 应用级图片预览块：el-image 全屏预览 + 自绘工具条（EP 默认那排没有下载，见 ImageViewerToolbar）。
// 房间消息流与精华弹层共用，吸收了两处重复的样板：预览属性、referrerpolicy、
// 按原始尺寸的 aspect-ratio 占位、工具条插槽。差异收敛为两个 prop：maxWidth（宽度上限）与 lazy（长列表懒加载）。
// 尺寸/底色等外观由使用处的 class 提供（如 .msg-image / .essence-image），本组件不持样式。
// imageWidth/imageHeight 来自房间消息归一层；其它模块的图片源没有该字段，缺省时回退自然加载。
import ImageViewerToolbar from '@renderer/components/ui/ImageViewerToolbar.vue'
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 图片地址 */
  src: string
  /** 归一层解析到的原始尺寸；有值时按 aspect-ratio 预留空间，加载前后布局零变化（滚动不抖动） */
  imageWidth?: number
  imageHeight?: number
  /** 宽度上限：消息流 240（气泡内），精华弹层 300（弹层更宽，放大一档） */
  maxWidth?: number
  /** 懒加载：消息流历史长列表开，精华弹层量小不懒 */
  lazy?: boolean
  /**
   * 预览范围：传入后 viewer 可在本列表内左右切换（工具条的下载也随 activeIndex 跟随当前张），
   * 与 RoomAlbum 的相册同一形态。缺省只看本图（preview-src-list = [src]，无切换箭头）。
   */
  previewList?: string[]
  /** 打开 viewer 时定位到的下标（src 在 previewList 中的位置）；缺省 0 */
  initialIndex?: number
}>(), {
  maxWidth: 240,
  lazy: false,
})

const emit = defineEmits<{ load: [], error: [] }>()

/** 预览列表与工具条下载共用同一列表，保证左右切换时下载的始终是正在看的那张 */
const viewerUrls = computed(() => props.previewList ?? [props.src])

/** 占位样式：未知尺寸返回 undefined，回退自然加载（仅轻微抖动） */
const boxStyle = computed(() => {
  if (!props.imageWidth || !props.imageHeight)
    return undefined
  return {
    width: `min(${props.maxWidth}px, 100%)`,
    aspectRatio: `${props.imageWidth} / ${props.imageHeight}`,
  }
})
</script>

<template>
  <el-image
    :style="boxStyle"
    :src="src"
    :preview-src-list="viewerUrls"
    :initial-index="initialIndex ?? 0"
    preview-teleported
    :lazy="lazy"
    fit="cover"
    hide-on-click-modal
    referrerpolicy="no-referrer"
    @load="emit('load')"
    @error="emit('error')"
  >
    <!-- 预览工具条：整排自绘后追加下载一项 -->
    <template #toolbar="{ actions, reset, activeIndex }">
      <ImageViewerToolbar
        :actions="actions"
        :reset="reset"
        :urls="viewerUrls"
        :active-index="activeIndex"
      />
    </template>
  </el-image>
</template>
