import type { ComputedRef, Ref } from 'vue'
import { computed, onScopeDispose, ref, watch } from 'vue'

export interface PlayerControlsVisibilityOptions {
  /** 当前是否处于容器全屏：全屏且控件隐去时同步隐藏鼠标指针 */
  isFullscreen: Ref<boolean> | ComputedRef<boolean>
  /**
   * 必须保持控件常驻的条件（如暂停中、输入条展开、「全部弹幕」面板展开等）。
   * 返回 true 时立即显现并取消倒计时；变为 false 时重新开始空闲倒计时。
   */
  keepVisible: () => boolean
  /** 指针静止多久后自动淡出（默认 2800ms） */
  idleMs?: number
  /** 指针离开播放器区域多久后淡出（默认 400ms，避免划过边缘时闪烁） */
  leaveMs?: number
}

/**
 * 播放器浮层控件（底部迷你条 / 右上角操作钮）的无操作自动隐藏状态机。
 * 鼠标移动或交互时立即显现，静止超过 idleMs 后平滑淡出；悬停在控件上或
 * keepVisible 为 true 时锁住不淡出。
 */
export function usePlayerControlsVisibility(options: PlayerControlsVisibilityOptions) {
  const idleMs = options.idleMs ?? 2800
  const leaveMs = options.leaveMs ?? 400

  const controlsVisible = ref(true)
  const hoveringControls = ref(false)
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const lockedVisible = computed(() => hoveringControls.value || options.keepVisible())
  const cursorHidden = computed(() => !controlsVisible.value && options.isFullscreen.value)

  function clearTimer() {
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function scheduleHide(delay = idleMs) {
    clearTimer()
    if (lockedVisible.value) {
      controlsVisible.value = true
      return
    }
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!lockedVisible.value)
        controlsVisible.value = false
    }, delay)
  }

  /** 用户移动鼠标或操作播放器时唤醒控件并重置空闲倒计时 */
  function reveal() {
    controlsVisible.value = true
    scheduleHide(idleMs)
  }

  function onControlEnter() {
    hoveringControls.value = true
    controlsVisible.value = true
    clearTimer()
  }

  function onControlLeave() {
    hoveringControls.value = false
    scheduleHide(idleMs)
  }

  /** 指针离开播放窗区域：非全屏且未锁定时缩短淡出延迟 */
  function onContainerLeave() {
    hoveringControls.value = false
    if (options.isFullscreen.value || lockedVisible.value)
      return
    scheduleHide(leaveMs)
  }

  watch(lockedVisible, (locked) => {
    if (locked) {
      clearTimer()
      controlsVisible.value = true
    }
    else {
      scheduleHide(idleMs)
    }
  }, { immediate: true })

  // 进出全屏时唤醒一次，避免切进全屏瞬间看不见退出入口
  watch(options.isFullscreen, () => {
    reveal()
  })

  function dispose() {
    clearTimer()
  }

  onScopeDispose(dispose)

  return {
    controlsVisible,
    hoveringControls,
    cursorHidden,
    reveal,
    onControlEnter,
    onControlLeave,
    onContainerLeave,
    dispose,
  }
}
