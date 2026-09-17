<script setup lang="ts">
import { Top } from '@element-plus/icons-vue'
import { useEventListener } from '@vueuse/core'
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

/** 滚动超过该距离才显示按钮 */
const SHOW_THRESHOLD = 240
/** 可滚动余量小于该值（内容不足一屏）时不显示 */
const MIN_SCROLLABLE = 40

const route = useRoute()
const visible = ref(false)

/** 当前页面的主滚动容器（页面 el-scrollbar 的 wrap 或兜底的 .app-content） */
let activeContainer: HTMLElement | null = null
let appContent: HTMLElement | null = null

/** 元素当前是否真实渲染（keep-alive 分离 / v-show 隐藏的分支要排除） */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0
}

/** 根据容器的可滚动性与滚动位置更新按钮显示态 */
function syncVisible(el: HTMLElement) {
  const scrollable = el.scrollHeight - el.clientHeight > MIN_SCROLLABLE
  visible.value = scrollable && el.scrollTop > SHOW_THRESHOLD
}

/** 是否为主滚动容器：各页主 el-scrollbar 统一标记 scrollbar-wrapper（el-scrollbar 或 wrap-class） */
function isMainScroller(el: HTMLElement): boolean {
  return el === appContent
    || (el.matches('.el-scrollbar__wrap') && !!el.closest('.scrollbar-wrapper'))
}

/** 在主内容区里定位当前页面的主滚动容器（取第一个可见的） */
function resolveContainer(): HTMLElement | null {
  if (!appContent?.isConnected)
    return null
  for (const wrap of appContent.querySelectorAll<HTMLElement>('.el-scrollbar__wrap')) {
    if (isVisible(wrap) && wrap.closest('.scrollbar-wrapper'))
      return wrap
  }
  return appContent
}

function syncFromContainer() {
  activeContainer = resolveContainer()
  if (activeContainer)
    syncVisible(activeContainer)
  else visible.value = false
}

/** scroll 事件不冒泡，但捕获阶段监听 document 能收到所有元素滚动；
 * 免去切页后重新定位容器，keep-alive / v-show / Suspense 场景天然兼容 */
function onDocScroll(e: Event) {
  const el = e.target
  if (!(el instanceof HTMLElement) || !appContent || !appContent.contains(el))
    return
  if (!isMainScroller(el))
    return
  activeContainer = el
  syncVisible(el)
}

function backToTop() {
  const el = activeContainer ?? resolveContainer()
  el?.scrollTo({ top: 0, behavior: 'smooth' })
}

useEventListener(document, 'scroll', onDocScroll, { capture: true })

onMounted(() => {
  appContent = document.querySelector('.app-content')
  nextTick(syncFromContainer)
})

// 切页时 keep-alive 保留滚动位置但不触发 scroll 事件，等 DOM 重新挂载后重新定位同步
watch(() => route.path, () => nextTick(syncFromContainer))
</script>

<template>
  <Transition name="back-top">
    <!-- 按钮本体沿用右上角刷新按钮（el-button circle primary，见 FloatingRefreshDock），此处只管定位 -->
    <el-button
      v-if="visible"
      circle
      type="primary"
      :icon="Top"
      title="回到顶部"
      class="back-top"
      @click="backToTop"
    />
  </Transition>
</template>

<style scoped lang="scss">
/* 右下角空闲（FloatAudioBar 左下、AppDock 居中），直接 fixed 定位 */
.back-top {
  position: fixed;
  right: 18px;
  bottom: 26px;
  z-index: 95;
}

/* 显隐过渡：淡入 + 轻微上浮 */
.back-top-enter-active,
.back-top-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.back-top-enter-from,
.back-top-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
