<script setup lang="ts">
// 应用级图片预览块：el-image 全屏预览 + 自绘工具条（EP 默认那排没有下载，见 ImageViewerToolbar）。
// 房间消息流与精华弹层共用，吸收了两处重复的样板：预览属性、referrerpolicy、
// 按原始尺寸的宽高占位、工具条插槽。差异收敛为两个 prop：maxWidth（宽度上限）与 lazy（长列表懒加载）。
// 尺寸/底色/窄窗上限等外观由使用处的 class 提供（如 .msg-image / .essence-image），本组件只持占位宽高。
// imageWidth/imageHeight 来自房间消息归一层；其它模块的图片源没有该字段，缺省时按 4:3 兜底框占位。
import type { CSSProperties } from 'vue'
import ImageViewerToolbar from '@renderer/components/ui/ImageViewerToolbar.vue'
import { trackEvent } from '@renderer/utils/umami'
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 图片地址 */
  src: string
  /** 归一层解析到的原始尺寸；有值时按原图宽高占位，加载前后布局零变化（滚动不抖动） */
  imageWidth?: number
  imageHeight?: number
  /** 宽度上限：消息流 240（气泡内），精华弹层 300（弹层更宽，放大一档） */
  maxWidth?: number
  /** 高度上限：超过时按高度反算宽度（竖图收窄不裁切）；消息流 280、精华 260、日期 220 */
  maxHeight?: number
  /** 懒加载：消息流历史长列表开，精华弹层量小不懒 */
  lazy?: boolean
  /**
   * 预览范围：传入后 viewer 可在本列表内左右切换（工具条的下载也随 activeIndex 跟随当前张），
   * 与 RoomAlbum 的相册同一形态。缺省只看本图（preview-src-list = [src]，无切换箭头）。
   */
  previewList?: string[]
  /** 打开 viewer 时定位到的下标（src 在 previewList 中的位置）；缺省 0 */
  initialIndex?: number
  /** 来源，仅用于埋点区分入口；缺省按消息流计 */
  from?: 'room' | 'essence' | 'date' | 'album'
}>(), {
  maxWidth: 240,
  maxHeight: 280,
  lazy: false,
  from: 'room',
})

const emit = defineEmits<{ load: [], error: [] }>()

/** 预览列表与工具条下载共用同一列表，保证左右切换时下载的始终是正在看的那张 */
const viewerUrls = computed(() => props.previewList ?? [props.src])

/**
 * 占位样式：加载前就把最终宽高定下来，加载前后高度不变。
 * 宽度必须是**确定长度**，不能写 `min(上限, 100%)`——气泡是 inline-block（宽度 fit-content），
 * 百分比宽度与父级循环依赖，首帧按 0 解析，图片拿到内在宽度后才撑开，这正是布局跳动的成因。
 * 窄窗兜底交给使用处的 class（`max-width: min(上限, 100%)`）。
 * 高度超上限时改由高度反算宽度（与 videoBoxStyle 同思路）：竖图收成窄高条，
 * 而不是被 max-height 压扁后由 cover 裁掉大半。
 */
const boxStyle = computed<CSSProperties>(() => {
  const naturalWidth = props.imageWidth ?? 0
  const naturalHeight = props.imageHeight ?? 0
  if (!(naturalWidth > 0 && naturalHeight > 0)) {
    // 缺尺寸（部分翻牌 / 老表情图）：固定 4:3 兜底框，加载后保持框体 cover 裁切——宁可裁图不错位
    return { width: `${props.maxWidth}px`, aspectRatio: '4 / 3' }
  }
  // 小图不放大：取「上限」与「原图宽」的较小值，两者都是确定值
  const width = Math.min(props.maxWidth, naturalWidth)
  if (width * naturalHeight / naturalWidth <= props.maxHeight)
    return { width: `${width}px`, aspectRatio: `${naturalWidth} / ${naturalHeight}` }
  return { width: `${Math.round(props.maxHeight * naturalWidth / naturalHeight)}px`, height: `${props.maxHeight}px` }
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
    @click="trackEvent('image:view', { from })"
  >
    <!-- 预览工具条：整排自绘后追加下载一项 -->
    <template #toolbar="{ actions, reset, activeIndex }">
      <ImageViewerToolbar
        :actions="actions"
        :reset="reset"
        :urls="viewerUrls"
        :active-index="activeIndex"
        :from="from"
      />
    </template>
  </el-image>
</template>
