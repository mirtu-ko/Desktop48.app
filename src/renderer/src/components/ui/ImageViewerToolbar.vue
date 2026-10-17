<script setup lang="ts">
// 全屏预览工具条：在 Element Plus 默认那排（缩放 / 原始尺寸 / 旋转）末尾追加「下载」。
// 必须整排自己画：EP 的默认按钮是 `#toolbar` 插槽的 fallback，一旦提供插槽就全量替换。
// 尺寸、配色、分隔线由 .el-image-viewer__actions__inner 的宿主样式提供，这里不重复定义。
import { Download, RefreshLeft, RefreshRight, ScaleToOriginal, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { debugLog } from '@renderer/utils/debug'
import { downloadImage } from '@renderer/utils/image-download'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

const props = defineProps<{
  /** viewer 的动作入口（zoomIn/zoomOut/clockwise/anticlockwise），插槽原样透传 */
  actions: (action: string) => void
  /** 切换「适应窗口 / 原始尺寸」 */
  reset: () => void
  /** 与 viewer 的 urlList 同序，下载时按 activeIndex 取当前这张 */
  urls: string[]
  activeIndex: number
}>()

const downloading = ref(false)

async function onDownload() {
  const url = props.urls[props.activeIndex]
  if (!url || downloading.value)
    return
  downloading.value = true
  try {
    const name = await downloadImage(url)
    ElMessage.success(`已下载到下载目录：${name}`)
  }
  catch (error: unknown) {
    debugLog('rooms-page', '图片下载失败', url, error)
    ElMessage.error('图片下载失败，可能该图片所在域名未开放跨域读取')
  }
  finally {
    downloading.value = false
  }
}
</script>

<template>
  <el-icon @click="actions('zoomOut')">
    <ZoomOut />
  </el-icon>
  <el-icon @click="actions('zoomIn')">
    <ZoomIn />
  </el-icon>
  <i class="el-image-viewer__actions__divider" />
  <!-- 图标固定用 ScaleToOriginal：viewer 的真实模式来自其内部状态，插槽拿不到，画成两态会与实际不同步 -->
  <el-icon title="切换适应窗口 / 原始尺寸" @click="reset()">
    <ScaleToOriginal />
  </el-icon>
  <i class="el-image-viewer__actions__divider" />
  <el-icon @click="actions('anticlockwise')">
    <RefreshLeft />
  </el-icon>
  <el-icon @click="actions('clockwise')">
    <RefreshRight />
  </el-icon>
  <i class="el-image-viewer__actions__divider" />
  <el-icon title="下载图片" :class="{ 'is-downloading': downloading }" @click="onDownload">
    <Download />
  </el-icon>
</template>

<style scoped>
.is-downloading {
  opacity: 0.45;
  pointer-events: none;
}
</style>
