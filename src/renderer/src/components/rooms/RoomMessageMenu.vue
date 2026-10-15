<script setup lang="ts">
// 消息右键菜单：在光标处弹出，越界时回弹到视口内；点空白 / 滚动 / Esc / 缩放窗口即关闭。
// 只负责定位与关闭，动作由父组件按 item.key 分发。

import type { Component } from 'vue'
import { useEventListener } from '@vueuse/core'
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** 视口坐标（右键时的光标位置） */
  x: number
  y: number
  items: Array<{ key: string, label: string, icon: Component }>
}>()

const emit = defineEmits<{
  pick: [key: string]
  close: []
}>()

/** 距视口边缘的最小留白：贴边弹出时不至于顶到窗口边上 */
const EDGE_GAP = 8

const menuRef = ref<HTMLElement | null>(null)
/** 定位结果（相对视口）；首帧先隐藏，量到真实尺寸再显示，避免越界时闪一下 */
const placement = ref<{ left: number, top: number } | null>(null)

/** 按菜单实际尺寸收进视口：右下越界时向左 / 上回弹，左上留出 EDGE_GAP */
function place() {
  const el = menuRef.value
  if (!el)
    return
  const maxLeft = window.innerWidth - el.offsetWidth - EDGE_GAP
  const maxTop = window.innerHeight - el.offsetHeight - EDGE_GAP
  placement.value = {
    left: Math.max(EDGE_GAP, Math.min(props.x, maxLeft)),
    top: Math.max(EDGE_GAP, Math.min(props.y, maxTop)),
  }
}

onMounted(async () => {
  await nextTick()
  place()
})

// 开着菜单再右键另一条消息时组件是复用的（v-if 一直为真）：位置与尺寸都得跟着重算，
// 否则菜单会停在上一处的坐标上
watch(() => [props.x, props.y], async () => {
  await nextTick()
  place()
})

// mousedown 而非 click：按下即关，与原生菜单手感一致（在菜单内按下则不关）
useEventListener(window, 'mousedown', (event: MouseEvent) => {
  if (!menuRef.value?.contains(event.target as Node))
    emit('close')
}, { capture: true })

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape')
    emit('close')
})

// 捕获阶段监听：滚动不冒泡，消息列表滚动时菜单必须跟着关掉（否则会飘在错位的行上）
useEventListener(window, 'scroll', () => emit('close'), { capture: true })

useEventListener(window, 'resize', () => emit('close'))
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="msg-menu"
      role="menu"
      :style="placement
        ? { left: `${placement.left}px`, top: `${placement.top}px` }
        : { left: `${x}px`, top: `${y}px`, visibility: 'hidden' }"
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="msg-menu-item"
        @click="emit('pick', item.key)"
      >
        <el-icon :size="13">
          <component :is="item.icon" />
        </el-icon>
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
/* 挂在 body 下（Teleport），所以层级要自己拿：高过页面内所有内容，仍低于 EP 的弹层 */
.msg-menu {
  position: fixed;
  z-index: 3000;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-sm);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-md);
}

.msg-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  color: var(--el-text-color-regular);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;

  .el-icon {
    flex: none;
    color: var(--el-text-color-secondary);
  }

  &:hover {
    color: var(--brand-primary);
    background: var(--el-fill-color-light);

    .el-icon {
      color: var(--brand-primary);
    }
  }
}
</style>
