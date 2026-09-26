<script setup lang="ts">
import type { FloatPlayerKind, FloatPlayerPayload } from '../../../../preload/ipc-contract'
import LivePlayer from '@renderer/components/player/LivePlayer.vue'
import PlaybackPlayer from '@renderer/components/player/PlaybackPlayer.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import EventBus from '@renderer/services/event-bus'
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { FLOAT_BAR_HEIGHT } from '../../../../common/float-window'

/**
 * 独立播放窗根组件（无边框 + 自定义标题栏）。
 * hash 只带 kind + liveId 短 key，全量载荷经 floatPlayerGetPayload 回取；
 * 移动 / 缩放分别交给系统拖拽区与边框，这里不含任何 Pointer 逻辑。
 */

/** 解析 `#/float?kind=live&liveId=xxx`；URLSearchParams 自动 percent-decode */
function parseHash(): { kind: FloatPlayerKind, liveId: string } {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  return {
    kind: params.get('kind') === 'playback' ? 'playback' : 'live',
    liveId: params.get('liveId') ?? '',
  }
}

const { kind, liveId } = parseHash()

// undefined=载荷加载中；null=主进程已查不到，窗口信息失效
const payload = ref<FloatPlayerPayload | null | undefined>(undefined)
const avatarUrl = ref('')
const viewportWidth = ref(window.innerWidth)

// 最大化状态由主进程持有：挂载时查一次初值，之后靠 windowOnMaximizeChange 推回来
const isMaximized = ref(false)
let disposeMaximizeChange: (() => void) | undefined

onMounted(() => {
  EventBus.on('live-unavailable', onLiveUnavailable)
  void window.mainAPI.floatPlayerGetPayload(kind, liveId).then((value) => {
    payload.value = value
  })
  void window.mainAPI.windowIsMaximized().then((value) => {
    isMaximized.value = value
  })
  // 订阅式通道返回退订函数，必须在 onUnmounted 调用，否则重挂载会累积监听器
  disposeMaximizeChange = window.mainAPI.windowOnMaximizeChange((value) => {
    isMaximized.value = value
  })
})

// 标题栏文案与旧浮窗一致：有主播名时展示「主播名: 标题」
const barTitle = computed(() => {
  const current = payload.value
  if (!current)
    return ''
  return current.nickname ? `${current.nickname}: ${current.title}` : current.title
})

// 窄窗切紧凑布局（替代旧三态里的「迷你态」），由窗口宽度驱动
const compact = computed(() => viewportWidth.value < 520)

/** 窗口控制通道按 event.sender 定位，作用于本窗而非主窗口 */
function onClose() {
  void window.mainAPI.windowClose()
}

function onMinimize() {
  void window.mainAPI.windowMinimize()
}

/** 切换由主进程执行，新状态经 windowOnMaximizeChange 推回来（不做本地乐观更新） */
function onToggleMaximize() {
  void window.mainAPI.windowToggleMaximize()
}

/** 子播放器上报视频宽高比 → 主进程按比例定形窗口（用户手动缩放过则不再打扰） */
function onAspect(aspect: number) {
  void window.mainAPI.floatWindowFitAspect(aspect)
}

function onAvatar(url: string) {
  if (url)
    avatarUrl.value = url
}

/** 播放状态变化 → 主进程据此决定置顶：播放中置顶，暂停 / 结束取消 */
function onPlaying(playing: boolean) {
  void window.mainAPI.floatWindowSetPlaying(playing)
}

/** 播放窗与主窗口不共享 EventBus：上报主进程转发给主窗口，列表页才能刷新 */
function onLiveUnavailable(id: string) {
  void window.mainAPI.notifyLiveUnavailable(id)
}

useEventListener(window, 'resize', () => {
  viewportWidth.value = window.innerWidth
})

onUnmounted(() => {
  EventBus.off('live-unavailable', onLiveUnavailable)
  disposeMaximizeChange?.()
})

// 全屏时标题栏虽不可见，其原生拖拽区仍可能吞点击（与 AppTitleBar 同款问题）：全屏期间停用 drag
const htmlFullscreen = ref(false)
useEventListener(document, 'fullscreenchange', () => {
  htmlFullscreen.value = !!document.fullscreenElement
})
</script>

<template>
  <div class="fw-root frosted-surface frosted-surface--deep">
    <div
      class="fw-bar"
      :class="{ 'is-html-fullscreen': htmlFullscreen }"
      :style="{ height: `${FLOAT_BAR_HEIGHT}px` }"
      @dblclick="onToggleMaximize"
    >
      <span class="fw-kind" :class="{ 'is-playback': kind === 'playback' }">
        {{ kind === 'live' ? '直播' : '回放' }}
      </span>
      <img v-if="avatarUrl" :src="avatarUrl" alt="avatar" class="fw-avatar" draggable="false">
      <span class="fw-title ellipsis" :title="barTitle">{{ barTitle }}</span>
      <!-- 双击标题栏同效；按钮区拦住冒泡，免得双击按钮时顺带切换最大化 -->
      <div class="fw-actions" @dblclick.stop>
        <el-button circle size="small" title="最小化" @click.stop="onMinimize">
          <MediaIcon name="minus" :size="15" class="fw-icon" />
        </el-button>
        <el-button circle size="small" :title="isMaximized ? '还原' : '最大化'" @click.stop="onToggleMaximize">
          <MediaIcon :name="isMaximized ? 'windowRestore' : 'windowMaximize'" :size="15" class="fw-icon" />
        </el-button>
        <el-button circle size="small" title="关闭" class="fw-icon--close" @click.stop="onClose">
          <MediaIcon name="close" :size="15" class="fw-icon" />
        </el-button>
      </div>
    </div>

    <div class="fw-body">
      <LivePlayer
        v-if="payload && kind === 'live'"
        :live-title="payload.title"
        :live-id="payload.liveId"
        :start-time="payload.startTime"
        :live-type="payload.liveType ?? 1"
        :live-mode="payload.liveMode ?? 0"
        :source="payload.source || 'user'"
        :avatar-url="payload.avatar || ''"
        :compact="compact"
        @avatar="onAvatar"
        @aspect="onAspect"
        @playing="onPlaying"
        @close="onClose"
      />
      <!-- PlaybackPlayer 无 close emit（回放不依赖「直播下架」关闭路径），故不绑 @close：
           将来若给它加 close，记得同步补上绑定 -->
      <PlaybackPlayer
        v-else-if="payload"
        :live-title="payload.title"
        :live-id="payload.liveId"
        :start-time="payload.startTime"
        :source="payload.source || 'user'"
        :avatar-url="payload.avatar || ''"
        :compact="compact"
        @avatar="onAvatar"
        @aspect="onAspect"
        @playing="onPlaying"
      />
      <div v-else-if="payload === null" class="fw-hint">
        播放信息已失效，请关闭后重新打开
      </div>
      <div v-else class="fw-hint">
        正在打开播放窗口…
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.fw-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* 高度来自共享常量 FLOAT_BAR_HEIGHT，主进程算窗口尺寸用同一个值 */
.fw-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  flex-shrink: 0;
  user-select: none;
  /* 整条标题栏即窗口拖动区：由系统接管，因此可以拖到应用窗口之外 */
  -webkit-app-region: drag;
  border-bottom: 1px solid color-mix(in srgb, var(--el-border-color) 35%, transparent);

  :deep(.el-button) {
    margin-left: 0;
  }
}

/* 全屏时拖拽区不可见却仍吞点击：停用 drag */
.fw-bar.is-html-fullscreen {
  -webkit-app-region: no-drag;
}

.fw-kind {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
  background: var(--gradient-brand);

  &.is-playback {
    background: linear-gradient(135deg, var(--brand-secondary), #ffb0c8);
  }
}

.fw-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  border: 1px solid color-mix(in srgb, var(--el-border-color) 40%, transparent);
}

.fw-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

/* 按钮区不参与拖拽，保持可点击 */
.fw-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.fw-icon {
  stroke-width: 1;
}

.fw-icon--close:hover {
  background: linear-gradient(135deg, #e5484d, #e03d52);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 2px 8px -2px rgba(224, 61, 82, 0.5);
}

.fw-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

.fw-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
}
</style>
