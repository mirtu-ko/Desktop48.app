<script setup lang="ts">
import { Top } from '@element-plus/icons-vue'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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
  if (!appContent?.isConnected) return null
  for (const wrap of appContent.querySelectorAll<HTMLElement>('.el-scrollbar__wrap')) {
    if (isVisible(wrap) && wrap.closest('.scrollbar-wrapper')) return wrap
  }
  return appContent
}

function syncFromContainer() {
  activeContainer = resolveContainer()
  if (activeContainer) syncVisible(activeContainer)
  else visible.value = false
}

/** scroll 事件不冒泡，但捕获阶段监听 document 能收到所有元素滚动；
 * 免去切页后重新定位容器，keep-alive / v-show / Suspense 场景天然兼容 */
function onDocScroll(e: Event) {
  const el = e.target
  if (!(el instanceof HTMLElement) || !appContent || !appContent.contains(el)) return
  if (!isMainScroller(el)) return
  activeContainer = el
  syncVisible(el)
}

function backToTop() {
  const el = activeContainer ?? resolveContainer()
  el?.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  appContent = document.querySelector('.app-content')
  document.addEventListener('scroll', onDocScroll, true)
  nextTick(syncFromContainer)
})

onUnmounted(() => {
  document.removeEventListener('scroll', onDocScroll, true)
})

// 切页时 keep-alive 保留滚动位置但不触发 scroll 事件，等 DOM 重新挂载后重新定位同步
watch(() => route.path, () => nextTick(syncFromContainer))
</script>

<template>
  <Transition name="back-top">
    <button
      v-if="visible"
      type="button"
      class="back-top"
      title="回到顶部"
      @click="backToTop"
    >
      <el-icon><Top /></el-icon>
    </button>
  </Transition>
</template>

<style scoped lang="scss">
/* 右下角全局回顶按钮：右下角空闲（FloatAudioBar 左下、AppDock 居中），直接 fixed 定位 */
.back-top {
  position: fixed;
  right: 18px;
  bottom: 26px;
  z-index: 95;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: var(--el-text-color-regular);
  /* 深玻璃质感，与 AppDock / FloatAudioBar 同层观感 */
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.08) 55%),
    color-mix(in srgb, var(--el-bg-color) 58%, transparent);
  backdrop-filter: blur(28px) saturate(170%);
  box-shadow:
    var(--shadow-md),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  transition:
    transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;

  .el-icon {
    font-size: 20px;
  }

  &:hover {
    transform: translateY(-3px);
    background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light));
    color: #fff;
    box-shadow:
      var(--shadow-lg),
      0 10px 24px -8px rgba(109, 90, 224, 0.5);
  }

  &:active {
    transform: translateY(-1px);
  }
}

/* 显隐过渡：淡入 + 轻微上浮 */
.back-top-enter-active,
.back-top-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.back-top-enter-from,
.back-top-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.85);
}
</style>
