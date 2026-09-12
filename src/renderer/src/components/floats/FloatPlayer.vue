<script setup lang="ts">
import type { FloatPlayerItem } from '@renderer/stores/float-players'
import type { WindowSize } from '@renderer/utils/float-player-layout'
import LivePlayer from '@renderer/components/player/LivePlayer.vue'
import PlaybackPlayer from '@renderer/components/player/PlaybackPlayer.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import {
  BARRAGE_SIDEBAR_WIDTH,
  CASCADE_MAX,
  CASCADE_RIGHT_OFFSET,
  CASCADE_STEP,
  CASCADE_TOP_OFFSET,
  DEFAULT_ASPECT,
  EXPAND_BOX_RATIO,
  fitAspectInBox,
  FP_BAR_HEIGHT,
  MINI_BOX_RATIO,
  PILL_SIZE,
  SNAP_EDGE,
  SNAP_TOP,
  VIEWPORT_PADDING_BOTTOM,
  VIEWPORT_PADDING_X,
} from '@renderer/utils/float-player-layout'
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  item: FloatPlayerItem
  /** 当前在窗口列表中的下标，用于 z-index 置顶排序 */
  index: number
}>()

const emit = defineEmits(['close', 'focus'])

// 视口尺寸：外接框随主窗口大小变化，必须在 resize 时保持更新
const viewport = ref({ w: window.innerWidth, h: window.innerHeight })

// 视频实际显示宽高比（由子播放器上报，含旋转后的交换），未就绪时按竖向兜底
const aspect = ref(DEFAULT_ASPECT)

const kind = computed(() => props.item.kind)

// 标题栏：有主播名时展示「主播名: 标题」，否则回退到 title
const barTitle = computed(() => {
  const { nickname, title } = props.item.payload
  if (nickname)
    return `${nickname}: ${title}`
  return title
})
const collapsed = ref(false)
const expanded = ref(false)
// 弹幕侧栏是否实际占位（由 PlaybackPlayer 上报：有弹幕且未收起）
const sidebarActive = ref(false)
function onSidebar(active: boolean) {
  sidebarActive.value = active
  clampPos()
}

// 系统画中画（PiP）联动：进入 PiP 时自动折叠成胶囊条，退出时若仍处于胶囊态则还原为迷你窗
function onPip(active: boolean) {
  if (active) {
    collapsed.value = true
    expanded.value = false
  }
  else if (collapsed.value) {
    collapsed.value = false
    expanded.value = false
  }
  clampPos()
}
// 头部头像：由子播放器加载完成（或 open 模式传入）后上报，显示在 fp-bar
const avatarUrl = ref('')
function onAvatar(url: string) {
  if (url)
    avatarUrl.value = url
}

function fitIntoViewport(base: WindowSize): WindowSize {
  const maxW = viewport.value.w - VIEWPORT_PADDING_X
  const maxH = viewport.value.h - FP_BAR_HEIGHT - VIEWPORT_PADDING_BOTTOM
  if (base.w <= maxW && base.h <= maxH)
    return base
  const scale = Math.min(maxW / base.w, maxH / base.h)
  return { w: Math.round(base.w * scale), h: Math.round(base.h * scale) }
}

// 当前窗口尺寸：折叠态返回胶囊条；否则取视口外接框，
// 内接出视频比例的最大矩形（回放放大且侧栏实际占位时预留弹幕侧栏宽），窗口高 = 视频区 + 标题条，
// 最后再按视口硬钳制一次，不会被裁掉
const size = computed<WindowSize>(() => {
  if (collapsed.value)
    return PILL_SIZE
  const ratio = expanded.value ? EXPAND_BOX_RATIO : MINI_BOX_RATIO
  const sidebar = expanded.value && kind.value === 'playback' && sidebarActive.value ? BARRAGE_SIDEBAR_WIDTH : 0
  const boxW = viewport.value.w * ratio.w
  const boxH = (viewport.value.h - FP_BAR_HEIGHT) * ratio.h
  const video = fitAspectInBox(
    aspect.value,
    Math.max(140, boxW - sidebar),
    Math.max(100, boxH - FP_BAR_HEIGHT),
  )
  return fitIntoViewport({ w: video.w + sidebar, h: video.h + FP_BAR_HEIGHT })
})

// 初始位置：从右上角开始按创建序号级联错位，避免多窗完全重叠
const order = props.item.order
const initialMiniWidth = fitAspectInBox(
  DEFAULT_ASPECT,
  window.innerWidth * MINI_BOX_RATIO.w,
  (window.innerHeight - FP_BAR_HEIGHT) * MINI_BOX_RATIO.h - FP_BAR_HEIGHT,
).w
const pos = ref({
  x: Math.max(12, window.innerWidth - initialMiniWidth - CASCADE_RIGHT_OFFSET - (order % CASCADE_MAX) * CASCADE_STEP),
  y: FP_BAR_HEIGHT + CASCADE_TOP_OFFSET + (order % CASCADE_MAX) * CASCADE_STEP,
})

const windowStyle = computed(() => ({
  left: `${pos.value.x}px`,
  top: `${pos.value.y}px`,
  width: `${size.value.w}px`,
  height: `${size.value.h}px`,
  zIndex: 1000 + props.index,
}))

function clampX(x: number) {
  return Math.min(Math.max(0, x), Math.max(0, viewport.value.w - size.value.w))
}

function clampY(y: number) {
  return Math.min(Math.max(FP_BAR_HEIGHT, y), Math.max(FP_BAR_HEIGHT, viewport.value.h - size.value.h))
}

// 尺寸变化（换比例/缩放/展开折叠）后把窗口重新约束在视口内
function clampPos() {
  pos.value = { x: clampX(pos.value.x), y: clampY(pos.value.y) }
}

// 子播放器上报视频宽高比后窗口自动定形（旋转切换也走这里）
function onAspect(value: number) {
  if (value > 0)
    aspect.value = value
  clampPos()
}

// 拖拽：Pointer Events + setPointerCapture，指针移出标题栏也不会丢事件；
// 坐标写入经 rAF 节流，每帧最多触发一次重渲染
interface DragState {
  pointerId: number
  startX: number
  startY: number
  baseX: number
  baseY: number
  dx: number
  dy: number
}
let drag: DragState | null = null
let dragFrame: number | null = null

function applyDrag() {
  if (!drag)
    return
  pos.value = { x: clampX(drag.baseX + drag.dx), y: clampY(drag.baseY + drag.dy) }
}

function scheduleDrag() {
  if (dragFrame !== null)
    cancelAnimationFrame(dragFrame)
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null
    applyDrag()
  })
}

function onBarPointerDown(e: PointerEvent) {
  if (e.button !== 0)
    return
  // 按下操作按钮不触发拖拽
  if ((e.target as HTMLElement).closest('.fp-actions'))
    return
  drag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    baseX: pos.value.x,
    baseY: pos.value.y,
    dx: 0,
    dy: 0,
  }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onBarPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId)
    return
  drag.dx = e.clientX - drag.startX
  drag.dy = e.clientY - drag.startY
  scheduleDrag()
}

function onBarPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId)
    return
  if (dragFrame !== null) {
    cancelAnimationFrame(dragFrame)
    dragFrame = null
  }
  applyDrag()
  drag = null
  snapToEdge()
}

// 松开后若贴近屏幕边缘则自动吸附
function snapToEdge() {
  const { x, y } = pos.value
  const w = size.value.w
  if (x < SNAP_EDGE)
    pos.value.x = 0
  else if (x + w > viewport.value.w - SNAP_EDGE)
    pos.value.x = viewport.value.w - w
  if (y < FP_BAR_HEIGHT + SNAP_TOP)
    pos.value.y = FP_BAR_HEIGHT
}

// 窗口尺寸变化（如主窗口缩放）时刷新视口，把浮窗拉回可视区域
function onWindowResize() {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  clampPos()
}

function onClose() {
  emit('close')
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
  if (collapsed.value)
    expanded.value = false
}

function toggleExpand() {
  expanded.value = !expanded.value
  if (expanded.value)
    collapsed.value = false
  clampPos()
}

// 标题栏双击：在 MINI → EXPAND → PILL 之间循环切换
function cycleSize() {
  if (expanded.value) {
    // EXPAND → PILL（折叠胶囊）
    expanded.value = false
    collapsed.value = true
  }
  else if (collapsed.value) {
    // PILL → MINI（还原迷你窗）
    collapsed.value = false
  }
  else {
    // MINI → EXPAND（放大）
    expanded.value = true
  }
  clampPos()
}

// 双击入口：落在操作按钮区的不处理，其余交给 cycleSize 三态循环
function onBarDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.fp-actions'))
    return
  cycleSize()
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  if (dragFrame !== null) {
    cancelAnimationFrame(dragFrame)
    dragFrame = null
  }
})
</script>

<template>
  <div
    class="fp-window frosted-surface frosted-surface--deep"
    :class="{ 'is-collapsed': collapsed }"
    :style="windowStyle"
    @pointerdown="emit('focus')"
  >
    <div
      class="fp-bar"
      title="拖动移动 · 双击切换形态"
      @pointerdown="onBarPointerDown"
      @pointermove="onBarPointerMove"
      @pointerup="onBarPointerUp"
      @pointercancel="onBarPointerUp"
      @dblclick="onBarDblClick"
    >
      <!-- 胶囊态隐藏「直播/回放」徽章，给标题让出空间 -->
      <span v-if="!collapsed" class="fp-kind" :class="{ 'is-playback': kind === 'playback' }">
        {{ kind === 'live' ? '直播' : '回放' }}
      </span>
      <img v-if="avatarUrl" :src="avatarUrl" alt="avatar" class="fp-avatar">
      <span class="fp-title ellipsis" :title="barTitle">
        {{ barTitle }}
      </span>
      <div class="fp-actions">
        <el-button
          v-if="collapsed" circle size="small"
          title="还原窗口" @click.stop="toggleCollapse"
        >
          <MediaIcon name="windowMaximize" :size="15" class="fp-icon" />
        </el-button>
        <template v-else>
          <!-- 折叠为胶囊：用 minus 表达「收起」，避免误读为最小化到任务栏 -->
          <el-button circle size="small" title="折叠为迷你条" @click.stop="toggleCollapse">
            <MediaIcon name="minus" :size="15" class="fp-icon" />
          </el-button>
          <!-- 换档：与 AppTitleBar 最大化/还原同族窗口控件语言（单框放大 / 双叠框还原） -->
          <el-button
            circle size="small"
            :title="expanded ? '缩小还原' : '放大窗口'" @click.stop="toggleExpand"
          >
            <MediaIcon :name="expanded ? 'windowRestore' : 'windowMaximize'" :size="15" class="fp-icon" />
          </el-button>
        </template>
        <el-button circle size="small" title="关闭" class="fp-icon--close" @click.stop="onClose">
          <MediaIcon name="close" :size="15" class="fp-icon" />
        </el-button>
      </div>
    </div>

    <div v-show="!collapsed" class="fp-body">
      <LivePlayer
        v-if="kind === 'live'"
        :live-title="item.payload.title"
        :live-id="item.payload.liveId"
        :start-time="item.payload.startTime"
        :live-type="item.payload.liveType ?? 1"
        :live-mode="item.payload.liveMode ?? 0"
        :source="item.payload.source || 'user'"
        :avatar-url="item.payload.avatar || ''"
        :compact="!expanded"
        @avatar="onAvatar"
        @aspect="onAspect"
        @pip="onPip"
        @close="onClose"
      />
      <PlaybackPlayer
        v-else
        :live-title="item.payload.title"
        :live-id="item.payload.liveId"
        :start-time="item.payload.startTime"
        :source="item.payload.source || 'user'"
        :avatar-url="item.payload.avatar || ''"
        :compact="!expanded"
        @avatar="onAvatar"
        @aspect="onAspect"
        @sidebar="onSidebar"
        @pip="onPip"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.fp-window {
  position: fixed;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
  transition:
    width 0.2s ease,
    height 0.2s ease;
}

/* 高度与 utils/float-player-layout.ts 的 FP_BAR_HEIGHT 保持一致 */
.fp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 12px;
  flex-shrink: 0;
  cursor: move;
  user-select: none;
  touch-action: none;
  -webkit-app-region: no-drag;
  border-bottom: 1px solid color-mix(in srgb, var(--el-border-color) 35%, transparent);

  :deep(.el-button) {
    margin-left: 0;
  }
}

.fp-window.is-collapsed .fp-bar {
  border-bottom: none;
}

.fp-kind {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-light));

  &.is-playback {
    background: linear-gradient(135deg, var(--brand-secondary), #ffb0c8);
  }
}

.fp-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  border: 1px solid color-mix(in srgb, var(--el-border-color) 40%, transparent);
}

.fp-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.fp-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.fp-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.fp-icon {
  stroke-width: 1;
}

.fp-icon--close:hover {
  background: linear-gradient(135deg, #e5484d, #e03d52);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 2px 8px -2px rgba(224, 61, 82, 0.5);
}
</style>
