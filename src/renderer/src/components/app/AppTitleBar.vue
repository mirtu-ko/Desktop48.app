<script setup lang="ts">
import appIcon from '@renderer/assets/icon.png'
import { onMounted, onUnmounted, ref } from 'vue'

const isMaximized = ref(false)
let disposeChange: (() => void) | undefined

// HTML5 全屏（播放器容器 requestFullscreen）会把标题栏视觉盖住，但
// -webkit-app-region: drag 仍在原生层拦截点击，顶部浮层会点不中；
// 全屏期间标题栏本来就不可见也不可拖，直接停用拖拽区
const htmlFullscreen = ref(false)

function onFullscreenChange() {
  htmlFullscreen.value = !!document.fullscreenElement
}

onMounted(async () => {
  // ★ 跨进程：本文件所有 window* 调用对端均为 main/app.ts。
  // windowOnMaximizeChange 是订阅式通道（主进程主动回推），返回值是退订函数，
  // 必须在 onUnmounted 调用，否则组件重挂载会累积监听器
  isMaximized.value = await window.mainAPI.windowIsMaximized()
  disposeChange = window.mainAPI.windowOnMaximizeChange((value) => {
    isMaximized.value = value
  })
  onFullscreenChange()
  document.addEventListener('fullscreenchange', onFullscreenChange)
})

onUnmounted(() => {
  disposeChange?.()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})

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
  <div class="app-title-bar" :class="{ 'is-html-fullscreen': htmlFullscreen }" @dblclick="onDoubleClick">
    <div class="title-bar-brand">
      <img class="tb-logo" :src="appIcon" alt="logo" draggable="false">
      <span class="tb-name">Desktop48</span>
    </div>

    <div class="title-bar-buttons">
      <!-- 最小化 -->
      <button class="tb-btn" title="最小化" @click="minimize()">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <!-- 最大化 / 还原 -->
      <button class="tb-btn" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize()">
        <svg v-if="!isMaximized" viewBox="0 0 12 12" width="12" height="12">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.1" />
        </svg>
        <svg v-else viewBox="0 0 12 12" width="12" height="12">
          <rect x="2" y="3.2" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.1" />
          <path d="M4 3.2V2.8A1 1 0 0 1 5 1.8h4.2A1 1 0 0 1 10.2 2.8V7a1 1 0 0 1-1 1h-.4" fill="none" stroke="currentColor" stroke-width="1.1" />
        </svg>
      </button>
      <!-- 关闭 -->
      <button class="tb-btn tb-close" title="关闭" @click="close()">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 高度与 utils/float-player-layout.ts 的 FP_BAR_HEIGHT 保持一致：
   浮窗以 36px 为拖拽带上沿做 y 钳制 / 吸顶，改动需同步 */
.app-title-bar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  background:
    radial-gradient(320px 90px at 12% -70%, rgba(109, 90, 224, 0.14), transparent 70%),
    linear-gradient(90deg, #f1eefd, #eceefa);
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-shadow: 0 1px 2px rgba(var(--shadow-rgb), 0.04);
  color: var(--el-text-color-primary);
  /* 整条背景区域可拖拽移动窗口 */
  -webkit-app-region: drag;
  user-select: none;
}

/* 全屏（top layer）盖住了标题栏，拖拽区却照常在原生层吞点击：
   落进这条 36px 带的浮层按钮（如旋转胶囊最左侧）会点不中。
   全屏期间标题栏不可见也无拖拽需求，整条转为 no-drag */
.app-title-bar.is-html-fullscreen {
  -webkit-app-region: no-drag;
}

.title-bar-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  overflow: hidden;

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

.title-bar-buttons {
  /* 按钮区域不参与拖拽，保持可点击 */
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  height: 100%;

  .tb-btn {
    width: 44px;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--el-text-color-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;

    svg {
      display: block;
    }

    &:hover {
      background: rgba(109, 90, 224, 0.1);
      color: var(--brand-primary);
    }
  }

  .tb-close:hover {
    background: linear-gradient(135deg, #e5484d, #e03d52);
    color: #fff;
    box-shadow: 0 2px 8px -2px rgba(224, 61, 82, 0.5);
  }
}
</style>
