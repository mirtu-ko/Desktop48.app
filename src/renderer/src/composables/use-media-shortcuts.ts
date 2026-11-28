/**
 * 媒体播放器键盘快捷键：按键→动作的映射与防误触规则（输入框过滤 / 原生控件交还 / 长按去抖）单源维护。
 *
 * 播放窗是独立 BrowserWindow，按键只到 OS 激活的那个窗口，故宿主一律挂 window 监听：
 * 不依赖焦点或 hover，全屏时浏览器把焦点限制在全屏元素内也不会失效。
 */

import { useEventListener } from '@vueuse/core'

export interface MediaShortcutActions {
  togglePlay: () => void
  toggleMute: () => void
  toggleFullscreen: () => void
  rotateLeft: () => void
  rotateRight: () => void
  resetRotation: () => void
  /** ←：快退（宿主可提供以顺带展示屏幕提示；未传时回退直接改 mediaElement.currentTime） */
  seekBackward: () => void
  /** →：快进 */
  seekForward: () => void
  /** ↑：音量 + 一步（步进与解除静音由宿主负责） */
  volumeUp: () => void
  /** ↓：音量 - 一步 */
  volumeDown: () => void
}

/**
 * 按键分派（纯逻辑）：识别并执行快捷键动作。
 * 返回 true 表示已消费（调用方应 preventDefault），false 表示不认识/不应处理。
 * 各宿主按需传 actions（partial）：不传对应动作的键不响应。
 * 音量走宿主动作而非直接写 mediaElement.volume —— 解除静音、同步滑块都只有宿主知道。
 */
export function dispatchMediaShortcut(
  event: KeyboardEvent,
  actions: Partial<MediaShortcutActions>,
  mediaElement: HTMLMediaElement | null,
): boolean {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
    return false

  // 只有带原生 controls 的媒体元素会自己处理空格 / 方向键；本项目播控全自绘，
  // 把按键交还给 BUTTON 或裸露 video/audio 等于直接丢弃。
  const nativeOwnsKey = event.key === ' ' || event.key.startsWith('Arrow')
  const nativeMediaOwnsKey = nativeOwnsKey && !!mediaElement?.controls && target === mediaElement
  // 按钮上的空格会触发原生激活，仍需让行，否则 togglePlay 与 click 双触发
  if (nativeMediaOwnsKey || (event.key === ' ' && target?.tagName === 'BUTTON'))
    return false

  switch (event.key) {
    // 空格/播放键与迷你条统一走宿主的 togglePlay
    case ' ':
      if (actions.togglePlay)
        actions.togglePlay()
      else
        return false
      break
    case 'ArrowLeft':
      if (actions.seekBackward) {
        actions.seekBackward()
      }
      else if (mediaElement) {
        mediaElement.currentTime = Math.max(0, mediaElement.currentTime - 5)
      }
      else {
        return false
      }
      break
    case 'ArrowRight':
      if (actions.seekForward) {
        actions.seekForward()
      }
      else if (mediaElement) {
        mediaElement.currentTime = mediaElement.currentTime + 5
      }
      else {
        return false
      }
      break
    case 'ArrowUp':
      if (!actions.volumeUp)
        return false
      actions.volumeUp()
      break
    case 'ArrowDown':
      if (!actions.volumeDown)
        return false
      actions.volumeDown()
      break
    case 'm':
    case 'M':
      if (event.repeat || !actions.toggleMute)
        return false
      actions.toggleMute()
      break
    case 'f':
    case 'F':
      if (event.repeat || !actions.toggleFullscreen)
        return false
      actions.toggleFullscreen()
      break
    case 'r':
    case 'R':
      // 长按 repeat 只响应第一次，避免连续转圈
      if (event.repeat)
        return false
      if (event.shiftKey)
        actions.rotateLeft?.()
      else
        actions.rotateRight?.()
      break
    case '0':
      if (event.repeat)
        return false
      actions.resetRotation?.()
      break
    default:
      return false
  }
  return true
}

/** 窗口级快捷键：OS 激活哪个播放窗，keydown 就只到哪个 window */
export function useMediaShortcuts(options: {
  /** 当前媒体元素：←/→ seek 直接操作它（音量走 actions） */
  getMedia: () => HTMLMediaElement | null
  actions: Partial<MediaShortcutActions>
  /** 额外的启用条件（如电台直播不接旋转键） */
  isEnabled?: () => boolean
}) {
  function onKeydown(event: KeyboardEvent) {
    // 组合键交给系统 / 浏览器（Cmd+R 刷新等），别和播放器快捷键打架
    if (event.ctrlKey || event.metaKey || event.altKey || (options.isEnabled && !options.isEnabled()))
      return
    const consumed = dispatchMediaShortcut(event, options.actions, options.getMedia())
    if (consumed)
      event.preventDefault()
  }

  useEventListener(window, 'keydown', onKeydown)
}
