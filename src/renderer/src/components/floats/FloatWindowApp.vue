<script setup lang="ts">
import type { FloatTopmost } from '@common/app-config'
import type { FloatPlayerKind, FloatPlayerPayload } from '@preload/ipc-contract'
import { FLOAT_BAR_HEIGHT, isFloatTopmostPinned, nextFloatTopmost } from '@common/float-window'
import LivePlayer from '@renderer/components/player/LivePlayer.vue'
import PlaybackPlayer from '@renderer/components/player/PlaybackPlayer.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import EventBus from '@renderer/services/event-bus'
import { flushPlayDuration, openPlayDuration } from '@renderer/utils/play-duration'
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'

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
openPlayDuration(kind)

// undefined=载荷加载中；null=主进程已查不到，窗口信息失效
const payload = ref<FloatPlayerPayload | null | undefined>(undefined)
const avatarUrl = ref('')
const viewportWidth = ref(window.innerWidth)

// 最大化状态由主进程持有：挂载时查一次初值，之后靠 windowOnMaximizeChange 推回来
const isMaximized = ref(false)
let disposeMaximizeChange: (() => void) | undefined
// 本窗置顶策略同样由主进程持有（图钉只改这一扇窗，不落盘）
const topmost = ref<FloatTopmost>('playing')
let disposeTopmostChange: (() => void) | undefined
// null = 播放器还没上报；图钉亮灭要以「此刻是否真的置顶」为准，缺了它「仅播放时」算不出来
const playing = ref<boolean | null>(null)

/** 图钉点亮 = 窗口当前实际在最前（含「仅播放时」策略下的播放中） */
const pinned = computed(() => isFloatTopmostPinned(topmost.value, playing.value))

onMounted(() => {
  EventBus.on('live-unavailable', onLiveUnavailable)
  void window.mainAPI.floatPlayerGetPayload(kind, liveId).then((value) => {
    payload.value = value
  })
  void window.mainAPI.windowIsMaximized().then((value) => {
    isMaximized.value = value
  })
  // 先订阅再取初值：取的过程中被改动也不会停在旧值上
  disposeTopmostChange = window.mainAPI.windowOnTopmostChange((preference) => {
    topmost.value = preference
  })
  void window.mainAPI.floatWindowGetTopmost().then((preference) => {
    if (preference)
      topmost.value = preference
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

// macOS 程序坞右键菜单 / 调度中心窗口标题
watchEffect(() => {
  const title = barTitle.value
  if (title)
    document.title = `${kind === 'live' ? '直播' : '回放'} · ${title}`
})

// 窄窗标记，仅供播放器内部使用（弹幕延迟控件 / 弹幕列表在窄窗下换排布）；
// 标题栏不消费它 —— 标题栏窄窗由 flex 自然压缩处理。
const compact = computed(() => viewportWidth.value < 420)

/** 窗口控制通道按 event.sender 定位，作用于本窗而非主窗口 */
function onClose() {
  // 先上报观看时长再关窗：窗口销毁后渲染端不再有机会发事件
  flushPlayDuration()
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

/** 播放状态变化 → 主进程据此决定置顶：播放中置顶，暂停 / 结束取消；本地留一份决定图钉亮灭 */
function onPlaying(value: boolean) {
  playing.value = value
  void window.mainAPI.floatWindowSetPlaying(value)
}

/** 图钉是本窗二态：点亮时取消置顶，未点亮时改为始终置顶；新策略由主进程回推，不做本地乐观更新 */
function onToggleTopmost() {
  const next = nextFloatTopmost(topmost.value, playing.value)
  void window.mainAPI.floatWindowSetTopmost(next).then(() => {
    // 浮窗常被别的窗口压住一角，只改图标容易被忽略，成功后再压一条提示
    showHint(next === 'always' ? '本窗已置顶 · 始终在最前' : '本窗已取消置顶 · 播放时也不置顶')
  })
}

/** 点亮时说明「已置顶」并区分是策略继承还是本窗钉住；未点亮时说清下一击会变成什么 */
const topmostTitle = computed(() => {
  if (pinned.value) {
    return topmost.value === 'always'
      ? '本窗已置顶 · 点击取消置顶'
      : '本窗播放中置顶（设置页策略）· 点击取消置顶'
  }
  return topmost.value === 'never'
    ? '本窗不置顶 · 点击始终置顶'
    : '本窗已暂停，暂不置顶（设置页策略）· 点击始终置顶'
})

/** 切换提示：浮窗尺寸小，用画面顶部的一条胶囊，1.8s 后自动消失 */
const hint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | undefined

function showHint(text: string) {
  hint.value = text
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    hint.value = ''
  }, 1800)
}

/** 播放窗与主窗口不共享 EventBus：上报主进程转发给主窗口，列表页才能刷新 */
function onLiveUnavailable(id: string) {
  void window.mainAPI.notifyLiveUnavailable(id)
}

useEventListener(window, 'resize', () => {
  viewportWidth.value = window.innerWidth
})

useEventListener(window, 'pagehide', () => {
  flushPlayDuration()
})

onUnmounted(() => {
  EventBus.off('live-unavailable', onLiveUnavailable)
  disposeMaximizeChange?.()
  disposeTopmostChange?.()
  clearTimeout(hintTimer)
})

// 全屏时标题栏虽不可见，其原生拖拽区仍可能吞点击（与 AppTitleBar 同款问题）：全屏期间停用 drag
const htmlFullscreen = ref(false)
useEventListener(document, 'fullscreenchange', () => {
  htmlFullscreen.value = !!document.fullscreenElement
})
</script>

<template>
  <!-- 不挂 frosted-surface：全窗口 backdrop-filter 被不透明标题栏与视频区完全遮盖，
       视觉零贡献，却每帧对整窗做 26px 模糊，DWM 合成退化时是双倍成本 -->
  <div class="fw-root">
    <!-- 皮肤类 app-title-bar 提供底色 / 边框 / 拖拽 / 按钮外观（与主窗同源），
         fw-bar 只补本窗特有的内容排布 -->
    <div
      class="fw-bar app-title-bar"
      :class="{ 'is-html-fullscreen': htmlFullscreen }"
      :style="{ height: `${FLOAT_BAR_HEIGHT}px` }"
      @dblclick="onToggleMaximize"
    >
      <!-- 置顶图钉：本窗二态，点亮 = 当前实际在最前（含「仅播放时」策略下的播放中）。
           放最左侧而不是窗口按钮组里 —— 那里是「最小化 / 关闭」的肌肉记忆区，误触代价完全不同 -->
      <button
        class="fw-pin"
        :class="{ 'is-on': pinned }"
        :title="topmostTitle"
        @click.stop="onToggleTopmost"
        @dblclick.stop
      >
        <MediaIcon name="pushpinFilled" :size="15" />
      </button>
      <span class="fw-kind" :class="{ 'is-playback': kind === 'playback' }">
        {{ kind === 'live' ? '直播' : '回放' }}
      </span>
      <img v-if="avatarUrl" :src="avatarUrl" alt="avatar" class="fw-avatar" draggable="false">
      <span class="fw-title ellipsis" :title="barTitle">{{ barTitle }}</span>
      <!-- 双击标题栏同效；按钮区拦住冒泡，免得双击按钮时顺带切换最大化 -->
      <div class="app-title-bar-actions" @dblclick.stop>
        <button class="app-title-bar-btn" title="最小化" @click.stop="onMinimize">
          <MediaIcon name="minus" :size="15" />
        </button>
        <button class="app-title-bar-btn" :title="isMaximized ? '还原' : '最大化'" @click.stop="onToggleMaximize">
          <MediaIcon :name="isMaximized ? 'windowRestore' : 'windowMaximize'" :size="15" />
        </button>
        <button class="app-title-bar-btn app-title-bar-btn--close" title="关闭" @click.stop="onClose">
          <MediaIcon name="close" :size="15" />
        </button>
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
        :bilibili-room-id="payload.bilibiliRoomId ?? 0"
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

      <!-- 图钉切换的即时反馈：不挡住播放器控制（pointer-events: none），1.8s 后自消 -->
      <Transition name="fw-toast">
        <div v-if="hint" class="fw-toast" role="status">
          <MediaIcon name="pushpinFilled" />
          <span>{{ hint }}</span>
        </div>
      </Transition>
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

/* 皮肤全在共享配方 .app-title-bar，此处只留本窗的内容排布与自持的 padding。
   高度由 FLOAT_BAR_HEIGHT 经 :style 注入，主进程算窗口尺寸用同一个值。 */
.fw-bar {
  gap: 8px;
  /* 图钉贴左，故比主窗口更窄的内边距 */
  padding: 0 0 0 6px;
}

.fw-bar.is-html-fullscreen {
  -webkit-app-region: no-drag;
}

/* 置顶图钉：本窗二态（钉住 / 未钉住），hover 给品牌色、按下缩一圈，
   与右侧窗口按钮的整块底色反馈区分开 */
.fw-pin {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;
  /* 标题栏整条是拖拽区，按钮必须让出 */
  -webkit-app-region: no-drag;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    transform 0.12s ease;

  &:hover {
    color: var(--brand-primary);
    background: rgba(var(--brand-rgb), 0.1);
  }

  &:active {
    transform: scale(0.9);
  }
}

/* 钉住：品牌色 + 实心圆底 */
.fw-pin.is-on {
  color: var(--brand-primary);
  background: rgba(var(--brand-rgb), 0.16);

  &:hover {
    background: rgba(var(--brand-rgb), 0.22);
  }
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
  /* 浅色标题栏底：边框收浅，避免深色描边显脏 */
  border: 1px solid var(--el-border-color-lighter);
}

/* 标题占满剩余空间；min-width: 0 让窄窗时靠 ellipsis 截断而非撑破标题栏 */
.fw-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.fw-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

/* 切换提示：压在画面顶部居中，深底浅字保证在亮暗画面上都读得清；
   层级要盖过播放器控制条（20 / 29 / 35），但不吃指针事件 */
.fw-toast {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  padding: clamp(8px, calc(8px + 2 * var(--fp-step)), 10px) clamp(16px, calc(16px + 4 * var(--fp-step)), 20px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius-pill);
  font-size: var(--fp-font);
  line-height: 1.4;
  color: #fff;
  background: rgba(22, 18, 38, 0.82);
  box-shadow: 0 10px 26px -14px rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  pointer-events: none;
  transform: translateX(-50%);
}

.fw-toast-enter-active,
.fw-toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.fw-toast-enter-from,
.fw-toast-leave-to {
  opacity: 0;
  /* 保留水平居中，只做垂直位移 */
  transform: translate(-50%, -6px);
}

@media (prefers-reduced-motion: reduce) {
  .fw-toast-enter-active,
  .fw-toast-leave-active {
    transition: none;
  }
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
