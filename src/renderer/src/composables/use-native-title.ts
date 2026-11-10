import { isPointerStill, TITLE_TIP_DELAY, titleTipPosition } from '@renderer/utils/native-title'
import { useEventListener } from '@vueuse/core'
import { onScopeDispose } from 'vue'

/**
 * 原生 title 的替身：Electron 无边框窗口下浏览器 tooltip 常不弹，
 * 这里在鼠标静止 1 秒后显示一个纯文本小浮层，行为与观感贴近原生。
 * 全应用只挂一次，模板里的 title 都无需改动；接管期间摘掉 title，避免双提示。
 */
export function useNativeTitle() {
  // HMR 会重跑 setup，先清掉上一轮的浮层
  document.querySelector('.native-title-tip')?.remove()

  const tip = document.createElement('div')
  tip.className = 'native-title-tip'
  tip.setAttribute('aria-hidden', 'true')
  document.body.appendChild(tip)

  let host: HTMLElement | null = null
  let text = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let anchor = { x: 0, y: 0 }
  let visible = false

  // Vue 的动态 :title 会把属性写回来，摘掉它并同步刷新文案
  const observer = new MutationObserver(() => {
    if (!host)
      return
    const value = host.getAttribute('title')
    if (value === null)
      return
    text = value
    host.removeAttribute('title')
    host.dataset.nativeTitle = text
    if (visible) {
      tip.textContent = text
      place()
    }
  })

  function stopTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function place() {
    const point = titleTipPosition(
      anchor,
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    )
    tip.style.left = `${point.left}px`
    tip.style.top = `${point.top}px`
  }

  function hide() {
    stopTimer()
    visible = false
    tip.classList.remove('is-visible')
  }

  function detach() {
    observer.disconnect()
    if (host) {
      host.setAttribute('title', text)
      delete host.dataset.nativeTitle
    }
    host = null
    text = ''
  }

  function show() {
    if (!host || !text || !host.isConnected)
      return
    tip.textContent = text
    place()
    tip.classList.add('is-visible')
    visible = true
  }

  function schedule(event: PointerEvent) {
    anchor = { x: event.clientX, y: event.clientY }
    hide()
    if (!host || !text)
      return
    timer = setTimeout(show, TITLE_TIP_DELAY)
  }

  /** 就近取带 title 的元素；接管期间 title 暂存于 data-native-title */
  function resolveHost(event: PointerEvent): HTMLElement | null {
    const target: EventTarget | null = event.target
    if (!(target instanceof Element))
      return null
    const el = target.closest<HTMLElement>('[title], [data-native-title]')
    if (!el)
      return null
    return (el.getAttribute('title') ?? el.dataset.nativeTitle ?? '').trim() ? el : null
  }

  useEventListener(document, 'pointerover', (event) => {
    const next = resolveHost(event)
    if (next === host)
      return
    hide()
    detach()
    host = next
    if (!host)
      return
    text = host.getAttribute('title') ?? host.dataset.nativeTitle ?? ''
    host.dataset.nativeTitle = text
    host.removeAttribute('title')
    observer.observe(host, { attributes: true, attributeFilter: ['title'] })
    schedule(event)
  })

  useEventListener(document, 'pointermove', (event) => {
    const point = { x: event.clientX, y: event.clientY }
    if (isPointerStill(anchor, point))
      return
    if (host)
      schedule(event)
    else anchor = point
  })

  useEventListener(document, 'pointerout', (event) => {
    if (event.relatedTarget === null) {
      hide()
      detach()
    }
  })

  useEventListener(document, 'pointerdown', hide)
  useEventListener(document, 'wheel', hide, { passive: true })
  useEventListener(document, 'keydown', hide)
  useEventListener(document, 'scroll', hide, { capture: true })
  useEventListener(window, 'blur', () => {
    hide()
    detach()
  })

  onScopeDispose(() => {
    hide()
    detach()
    tip.remove()
  })
}
