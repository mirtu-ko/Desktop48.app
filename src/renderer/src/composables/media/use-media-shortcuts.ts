/**
 * 媒体播放器键盘快捷键：
 * 按键→动作的映射与防误触规则（输入框过滤 / 原生控件交还 / 长按去抖）在此单源维护。
 *
 * 两种触发策略，由宿主按场景选择：
 * - 焦点制（PlaybackPlayer）：绑定在根节点，持有焦点才响应——回放页多实例并存时互不干扰
 * - 悬浮制（LivePlayer）：hover 检测 + window 监听——直播浮窗无焦点概念，
 *   同屏多个浮窗只有鼠标所在那个响应
 * 两边共用同一份按键分派（dispatchMediaShortcut），改键位只需改这里。
 */
export interface MediaShortcutActions {
  togglePlay: () => void
  toggleFullscreen: () => void
  /** 无弹幕能力的宿主可不传，D 键自动不响应 */
  toggleDanmaku?: () => void
  rotateLeft: () => void
  rotateRight: () => void
  resetRotation: () => void
}

/**
 * 按键分派（纯逻辑）：识别并执行快捷键动作。
 * 返回 true 表示已消费（调用方应 preventDefault），false 表示不认识/不应处理。
 * 直播场景仅需要旋转族快捷键（seek/音量对直播流无意义），通过 actions 传 partial 即可。
 */
export function dispatchMediaShortcut(
  event: KeyboardEvent,
  actions: Partial<MediaShortcutActions>,
  mediaElement: HTMLMediaElement | null,
): boolean {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
    return false

  // 空格与方向键原生 controls 自身就会响应，焦点落在媒体元素或按钮上时必须交还给原生：
  // 否则会出现 keydown 由本组件暂停、keyup 又被按钮的默认激活行为恢复播放的重复触发。
  const nativeOwnsKey = event.key === ' ' || event.key.startsWith('Arrow')
  const focusInNativeControl = target
    && (target.tagName === 'VIDEO' || target.tagName === 'AUDIO' || target.tagName === 'BUTTON')
  if (nativeOwnsKey && focusInNativeControl)
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
      if (mediaElement)
        mediaElement.currentTime = Math.max(0, mediaElement.currentTime - 5)
      else
        return false
      break
    case 'ArrowRight':
      if (mediaElement)
        mediaElement.currentTime = mediaElement.currentTime + 5
      else
        return false
      break
    case 'ArrowUp':
      if (mediaElement)
        mediaElement.volume = Math.min(1, mediaElement.volume + 0.1)
      else
        return false
      break
    case 'ArrowDown':
      if (mediaElement)
        mediaElement.volume = Math.max(0, mediaElement.volume - 0.1)
      else
        return false
      break
    case 'd':
    case 'D':
      if (actions.toggleDanmaku)
        actions.toggleDanmaku()
      else
        return false
      break
    case 'f':
    case 'F':
      if (actions.toggleFullscreen)
        actions.toggleFullscreen()
      else
        return false
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

export function useMediaShortcuts(options: {
  /** 焦点容器：快捷键只在它持有焦点时生效 */
  getRoot: () => HTMLElement | null
  /** 当前媒体元素：方向键 seek / 调音量直接操作它 */
  getMedia: () => HTMLMediaElement | null
  actions: MediaShortcutActions
}) {
  /** 点击播放器即把焦点收回根节点，让快捷键随即生效（点在按钮/输入上时保留其原生焦点） */
  function onPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, button, [contenteditable="true"]'))
      return
    options.getRoot()?.focus({ preventScroll: true })
  }

  function onKeydown(event: KeyboardEvent) {
    const consumed = dispatchMediaShortcut(event, options.actions, options.getMedia())
    if (consumed)
      event.preventDefault()
  }

  return { onKeydown, onPointerDown }
}
