<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onActivated, onDeactivated, ref, watch } from 'vue'

export interface FloatingTabItem {
  label: string
  key: string
  color?: string
  /** 选项左侧图标（Element Plus 图标组件，可选） */
  icon?: any
}

const props = defineProps<{
  tabs: FloatingTabItem[]
  active: string
}>()

const emit = defineEmits<{ change: [key: string], refresh: [] }>()

/** 激活 tab 的主题渐变：有主题色用之，否则回退品牌渐变 */
const activeColor = computed(
  () => props.tabs.find(tab => tab.key === props.active)?.color || '',
)

function tabStyle(key: string) {
  if (key !== props.active)
    return undefined
  if (!activeColor.value) {
    return {
      background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light))',
    }
  }
  return {
    background: `linear-gradient(135deg, ${activeColor.value}, ${activeColor.value})`,
    boxShadow: `0 4px 12px -4px ${activeColor.value}cc`,
  }
}

const barRef = ref<HTMLElement>()

/** 是否横向溢出（未溢出时不介入任何滚动/拖拽行为） */
function overflowing(el?: HTMLElement): el is HTMLElement {
  return !!el && el.scrollWidth > el.clientWidth + 1
}

/** 鼠标滚轮：纵向增量转横向滚动，触控板横扫的 deltaX 同样计入 */
function onWheel(event: WheelEvent) {
  const el = barRef.value
  const delta = event.deltaY + event.deltaX
  if (!overflowing(el) || !delta)
    return
  event.preventDefault()
  el.scrollLeft += delta
}

// 按住拖拽滑动；dragged 用于抑制拖拽结束时的误点击
const dragging = ref(false)
let dragged = false
let startX = 0
let startScroll = 0

function onPointerDown(event: PointerEvent) {
  const el = barRef.value
  if (event.button !== 0 || !overflowing(el))
    return
  dragging.value = true
  dragged = false
  startX = event.clientX
  startScroll = el.scrollLeft
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const el = barRef.value
  if (!dragging.value || !el)
    return
  const delta = event.clientX - startX
  if (Math.abs(delta) > 4)
    dragged = true
  el.scrollLeft = startScroll - delta
}

function onPointerUp() {
  if (!dragging.value)
    return
  dragging.value = false
  // click 跟随 pointerup 同步派发，延迟一拍复位既能照常抑制拖拽尾随的点击，
  // 也兜住了 pointercancel、落点在空白处等「没有 click 跟进」的场景，避免误吞下一次点击
  setTimeout(() => {
    dragged = false
  })
}

function change(key: string) {
  if (dragged)
    return
  emit('change', key)
}

/** 激活项被裁切时自动滚入可视区（含外部改 active 的场景） */
watch(() => props.active, async () => {
  await nextTick()
  barRef.value?.querySelector('.is-active')?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest',
  })
}, { immediate: true })

/** 双击当前 tab：通知父组件刷新该 tab 对应的内容 */
function dblClick(tab: FloatingTabItem) {
  if (tab.key === props.active)
    emit('refresh')
}

// ===== 键盘左右方向键切换 tab =====
// 页面被 keep-alive 缓存，失活实例不应再响应按键
const keyboardEnabled = ref(true)

/** 焦点在输入控件、浮窗播放器内，或有弹层（对话框/抽屉）打开时，让位于原生/弹层交互 */
function shouldIgnoreKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
    return true
  const target = event.target as HTMLElement | null
  if (target?.isContentEditable)
    return true
  if (target && /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    return true
  // 迷你窗播放器自身用左右键调进度，焦点在窗内时不抢按键
  if (target?.closest('.fp-window'))
    return true
  return !!document.querySelector('.el-overlay:not([style*="display: none"])')
}

function onKeydown(event: KeyboardEvent) {
  if (!keyboardEnabled.value)
    return
  const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
  if (!step || shouldIgnoreKey(event))
    return
  const index = props.tabs.findIndex(tab => tab.key === props.active)
  const next = props.tabs[index + step]
  if (index < 0 || !next)
    return
  event.preventDefault()
  emit('change', next.key)
}

useEventListener(window, 'keydown', onKeydown)
onActivated(() => {
  keyboardEnabled.value = true
})
onDeactivated(() => {
  keyboardEnabled.value = false
})
</script>

<template>
  <div
    ref="barRef"
    class="float-tab-bar frosted-surface no-scrollbar"
    :class="{ 'is-dragging': dragging }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <button
      v-for="tab in tabs"
      :key="tab.key"
      class="float-tab"
      :class="{ 'is-active': active === tab.key }"
      :style="tabStyle(tab.key)"
      @click="change(tab.key)"
      @dblclick="dblClick(tab)"
    >
      <el-icon v-if="tab.icon" class="tab-icon">
        <component :is="tab.icon" />
      </el-icon>
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.float-tab-bar {
  position: absolute;
  top: 12px;
  left: 6px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  max-width: 75%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  touch-action: pan-x;
}

/* 拖拽中：整条变抓手光标，并屏蔽 hover 高亮，避免划过时一路闪烁 */
.float-tab-bar.is-dragging {
  cursor: grabbing;

  .float-tab {
    cursor: grabbing;

    &:hover {
      color: var(--el-text-color-secondary);
      background: transparent;
    }

    &.is-active:hover {
      color: #fff;
    }
  }
}

.float-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 9px 24px;
  border: none;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 500;
  line-height: 1;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;
  user-select: none;
  transition:
    background 0.2s ease,
    color 0.2s ease;

  &:hover {
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--el-border-color-lighter) 40%, transparent);
  }

  .tab-icon {
    font-size: inherit;
  }

  &.is-active {
    color: #fff;
    font-weight: 600;
    /* 激活态背景由内联主题渐变提供，见 tabStyle */
    box-shadow: var(--shadow-glow);
  }
}
</style>
