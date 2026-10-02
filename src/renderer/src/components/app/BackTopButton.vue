<script setup lang="ts">
import { Top } from '@element-plus/icons-vue'
import { isPageScroller, resolvePageScroller, scrollPageToTop } from '@renderer/utils/page-scroll'
import { useEventListener } from '@vueuse/core'
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

/** 滚动超过该距离才显示按钮 */
const SHOW_THRESHOLD = 240
/** 可滚动余量小于该值（内容不足一屏）时不显示 */
const MIN_SCROLLABLE = 40

const route = useRoute()
const visible = ref(false)

/** 根据容器的可滚动性与滚动位置更新按钮显示态 */
function syncVisible(el: HTMLElement) {
  const scrollable = el.scrollHeight - el.clientHeight > MIN_SCROLLABLE
  visible.value = scrollable && el.scrollTop > SHOW_THRESHOLD
}

function syncFromContainer() {
  const el = resolvePageScroller()
  if (el)
    syncVisible(el)
  else visible.value = false
}

/** scroll 事件不冒泡，但捕获阶段监听 document 能收到所有元素滚动；
 * 免去切页后重新定位容器，keep-alive / v-show / Suspense 场景天然兼容 */
function onDocScroll(e: Event) {
  const el = e.target
  if (!(el instanceof HTMLElement) || !isPageScroller(el))
    return
  syncVisible(el)
}

useEventListener(document, 'scroll', onDocScroll, { capture: true })

onMounted(() => nextTick(syncFromContainer))

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
      @click="scrollPageToTop"
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
