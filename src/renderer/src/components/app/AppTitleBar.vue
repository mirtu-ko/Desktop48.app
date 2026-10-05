<script setup lang="ts">
import appIcon from '@renderer/assets/icon.png'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { useEventListener } from '@vueuse/core'
import { onMounted, onUnmounted, ref } from 'vue'
import { FLOAT_BAR_HEIGHT } from '../../../../common/float-window'

const isMaximized = ref(false)
let disposeChange: (() => void) | undefined

onMounted(async () => {
  // ★ 跨进程：本文件所有 window* 调用对端均为 main/app.ts。
  // windowOnMaximizeChange 是订阅式通道（主进程主动回推），返回值是退订函数，
  // 必须在 onUnmounted 调用，否则组件重挂载会累积监听器
  isMaximized.value = await window.mainAPI.windowIsMaximized()
  disposeChange = window.mainAPI.windowOnMaximizeChange((value) => {
    isMaximized.value = value
  })
})

onUnmounted(() => {
  disposeChange?.()
})

// HTML5 全屏时标题栏被 top layer 盖住，但 drag 区仍在原生层吞点击，
// 会让落在标题栏带的浮层按钮点不中；全屏期间本就不可拖，故整条停用。
const htmlFullscreen = ref(false)

function onFullscreenChange() {
  htmlFullscreen.value = !!document.fullscreenElement
}

useEventListener(document, 'fullscreenchange', onFullscreenChange)
onFullscreenChange()

function minimize() {
  window.mainAPI.windowMinimize()
}
function toggleMaximize() {
  window.mainAPI.windowToggleMaximize()
}
function onDoubleClick() {
  toggleMaximize()
}
function close() {
  window.mainAPI.windowClose()
}
</script>

<template>
  <!-- 底色 / 边框 / 拖拽 / 按钮外观全部来自 app.scss 的 .app-title-bar 配方（与独立播放窗同源） -->
  <div
    class="app-title-bar"
    :class="{ 'is-html-fullscreen': htmlFullscreen }"
    :style="{ height: `${FLOAT_BAR_HEIGHT}px` }"
    @dblclick="onDoubleClick"
  >
    <div class="title-bar-brand">
      <img class="tb-logo" :src="appIcon" alt="logo" draggable="false">
      <span class="tb-name">Desktop48</span>
    </div>

    <div class="app-title-bar-actions">
      <!-- 图标与独立播放窗共用 MediaIcon（24 视口线性壳），不再各画一套 SVG -->
      <!-- 最小化 -->
      <button class="app-title-bar-btn" title="最小化" @click="minimize()">
        <MediaIcon name="minus" :size="15" />
      </button>
      <!-- 最大化 / 还原 -->
      <button class="app-title-bar-btn" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize()">
        <MediaIcon :name="isMaximized ? 'windowRestore' : 'windowMaximize'" :size="15" />
      </button>
      <!-- 关闭 -->
      <button class="app-title-bar-btn app-title-bar-btn--close" title="关闭" @click="close()">
        <MediaIcon name="close" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 皮肤（底色 / 边框 / 拖拽 / 按钮）全在 app.scss 的 .app-title-bar 配方；
   高度由 FLOAT_BAR_HEIGHT 经 :style 注入，与独立播放窗同源。
   此处只留主窗独有部分：分区布局、品牌区、全屏态。 */

/* 主窗是「品牌靠左 + 按钮靠右」，与视频窗的内容流排布不同，故布局不放进共享配方 */
.app-title-bar {
  justify-content: space-between;
}

/* 全屏时停用拖拽：原因为何见 script 里的 htmlFullscreen 声明 */
.app-title-bar.is-html-fullscreen {
  -webkit-app-region: no-drag;
}

.title-bar-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  overflow: hidden;
  padding-left: 14px;

  .tb-logo {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    object-fit: contain;
  }

  .tb-name {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: var(--brand-primary-dark);
    white-space: nowrap;
  }
}
</style>
