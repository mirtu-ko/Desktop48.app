/**
 * 媒体快捷键分派（composables/use-media-shortcuts.ts）：测试环境是 node，
 * 媒体元素与键盘事件都用桩；断言重点是「按键是否被消费」与「是否真的改了播放状态」。
 */
import { describe, expect, it, vi } from 'vitest'
import { dispatchMediaShortcut } from '../src/renderer/src/composables/use-media-shortcuts'

interface MediaStub {
  currentTime: number
  volume: number
  controls: boolean
}

function makeMedia(overrides: Partial<MediaStub> = {}): HTMLMediaElement {
  return {
    currentTime: 30,
    volume: 0.5,
    controls: false,
    ...overrides,
  } as unknown as HTMLMediaElement
}

function makeEvent(key: string, target: unknown = null, init: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key,
    target,
    repeat: false,
    shiftKey: false,
    ...init,
  } as unknown as KeyboardEvent
}

function makeActions() {
  return {
    togglePlay: vi.fn(),
    toggleFullscreen: vi.fn(),
    rotateLeft: vi.fn(),
    rotateRight: vi.fn(),
    resetRotation: vi.fn(),
  }
}

const button = { tagName: 'BUTTON' }
const plain = { tagName: 'DIV' }

describe('dispatchMediaShortcut / 方向键 seek', () => {
  it('焦点落在全屏按钮上时方向键仍消费并前进 5 秒', () => {
    const media = makeMedia()
    expect(dispatchMediaShortcut(makeEvent('ArrowRight', button), makeActions(), media)).toBe(true)
    expect(media.currentTime).toBe(35)
  })

  it('焦点落在全屏按钮上时左键后退 5 秒，且不会越过 0', () => {
    const media = makeMedia({ currentTime: 3 })
    expect(dispatchMediaShortcut(makeEvent('ArrowLeft', button), makeActions(), media)).toBe(true)
    expect(media.currentTime).toBe(0)
  })

  it('反向：焦点在输入框 / 可编辑区时不消费，进度保持不动', () => {
    const media = makeMedia()
    expect(dispatchMediaShortcut(makeEvent('ArrowRight', { tagName: 'INPUT' }), makeActions(), media)).toBe(false)
    expect(dispatchMediaShortcut(makeEvent('ArrowRight', { isContentEditable: true }), makeActions(), media)).toBe(false)
    expect(media.currentTime).toBe(30)
  })

  it('反向：没有媒体元素时不消费（直播浮窗不接 seek）', () => {
    expect(dispatchMediaShortcut(makeEvent('ArrowRight'), makeActions(), null)).toBe(false)
    expect(dispatchMediaShortcut(makeEvent('ArrowUp'), makeActions(), null)).toBe(false)
  })

  it('音量键按 0.1 阶梯调整并夹在 0~1', () => {
    const media = makeMedia({ volume: 0.95 })
    expect(dispatchMediaShortcut(makeEvent('ArrowUp', button), makeActions(), media)).toBe(true)
    expect(media.volume).toBe(1)
    expect(dispatchMediaShortcut(makeEvent('ArrowDown', button), makeActions(), media)).toBe(true)
    expect(media.volume).toBe(0.9)
  })
})

describe('dispatchMediaShortcut / 原生控件让行', () => {
  it('空格在按钮上让行以免按钮被二次激活，普通区域则切换播放', () => {
    const actions = makeActions()
    expect(dispatchMediaShortcut(makeEvent(' ', button), actions, makeMedia())).toBe(false)
    expect(actions.togglePlay).not.toHaveBeenCalled()
    expect(dispatchMediaShortcut(makeEvent(' ', plain), actions, makeMedia())).toBe(true)
    expect(actions.togglePlay).toHaveBeenCalledTimes(1)
  })

  it('没有原生 controls 的媒体元素不吞方向键', () => {
    const media = makeMedia()
    expect(dispatchMediaShortcut(makeEvent('ArrowRight', media), makeActions(), media)).toBe(true)
    expect(media.currentTime).toBe(35)
  })

  it('反向：带原生 controls 的媒体元素交还给原生，进度不动', () => {
    const media = makeMedia({ controls: true })
    expect(dispatchMediaShortcut(makeEvent('ArrowRight', media), makeActions(), media)).toBe(false)
    expect(media.currentTime).toBe(30)
  })

  it('反向：直播只传旋转动作时空格 / 全屏键不消费', () => {
    const liveActions = { rotateLeft: vi.fn(), rotateRight: vi.fn(), resetRotation: vi.fn() }
    expect(dispatchMediaShortcut(makeEvent(' '), liveActions, null)).toBe(false)
    expect(dispatchMediaShortcut(makeEvent('f'), liveActions, null)).toBe(false)
  })
})

describe('dispatchMediaShortcut / 全屏与旋转', () => {
  it('f 切换全屏；r / Shift+R / 0 分派到对应旋转动作', () => {
    const actions = makeActions()
    expect(dispatchMediaShortcut(makeEvent('f'), actions, null)).toBe(true)
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1)
    expect(dispatchMediaShortcut(makeEvent('r'), actions, null)).toBe(true)
    expect(actions.rotateRight).toHaveBeenCalledTimes(1)
    expect(dispatchMediaShortcut(makeEvent('R', null, { shiftKey: true }), actions, null)).toBe(true)
    expect(actions.rotateLeft).toHaveBeenCalledTimes(1)
    expect(dispatchMediaShortcut(makeEvent('0'), actions, null)).toBe(true)
    expect(actions.resetRotation).toHaveBeenCalledTimes(1)
  })

  it('反向：长按 repeat 不重复旋转，未知键不消费', () => {
    const actions = makeActions()
    expect(dispatchMediaShortcut(makeEvent('r', null, { repeat: true }), actions, null)).toBe(false)
    expect(dispatchMediaShortcut(makeEvent('0', null, { repeat: true }), actions, null)).toBe(false)
    expect(dispatchMediaShortcut(makeEvent('x'), actions, null)).toBe(false)
    expect(actions.rotateRight).not.toHaveBeenCalled()
    expect(actions.resetRotation).not.toHaveBeenCalled()
  })
})
